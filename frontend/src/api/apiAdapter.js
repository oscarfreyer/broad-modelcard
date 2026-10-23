// API data adapter (Phase C): implements every data-client method
// against the FastAPI backend under /api/v1 (backend/openapi.json, semantics in
// backend/CONTRACT.md). This is the only frontend module that calls fetch.
//
// - Reads take ReadOptions: `version` ('live' or 'staged:<upload_id>', default
//   from the adapter) and an AbortSignal.
// - Live responses carry a strong ETag with `Cache-Control: no-cache`. Requests
//   use the browser's default cache mode, so the browser revalidates with
//   If-None-Match and a 304 reuses the cached body; the query cache
//   (queryCache.js) answers revisits without a request at all.
// - Errors are problem+json and become DataClientError with status and code. A
//   backend that cannot be reached becomes code `backend_unavailable`.
// - Reads that depend on prevalence take an optional `population` param, a
//   local population id from getMeta().populations (contract v1.10,
//   CONTRACT.md §21). Left out, the read uses the default population and its
//   URL is exactly what it was before; the response then has no `population`.
// - The atlas reads take an optional `ontology` param (contract v1.13,
//   CONTRACT.md §23): an id from getMeta().ontologies. ICD-11 (or none) sends
//   nothing, so those URLs are unchanged.
// - The lens reads take an optional `setting` param (contract v1.14,
//   CONTRACT.md §29), a specific care setting's axis value, sent as `context`.
//   Any setting sends nothing, so those URLs are unchanged.
import { withSnapshotBlocks } from './catalogueSnapshot.js';
import { DataClientError } from './dataClient.js';
import { otherOntology } from '../shared/ontology.js';
import { specificSetting } from '../shared/careSetting.js';


const API_BASE_URL = '/api/v1';

const START_HINT = 'Start the app with `npm run dev` (or `npm run preview`), which starts the backend too.';

function problem(status, code, title, detail) {
  return new DataClientError({ status, code, title, detail });
}

/** Query string from params, leaving out undefined, null, and empty values. */
export function queryString(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([name, value]) => {
    const text = Array.isArray(value) ? value.join(',') : value == null ? '' : String(value);
    if (text !== '') {
      search.append(name, text);
    }
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

const segment = (value) => encodeURIComponent(String(value ?? ''));

/** Shared metric query parameters (CONTRACT.md §3; population v1.10; ontology v1.13; setting v1.14): client names → API names. */
function metricQuery({ model, useCase, age, sex, ethnicity, setting, population, ontology }) {
  return { model, use_case: useCase, age, sex, ethnicity, context: atlasSetting(setting), population, ontology: atlasOntology(ontology) };
}

/** The `context` query value (contract v1.14, CONTRACT.md §29): a specific care setting, left out for Any setting. */
function atlasSetting(setting) {
  return specificSetting(setting) ?? undefined;
}

/**
 * The `ontology` query value (contract v1.13, CONTRACT.md §23): left out for
 * ICD-11, the default, so an ICD-11 read's URL is what it was before.
 */
function atlasOntology(ontology) {
  return otherOntology(ontology) ?? undefined;
}

function isJson(response) {
  return /\bjson\b/.test(response.headers.get('content-type') || '');
}

/** DataClientError from a failed response; problem+json when the backend sent it. */
async function errorFromResponse(response) {
  if (isJson(response)) {
    try {
      const body = await response.json();
      if (body && typeof body.code === 'string') {
        return problem(body.status ?? response.status, body.code, body.title || response.statusText, body.detail);
      }
    } catch {
      // Fall through to the generic error below.
    }
  }
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return problem(response.status, 'backend_unavailable', 'The Broad Modelcard backend is not running', START_HINT);
  }
  return problem(response.status, 'unexpected_response', `The server answered ${response.status} ${response.statusText}`.trim());
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl] API root, default /api/v1 (same origin, proxied by Vite)
 * @param {typeof fetch} [options.fetch] default: the global fetch, looked up per request
 * @param {'live'|`staged:${string}`} [options.defaultVersion] version for reads without one
 */
export function createApiAdapter({ baseUrl = API_BASE_URL, fetch: fetchImpl = (...args) => globalThis.fetch(...args), defaultVersion = 'live' } = {}) {
  const root = baseUrl.replace(/\/+$/, '');
  const url = (path, params = {}) => `${root}${path}${queryString(params)}`;
  const versionParam = (options) => {
    const version = options?.version ?? defaultVersion;
    return version && version !== 'live' ? version : undefined;
  };

  async function send(path, { params, method = 'GET', body, headers, signal, expect = 'json' } = {}) {
    let response;
    try {
      response = await fetchImpl(url(path, params), { method, body, headers, signal });
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) {
        throw error?.name === 'AbortError' ? error : new DOMException('The request was aborted.', 'AbortError');
      }
      throw problem(0, 'backend_unavailable', 'The Broad Modelcard backend is not reachable', START_HINT);
    }
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    if (expect === 'none' || response.status === 204) {
      return null;
    }
    if (expect === 'blob') {
      return response.blob();
    }
    if (!isJson(response)) {
      // e.g. a static file server answering /api with index.html.
      throw problem(response.status, 'backend_unavailable', 'The Broad Modelcard API did not answer', START_HINT);
    }
    return response.json();
  }

  const read = (path, params, options = {}) =>
    send(path, { params: { ...params, version: versionParam(options) }, signal: options.signal });

  // Concurrent identical reads share one request (audit B14): the atlas reads
  // /meta for the selection and for the version watch as it opens. Each caller
  // keeps its own abort; the request is aborted only when every caller has.
  const inFlight = new Map();
  function sharedRead(path, params, options = {}) {
    const key = url(path, { ...params, version: versionParam(options) });
    let entry = inFlight.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, callers: 0, promise: null };
      entry.promise = send(path, { params: { ...params, version: versionParam(options) }, signal: controller.signal }).finally(() => {
        if (inFlight.get(key) === entry) inFlight.delete(key);
      });
      inFlight.set(key, entry);
    }
    const shared = entry;
    shared.callers += 1;
    const signal = options.signal;
    if (!signal) return shared.promise;
    if (signal.aborted) {
      shared.callers -= 1;
      if (!shared.callers) shared.controller.abort();
      return Promise.reject(new DOMException('The request was aborted.', 'AbortError'));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        shared.callers -= 1;
        if (!shared.callers) {
          shared.controller.abort();
          if (inFlight.get(key) === shared) inFlight.delete(key);
        }
        reject(new DOMException('The request was aborted.', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }

  const adapter = {
    getMeta(_params = {}, options = {}) {
      return sharedRead('/meta', {}, options);
    },

    listModels(_params = {}, options = {}) {
      return read('/models', {}, options);
    },

    /**
     * Every configuration as one tile (contract v1.6, CONTRACT.md §17). Takes
     * no params, so `getCatalogue({ version, signal })` and
     * `getCatalogue({}, { version, signal })` both work. Each tile's compact
     * snapshot (v1.11) also comes as `snapshot.blocks` (see withSnapshotBlocks).
     */
    async getCatalogue(params = {}, options = {}) {
      const catalogue = await read('/catalogue', { population: params.population }, { version: params.version, signal: params.signal, ...options });
      return withSnapshotBlocks(catalogue);
    },

    getAtlasOverview({ population, ontology } = {}, options = {}) {
      return read('/atlas/overview', { population, ontology: atlasOntology(ontology) }, options);
    },

    getChapter({ chapterId, population, ontology } = {}, options = {}) {
      return read(`/atlas/chapters/${segment(chapterId)}`, { population, ontology: atlasOntology(ontology) }, options);
    },

    getMetricMap(params = {}, options = {}) {
      return read('/metrics/map', { ...metricQuery(params), scope: params.scope, chapter_id: params.chapterId }, options);
    },

    /** With weights set to prevalence (v1.14, CONTRACT.md §30) the summary adds weighted_distribution; without it the URL is unchanged. */
    getMetricSummary(params = {}, options = {}) {
      return read('/metrics/summary', { ...metricQuery(params), view: params.view, weights: params.weights }, options);
    },

    getConceptMetrics(params = {}, options = {}) {
      return read(`/metrics/concepts/${segment(params.conceptId)}`, metricQuery(params), options);
    },

    /** Across groups (v1.13, CONTRACT.md §24): every one-group lens in one read, so it takes no lens. */
    getConceptSubgroups({ model, useCase, conceptId, setting, population, ontology } = {}, options = {}) {
      return read(
        `/metrics/concepts/${segment(conceptId)}/subgroups`,
        { model, use_case: useCase, context: atlasSetting(setting), population, ontology: atlasOntology(ontology) },
        options
      );
    },

    /**
     * The group summary (v1.14, CONTRACT.md §24): per one-group lens, the card's depth-1 ICD-11
     * conditions with a result, without one, and flagged. Always ICD-11; `ontology` is validated only.
     */
    getSubgroupSummary({ model, useCase, setting, population, ontology } = {}, options = {}) {
      return read('/metrics/subgroups/summary', { model, use_case: useCase, context: atlasSetting(setting), population, ontology: atlasOntology(ontology) }, options);
    },

    /** The study records (v1.13, CONTRACT.md §22); `model` keeps those that evaluated one model version. */
    listStudies({ model } = {}, options = {}) {
      return read('/studies', { model }, options);
    },

    getStudy({ studyId } = {}, options = {}) {
      return read(`/studies/${segment(studyId)}`, {}, options);
    },

    /** The intervention effects (v1.13, CONTRACT.md §27), optionally of one AI system or one card. Never graded. */
    listEffects({ model, useCase } = {}, options = {}) {
      return read('/effects', { model, use_case: useCase }, options);
    },

    /** Every safety incident of the version, newest first; optionally of one AI system or one card (v1.14, CONTRACT.md §18, §30). */
    listSafetyIncidents({ model, useCase } = {}, options = {}) {
      return read('/incidents', { model, use_case: useCase }, options);
    },

    /**
     * 2 to 4 cards side by side (v1.13, CONTRACT.md §25). `cards` is an array of
     * card ids (`<model_version>|<use_case>`); the lens, population, and
     * ontology work as on getMetricMap (ICD-11 sends no ontology).
     */
    getComparison({ cards = [], scope = 'atlas', chapterId, age, sex, ethnicity, setting, population, ontology } = {}, options = {}) {
      return read(
        '/compare',
        {
          cards: Array.isArray(cards) ? cards.join(',') : cards,
          scope: scope === 'atlas' ? undefined : scope,
          chapter_id: scope === 'chapter' ? chapterId : undefined,
          age,
          sex,
          ethnicity,
          context: atlasSetting(setting),
          population,
          ontology: atlasOntology(ontology)
        },
        options
      );
    },

    getMultimorbidityCandidates(params = {}, options = {}) {
      return read(
        '/multimorbidity/candidates',
        { ...metricQuery(params), selected: params.selected, scope: params.scope, chapter_id: params.chapterId },
        options
      );
    },

    getMultimorbidityCombination(params = {}, options = {}) {
      return read('/multimorbidity/combination', { ...metricQuery(params), selected: params.selected }, options);
    },

    searchConcepts({ q, limit, population, ontology } = {}, options = {}) {
      return read('/search', { q, limit, population, ontology: atlasOntology(ontology) }, options);
    },

    /** A plain-language query read as chips (v1.14, CONTRACT.md §31); nothing is applied. */
    interpretQuery({ q } = {}, options = {}) {
      return read('/search/interpret', { q }, options);
    },

    /** The optional helper's reading of a query (v1.14, §20, §31): only the query and the vocabularies are sent. */
    interpretQueryWithHelper({ q } = {}, options = {}) {
      return sendJson('/assist/interpret', 'POST', { q }, options);
    },

    exportConcept(params = {}, options = {}) {
      return read(`/export/concepts/${segment(params.conceptId)}`, { ...metricQuery(params), audience: params.audience }, options);
    },

    /** The full assembled dataset as a JSON Blob (over 1 GB; never parsed). */
    exportDataset({ model, useCase, population } = {}, options = {}) {
      return send('/export/dataset', {
        params: { model, use_case: useCase, version: versionParam(options), population },
        signal: options.signal,
        expect: 'blob'
      });
    },

    /**
     * The live interaction plugin's lookup (contract v1.8, CONTRACT.md §19):
     * `lookup(body, { version, signal })`. The CDS Hooks–shaped body is sent
     * as given in a POST, so case inputs never appear in the URL; only
     * `version` (for a staged read) goes into the query. A local population
     * (v1.10) is named in the body as `context.population_id`.
     */
    lookup(body = {}, options = {}) {
      return send('/lookup', {
        method: 'POST',
        params: { version: versionParam(options) },
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        signal: options.signal
      });
    },

    /**
     * One card as a compact record for operational systems (contract v1.14,
     * CONTRACT.md §32.1): `getCardRecord({ model, useCase, format })`, format
     * 'json' (default) or 'jsonld' (the same content as JSON-LD, §32.3).
     */
    getCardRecord({ model, useCase, format } = {}, options = {}) {
      return read('/cards/record', { model, use_case: useCase, format: format === 'jsonld' ? 'jsonld' : undefined }, options);
    },

    /** CDS Hooks discovery of the local service (contract v1.14, CONTRACT.md §33). */
    getCdsServices(_params = {}, options = {}) {
      return read('/cds-services', {}, options);
    },

    /**
     * The local CDS Hooks service (contract v1.14, CONTRACT.md §33):
     * `callCdsService(request, { version, signal })` POSTs a CDS Hooks 2.0
     * patient-view request as given and resolves to `{ cards }`, one per
     * condition. Synthetic patients only; nothing is stored.
     */
    callCdsService(body = {}, options = {}) {
      return send('/cds-services/bmc-condition-status', {
        method: 'POST',
        params: { version: versionParam(options) },
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        signal: options.signal
      });
    },

    listDatasets(_params = {}, options = {}) {
      return send('/admin/datasets', { signal: options.signal });
    },

    /**
     * URL of an upload template (a URL builder: returns a string, no request).
     * `filled` exports the live data in template form; metrics and
     * multimorbidity then need `modelVersion` and `useCase`.
     */
    getTemplateUrl({ kind, format = 'csv', filled = false, modelVersion, useCase, populationId } = {}) {
      return url(`/admin/templates/${segment(kind)}.${segment(format)}`, {
        filled: filled ? 'true' : undefined,
        model_version: modelVersion,
        use_case: useCase,
        population_id: populationId
      });
    },

    /**
     * Starts a check; resolves to the Upload (status `checking`). `mode` is
     * 'replace' (default) or 'merge' (metrics, prevalence, safety; v1.7). A
     * local population (kind 'population', v1.10) needs `populationId`, and
     * `populationName` when it is new.
     */
    createUpload({ kind, file, modelVersion, useCase, replaceStaged = false, mode, populationId, populationName, submissionId } = {}, options = {}) {
      const form = new FormData();
      form.append('kind', kind);
      form.append('file', file, file?.name);
      if (modelVersion) form.append('model_version', modelVersion);
      if (useCase) form.append('use_case', useCase);
      if (populationId) form.append('population_id', populationId);
      if (populationName) form.append('population_name', populationName);
      if (submissionId) form.append('submission_id', submissionId);
      if (replaceStaged) form.append('replace_staged', 'true');
      if (mode && mode !== 'replace') form.append('mode', mode);
      return send('/admin/uploads', { method: 'POST', body: form, signal: options.signal });
    },

    /**
     * Stages JSON records as a merge upload in template form (v1.7, CONTRACT.md
     * §11.4): one object per template row, keyed by column key or header.
     * Resolves to the Upload (status `checking`); its report examples carry
     * `record`, the index of the record.
     */
    createRecordsUpload({ kind, records, modelVersion, useCase, replaceStaged = false, populationId, submissionId } = {}, options = {}) {
      const body = { kind, records, mode: 'merge' };
      if (modelVersion) body.model_version = modelVersion;
      if (useCase) body.use_case = useCase;
      if (populationId) body.population_id = populationId;
      if (submissionId) body.submission_id = submissionId;
      if (replaceStaged) body.replace_staged = true;
      return send('/admin/uploads/records', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        signal: options.signal
      });
    },

    getUpload({ uploadId } = {}, options = {}) {
      return send(`/admin/uploads/${segment(uploadId)}`, { signal: options.signal });
    },

    discardUpload({ uploadId } = {}, options = {}) {
      return send(`/admin/uploads/${segment(uploadId)}`, { method: 'DELETE', signal: options.signal, expect: 'none' });
    },

    /** URL of the uploaded file with its problems marked (a URL builder). */
    getAnnotatedUploadUrl({ uploadId, format = 'csv' } = {}) {
      return url(`/admin/uploads/${segment(uploadId)}/annotated.${segment(format)}`);
    },

    getUploadChanges({ uploadId } = {}, options = {}) {
      return send(`/admin/uploads/${segment(uploadId)}/changes`, { signal: options.signal });
    },

    /** Publishes a valid upload, with an optional change note (v1.7, at most 500 characters). */
    publishUpload({ uploadId, previewed = false, note, role, publisherName } = {}, options = {}) {
      const body = { previewed: Boolean(previewed), ...publisher({ note, role, publisherName }) };
      return send(`/admin/uploads/${segment(uploadId)}/publish`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        signal: options.signal
      });
    },

    /**
     * Publishes a version without the local population (v1.10, CONTRACT.md §21),
     * with an optional change note; a rollback of kind `population` restores it.
     */
    removePopulation({ populationId, note, role, publisherName } = {}, options = {}) {
      const body = publisher({ note, role, publisherName });
      const withBody = Object.keys(body).length > 0;
      return send(`/admin/populations/${segment(populationId)}/remove`, {
        method: 'POST',
        body: withBody ? JSON.stringify(body) : undefined,
        headers: withBody ? { 'Content-Type': 'application/json' } : undefined,
        signal: options.signal
      });
    },

    /**
     * The stored safety incidents for the Data Library (v1.11, CONTRACT.md §18):
     * open, mitigated, and closed, newest first; all of them, one AI system's
     * (`model`), or one card's (`model` and `useCase`). Each incident carries
     * the SafetyIncident fields plus `code_names` and `chapter_no` for the form.
     */
    listIncidents({ model, useCase, version } = {}, options = {}) {
      return send('/admin/safety/incidents', {
        params: { model, use_case: useCase, version: versionParam({ version: version ?? options.version }) },
        signal: options.signal
      });
    },

    listVersions({ kind } = {}, options = {}) {
      return send('/admin/versions', { params: { kind }, signal: options.signal });
    },

    /**
     * Restores a version's data set as a new version, with an optional change
     * note (v1.7); `everyKind` restores every data set in one version (v1.11).
     */
    rollbackVersion({ versionId, kind, everyKind = false, note, role, publisherName } = {}, options = {}) {
      const body = publisher({ note, role, publisherName });
      const withBody = Object.keys(body).length > 0;
      return send(`/admin/versions/${segment(versionId)}/rollback`, {
        method: 'POST',
        params: { kind, every_kind: everyKind ? 'true' : undefined },
        body: withBody ? JSON.stringify(body) : undefined,
        headers: withBody ? { 'Content-Type': 'application/json' } : undefined,
        signal: options.signal
      });
    },

    /** Assisted data entry (v1.9): status of the helper (CONTRACT.md §20). Never contains the API key. */
    getAssistStatus(options = {}) {
      return send('/admin/assist', { signal: options.signal });
    },

    /**
     * Turns the helper on. The API key is write-only: it is sent once and
     * never returned; leave it out to keep the stored key.
     */
    configureAssist({ provider, model, baseUrl, apiKey } = {}, options = {}) {
      const body = { provider };
      if (model) body.model = model;
      if (baseUrl) body.base_url = baseUrl;
      if (apiKey) body.api_key = apiKey;
      return send('/admin/assist', {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        signal: options.signal
      });
    },

    /** Turns the helper off and deletes its configuration, including the key. */
    clearAssist(options = {}) {
      return send('/admin/assist', { method: 'DELETE', signal: options.signal, expect: 'none' });
    },

    /**
     * Proposes records from one study: a file (PDF for a hosted model, text,
     * CSV, XLSX) or pasted text. Nothing is staged; accept records with
     * createRecordsUpload.
     */
    proposeRecords({ kind, file, text, modelVersion, useCase } = {}, options = {}) {
      const form = new FormData();
      form.append('kind', kind);
      if (file) form.append('file', file, file.name);
      if (text) form.append('text', text);
      if (modelVersion) form.append('model_version', modelVersion);
      if (useCase) form.append('use_case', useCase);
      return send('/admin/assist/proposals', { method: 'POST', body: form, signal: options.signal });
    },

    // ------------------------------------------------ contract v1.13, CONTRACT.md §26

    /**
     * Published versions, newest first: the public version feed (after: only newer ones; card, v1.14 §26.6:
     * a card id model_version and use_case joined by a bar, only the versions that changed that card).
     */
    listDatasetVersions({ after, card } = {}, options = {}) {
      return read('/versions', { after, card }, options);
    },

    /** An AI system's narrow model card (`narrow_model_card`, or null when it has none). */
    getNarrowModelCard({ modelVersion } = {}, options = {}) {
      return read(`/models/${segment(modelVersion)}/narrow-model-card`, {}, options);
    },

    /** Sets the instance profile (no dataset version); /meta serves it. */
    updateInstance({ kind, organisation, maintainedBy, contact, dataProtectionNote } = {}, options = {}) {
      const body = { kind, organisation, maintained_by: maintainedBy, contact: contact || null };
      // Contract v1.14 (§26.2): the note is sent only when given; leaving it out clears it.
      if (dataProtectionNote) body.data_protection_note = dataProtectionNote;
      return sendJson('/admin/instance', 'PUT', body, options);
    },

    createSubmission({ developerName, modelVersion, note } = {}, options = {}) {
      const body = { developer_name: developerName, model_version: modelVersion };
      if (note) body.note = note;
      return sendJson('/admin/submissions', 'POST', body, options);
    },

    listSubmissions({ status } = {}, options = {}) {
      return send('/admin/submissions', { params: { status }, signal: options.signal });
    },

    getSubmission({ submissionId } = {}, options = {}) {
      return send(`/admin/submissions/${segment(submissionId)}`, { signal: options.signal });
    },

    /** Publishes every part of a submission, one version each, as the custodian. */
    acceptSubmission({ submissionId, note, publisherName } = {}, options = {}) {
      return sendJson(`/admin/submissions/${segment(submissionId)}/accept`, 'POST', publisher({ note, publisherName }), options);
    },

    /** Returns a submission with a required note; its staged parts are discarded. */
    returnSubmission({ submissionId, note, publisherName } = {}, options = {}) {
      return sendJson(`/admin/submissions/${segment(submissionId)}/return`, 'POST', publisher({ note, publisherName }), options);
    },

    createModelCardUpload({ modelVersion, format, content, filename, submissionId, replaceStaged = false } = {}, options = {}) {
      const body = { model_version: modelVersion, format, content };
      if (filename) body.filename = filename;
      if (submissionId) body.submission_id = submissionId;
      if (replaceStaged) body.replace_staged = true;
      return sendJson('/admin/uploads/model-card', 'POST', body, options);
    },

    getModelCardProposals({ uploadId } = {}, options = {}) {
      return send(`/admin/uploads/${segment(uploadId)}/proposed-records`, { signal: options.signal });
    },

    /** Stages an evaluation results file (contract v1.14, §32.2): JSON text, checked in the background; it publishes nothing. */
    createEvaluationUpload({ content, filename, submissionId, replaceStaged = false } = {}, options = {}) {
      const body = { content };
      if (filename) body.filename = filename;
      if (submissionId) body.submission_id = submissionId;
      if (replaceStaged) body.replace_staged = true;
      return sendJson('/admin/uploads/evaluation-results', 'POST', body, options);
    },

    /** The benchmark study and metrics merge records a valid evaluation results upload proposes (§32.2); nothing is staged. */
    getEvaluationProposals({ uploadId } = {}, options = {}) {
      return send(`/admin/uploads/${segment(uploadId)}/evaluation-proposals`, { signal: options.signal });
    },

    /** URL of the public release bundle of this (public) instance (a URL builder). */
    getReleaseExportUrl() {
      return url('/admin/release/export');
    },

    importPublicRelease({ file } = {}, options = {}) {
      const form = new FormData();
      form.append('file', file, file?.name);
      return send('/admin/release/imports', { method: 'POST', body: form, signal: options.signal });
    },

    getReleaseImport({ importId } = {}, options = {}) {
      return send(`/admin/release/imports/${segment(importId)}`, { signal: options.signal });
    },

    publishReleaseImport({ importId, note, role, publisherName } = {}, options = {}) {
      return sendJson(`/admin/release/imports/${segment(importId)}/publish`, 'POST', publisher({ note, role, publisherName }), options);
    },

    discardReleaseImport({ importId } = {}, options = {}) {
      return send(`/admin/release/imports/${segment(importId)}`, { method: 'DELETE', signal: options.signal, expect: 'none' });
    }
  };

  function sendJson(path, method, body, options = {}) {
    return send(path, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: options.signal });
  }

  return adapter;
}

/** The note and (contract v1.13, no login) the workspace role and name a publish records. */
function publisher({ note, role, publisherName } = {}) {
  const body = {};
  if (note != null && note !== '') body.note = note;
  if (role) body.role = role;
  if (publisherName) body.publisher_name = publisherName;
  return body;
}
