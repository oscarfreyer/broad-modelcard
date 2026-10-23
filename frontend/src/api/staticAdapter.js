// Static data adapter (release 0.4):
// implements every data-client method from the snapshot that
// scripts/static/record.mjs recorded from the API, for the read-only build on
// a plain static file server (GitHub Pages). Next to apiAdapter.js, this is
// the only frontend module that calls fetch; appDataClient.js picks it in the
// static build (`vite build --mode static`).
//
// - Files are named by api/staticPaths.js; condition cards, Across groups,
//   study and effect lists, multimorbidity answers, the comparison, and
//   search are rebuilt by api/staticRebuild.js, api/staticComparison.js, and
//   api/staticSearch.js. Nothing graded is computed here.
// - The snapshot holds the live version at the default population. In ICD-11:
//   the default lens and each one-group lens for the rings, Summary (with the
//   prevalence-weighted shares), and comparison; the default lens for
//   condition cards, Across groups (of conditions), the group summary, and
//   multimorbidity. In each other classification the manifest lists
//   (contract v1.13, CONTRACT.md §23): the default lens for everything. Each
//   care setting a card stores (contract v1.14, §29), at all patients in
//   ICD-11: rings, Summary, condition cards, Across groups, and the group
//   summary. Per card: the card record (JSON and JSON-LD) and its change
//   history; whole: studies, effects, safety incidents, and the synonyms the
//   search and the interpreter use. `/meta` is served without local
//   populations and with the recorded classifications only.
// - Everything else (another lens, a staged version, a local population,
//   exports, the lookup, CDS Hooks, every Data Library operation) rejects
//   with a DataClientError of code `static_unavailable` that says so in words.
import { withSnapshotBlocks } from './catalogueSnapshot.js';
import { DataClientError } from './dataClient.js';
import { DEFAULT_LENS, lensGroups, lensSetting, selectionKey, staticPaths } from './staticPaths.js';
import { comparisonAnswer, parseCardIds } from './staticComparison.js';
import {
  chapterOfConcept,
  conceptMetricsAnswer,
  cardVersionsAnswer,
  conceptSubgroupsAnswer,
  effectsAnswer,
  incidentsAnswer,
  emptySelectionAnswer,
  studiesAnswer,
  studyAnswer,
  withSelection
} from './staticRebuild.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, createSearchIndex } from './staticSearch.js';
import { interpretQuery, vocabularyOf } from './staticInterpret.js';
import { ICD11, ontologyList, otherOntology } from '../shared/ontology.js';

export const STATIC_DATA_DIR = 'static-data';
export const STATIC_UNAVAILABLE = 'static_unavailable';
// Search and interpretation take at most 200 characters, as the API's `q` does (CONTRACT.md §9, §31).
const MAX_QUERY_LENGTH = 200;
const TITLE = 'Not in the static demo';

export const STATIC_REASONS = Object.freeze({
  writes: 'The Data Library and its updates need the local app.',
  exports: 'Exports need the local app.',
  lookup: 'The live interaction panel needs the local app.',
  version: 'The static demo holds the published data only, no staged updates.',
  population: 'The static demo holds the default prevalence only, no local populations.',
  ontology: 'The static demo does not hold this classification.',
  ontologyLens: 'In the static demo, classifications other than ICD-11 are shown for all patients only.',
  combinedLens: 'The static demo holds one population group at a time. Choose “All” on the other population settings.',
  detailsLens: 'In the static demo, condition details are available for all patients only.',
  multimorbidityLens: 'In the static demo, multimorbidity is available for all patients only.',
  subgroups: 'In the static demo, results across groups are available for ICD-11 conditions only.',
  // Contract v1.14 (CONTRACT.md §29): care settings are recorded per card, at all patients in ICD-11.
  settingCard: 'The static demo holds this card at Any setting and at the care settings it stores results for.',
  settingLens: 'In the static demo, a care setting is shown for all patients only. Choose Any setting to choose a group.',
  settingOntology: 'In the static demo, care settings are shown in ICD-11 only.',
  settingMultimorbidity: 'In the static demo, multimorbidity is available for Any setting only.',
  settingComparison: 'In the static demo, the comparison is available for Any setting only.',
  // Contract v1.14 (CONTRACT.md §26.6): the change history is recorded per card.
  versions: 'The static demo holds the change history of each card, not the whole feed.',
  missing: 'The static demo did not record this data.'
});

function throwIfQueryTooLong(q) {
  if (String(q ?? '').length > MAX_QUERY_LENGTH) {
    throw new DataClientError({ status: 422, code: 'invalid_query', title: `q: at most ${MAX_QUERY_LENGTH} characters` });
  }
}

export function staticUnavailable(detail = STATIC_REASONS.missing, status = 404) {
  return new DataClientError({ status, code: STATIC_UNAVAILABLE, title: TITLE, detail });
}

const reject = (detail) => Promise.reject(staticUnavailable(detail));

/**
 * The reason a read cannot come from the snapshot, or null when it can.
 * `ontologies` are the classifications the snapshot holds (ICD-11 always).
 */
export function unrecordedReason({
  version,
  population,
  ontology = null,
  ontologies = [ICD11],
  lens = {},
  defaultLensOnly = false,
  reasonForLens,
  settings = null
} = {}) {
  if (version && version !== 'live') return STATIC_REASONS.version;
  if (population) return STATIC_REASONS.population;
  const other = otherOntology(ontology);
  if (other && !ontologies.includes(other)) return STATIC_REASONS.ontology;
  const groups = lensGroups(lens);
  // Contract v1.14 (§29): the settings a card stores, at all patients in ICD-11.
  const setting = lensSetting(lens);
  if (setting) {
    if (other) return STATIC_REASONS.settingOntology;
    if (groups.length) return STATIC_REASONS.settingLens;
    if (!settings || !settings.includes(setting)) return STATIC_REASONS.settingCard;
  }
  if (defaultLensOnly && groups.length) return reasonForLens;
  if (other && groups.length) return STATIC_REASONS.ontologyLens;
  if (groups.length > 1) return STATIC_REASONS.combinedLens;
  return null;
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl] the snapshot's root, default static-data (relative to the page)
 * @param {typeof fetch} [options.fetch] default: the global fetch, looked up per request
 * @param {'live'|`staged:${string}`} [options.defaultVersion] version for reads without one; only 'live' is recorded
 */
export function createStaticAdapter({
  baseUrl = STATIC_DATA_DIR,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  defaultVersion = 'live'
} = {}) {
  const root = baseUrl.replace(/\/+$/, '');
  const versionOf = (options) => options?.version ?? defaultVersion;
  // One request per file: the snapshot never changes while the page is open.
  const files = new Map();

  function readFile(path, signal) {
    let promise = files.get(path);
    if (!promise) {
      promise = (async () => {
        let response;
        try {
          response = await fetchImpl(`${root}/${path}`);
        } catch {
          throw new DataClientError({ status: 0, code: 'backend_unavailable', title: 'The static demo data could not be loaded', detail: 'Check the connection and reload the page.' });
        }
        if (!response.ok) {
          throw staticUnavailable(STATIC_REASONS.missing, response.status === 404 ? 404 : response.status);
        }
        return response.json();
      })();
      files.set(path, promise);
      promise.catch(() => files.delete(path));
    }
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new DOMException('The request was aborted.', 'AbortError'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException('The request was aborted.', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
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

  const readManifest = (signal) => readFile(staticPaths.manifest(), signal).catch(() => ({}));

  /** The classifications the snapshot holds: ICD-11 and those the manifest lists. */
  async function recordedOntologies(signal) {
    const manifest = await readManifest(signal);
    return Array.isArray(manifest.ontologies) && manifest.ontologies.length ? manifest.ontologies : [ICD11];
  }

  /** The specific care settings the snapshot holds for a card (contract v1.14, §29): those it stores. */
  async function recordedSettings(model, useCase, signal) {
    const manifest = await readManifest(signal);
    const card = (manifest.cards ?? []).find((entry) => entry.model === model && entry.use_case === useCase);
    return Array.isArray(card?.settings) ? card.settings : [];
  }

  const lensOf = (params) => ({ age: params.age, sex: params.sex, ethnicity: params.ethnicity, setting: params.setting });

  /** The reason a read is not in the snapshot (or null), knowing which classifications and settings it holds. */
  async function reasonFor({ params = {}, options = {}, defaultLensOnly = false, reasonForLens } = {}) {
    const ontology = otherOntology(params.ontology);
    const setting = lensSetting(params);
    return unrecordedReason({
      version: versionOf(options),
      population: params.population,
      ontology,
      ontologies: ontology ? await recordedOntologies(options.signal) : [ICD11],
      lens: lensOf(params),
      defaultLensOnly,
      reasonForLens,
      settings: setting ? await recordedSettings(params.model, params.useCase, options.signal) : null
    });
  }

  /** Rejects when the read is not in the snapshot; otherwise reads the file. */
  async function guardedRead(path, { params = {}, options = {}, defaultLensOnly = false, reasonForLens } = {}) {
    const reason = await reasonFor({ params, options, defaultLensOnly, reasonForLens });
    if (reason) throw staticUnavailable(reason);
    return readFile(path(), options.signal);
  }

  const conceptChapters = new Map();
  const searchIndexes = new Map();

  /** A lazily read, reset-on-failure value per key. */
  function memo(cache, key, load) {
    let promise = cache.get(key);
    if (!promise) {
      promise = load();
      cache.set(key, promise);
      promise.catch(() => cache.delete(key));
    }
    return promise;
  }

  async function chapterIdOf(conceptId, ontology, signal) {
    const index = await memo(conceptChapters, ontology ?? ICD11, () => readFile(staticPaths.conceptChapters(ontology), signal).then(chapterOfConcept));
    return index.get(conceptId) ?? null;
  }

  function getSearchIndex(ontology, signal) {
    return memo(searchIndexes, ontology ?? ICD11, async () => {
      const overview = ontology ? await readFile(staticPaths.atlasOverview(ontology), signal) : await readFile(staticPaths.meta(), signal);
      const [synonyms, ...chapters] = await Promise.all([
        // Contract v1.14 (§31): the ICD-11 search and the interpreter match synonyms; a snapshot without them has none.
        ontology ? null : readFile(staticPaths.synonyms(), signal).catch(() => null),
        ...overview.chapters.map((chapter) => readFile(staticPaths.chapter(chapter.concept_id, ontology), signal))
      ]);
      return createSearchIndex(
        chapters.flatMap((answer) => [answer.chapter, ...answer.blocks, ...answer.concepts]),
        { isOtherOntology: Boolean(ontology), ontology: ontology ? overview.ontology ?? null : null, synonyms }
      );
    });
  }

  const unknownConcept = (conceptId) =>
    new DataClientError({ status: 404, code: 'unknown_concept', title: 'Unknown concept', detail: `Unknown concept '${conceptId}'.` });

  /**
   * The card's multimorbidity index (mm/index.json): `candidates` and
   * `combinations` list the selection keys the snapshot holds a non-empty
   * answer for; `templates` are recorded empty answers for every other one.
   */
  function multimorbidityIndex(params, signal) {
    return readFile(staticPaths.multimorbidityIndex(params), signal);
  }

  function multimorbidityReason(params, options) {
    if (lensSetting(params)) return STATIC_REASONS.settingMultimorbidity;
    return unrecordedReason({
      version: versionOf(options),
      population: params.population,
      lens: lensOf(params),
      defaultLensOnly: true,
      reasonForLens: STATIC_REASONS.multimorbidityLens
    });
  }

  const selectedOf = (params) => (Array.isArray(params.selected) ? params.selected : String(params.selected ?? '').split(',')).filter(Boolean);

  const adapter = {
    async getMeta(_params = {}, options = {}) {
      const [meta, recorded] = await Promise.all([readFile(staticPaths.meta(), options.signal), recordedOntologies(options.signal)]);
      // The snapshot holds the default prevalence only, and the classifications it recorded (R7).
      return { ...meta, populations: [], ontologies: ontologyList(meta).filter((entry) => entry.id === ICD11 || recorded.includes(entry.id)) };
    },

    listModels(_params = {}, options = {}) {
      return guardedRead(staticPaths.models, { options });
    },

    async getCatalogue(params = {}, options = {}) {
      const readOptions = { version: params.version, signal: params.signal, ...options };
      const catalogue = await guardedRead(staticPaths.catalogue, { params: { population: params.population }, options: readOptions });
      return withSnapshotBlocks(catalogue);
    },

    getAtlasOverview(params = {}, options = {}) {
      return guardedRead(() => staticPaths.atlasOverview(otherOntology(params.ontology)), { params, options });
    },

    getChapter(params = {}, options = {}) {
      return guardedRead(() => staticPaths.chapter(params.chapterId, otherOntology(params.ontology)), { params, options });
    },

    async getMetricMap(params = {}, options = {}) {
      const chapterId = params.scope === 'chapter' ? params.chapterId : null;
      if (params.scope === 'chapter' && !chapterId) {
        throw new DataClientError({ status: 422, code: 'missing_chapter_id', title: 'A chapter scope needs a chapter' });
      }
      return guardedRead(() => staticPaths.metricMap({ ...params, ontology: otherOntology(params.ontology), chapterId }), { params, options });
    },

    getMetricSummary(params = {}, options = {}) {
      // The weighted shares (contract v1.14, §30) are recorded at view overall, beside each summary.
      if (params.weights && params.weights !== 'prevalence') {
        return Promise.reject(new DataClientError({ status: 422, code: 'validation_error', title: 'weights must be prevalence' }));
      }
      if (params.weights && params.view && params.view !== 'overall') return reject(STATIC_REASONS.missing);
      return guardedRead(() => staticPaths.metricSummary({ ...params, ontology: otherOntology(params.ontology) }), { params, options });
    },

    async getConceptMetrics(params = {}, options = {}) {
      const reason = await reasonFor({ params, options, defaultLensOnly: true, reasonForLens: STATIC_REASONS.detailsLens });
      if (reason) throw staticUnavailable(reason);
      const ontology = otherOntology(params.ontology);
      const chapterId = await chapterIdOf(params.conceptId, ontology, options.signal);
      if (!chapterId) throw unknownConcept(params.conceptId);
      const [bundle, chapter, mappings] = await Promise.all([
        readFile(staticPaths.conceptBundle({ ...params, ontology, chapterId }), options.signal),
        readFile(staticPaths.chapter(chapterId, ontology), options.signal),
        ontology ? readFile(staticPaths.conceptMappings(chapterId, ontology), options.signal) : null
      ]);
      const answer = conceptMetricsAnswer(bundle, chapter, params.conceptId, mappings);
      if (!answer) throw staticUnavailable();
      return answer;
    },

    // Across groups (contract v1.13, CONTRACT.md §24): recorded for the ICD-11
    // conditions (depth 1) of every card, bundled per chapter. Chapters,
    // subchapters, deeper categories, and other classifications say so.
    async getConceptSubgroups(params = {}, options = {}) {
      const reason = await reasonFor({ params, options });
      if (reason) throw staticUnavailable(reason);
      if (otherOntology(params.ontology)) throw staticUnavailable(STATIC_REASONS.subgroups);
      const chapterId = await chapterIdOf(params.conceptId, null, options.signal);
      if (!chapterId) throw unknownConcept(params.conceptId);
      const [bundle, chapter] = await Promise.all([
        readFile(staticPaths.subgroupBundle({ ...params, chapterId }), options.signal),
        readFile(staticPaths.chapter(chapterId), options.signal)
      ]);
      const answer = conceptSubgroupsAnswer(bundle, chapter, params.conceptId);
      if (!answer) throw staticUnavailable(STATIC_REASONS.subgroups);
      return answer;
    },

    // The group summary (contract v1.14, §24): recorded per card at Any setting and at each stored
    // setting. It counts ICD-11 conditions whatever the classification, so one file serves every one.
    async getSubgroupSummary({ model, useCase, setting, population, ontology } = {}, options = {}) {
      const reason = await reasonFor({ params: { model, useCase, setting, population, ontology }, options });
      if (reason) throw staticUnavailable(reason);
      return readFile(staticPaths.subgroupSummary({ model, useCase, setting: lensSetting({ setting }) }), options.signal);
    },

    async listStudies({ model } = {}, options = {}) {
      return studiesAnswer(await guardedRead(staticPaths.studies, { options }), { model });
    },

    async getStudy({ studyId } = {}, options = {}) {
      const answer = studyAnswer(await guardedRead(staticPaths.studies, { options }), studyId);
      if (!answer) {
        throw new DataClientError({ status: 404, code: 'unknown_study', title: 'Unknown study', detail: `Unknown study '${studyId}'.` });
      }
      return answer;
    },

    async listEffects({ model, useCase } = {}, options = {}) {
      return effectsAnswer(await guardedRead(staticPaths.effects, { options }), { model, useCase });
    },

    // Contract v1.14 (CONTRACT.md §30): the incidents are recorded whole, the filters applied here.
    async listSafetyIncidents({ model, useCase } = {}, options = {}) {
      return incidentsAnswer(await guardedRead(staticPaths.incidents, { options }), { model, useCase });
    },

    // Contract v1.14 (§26.6): the change history of each card, recorded per card; the whole feed is not.
    async listDatasetVersions({ after, card } = {}, options = {}) {
      if (!card) throw staticUnavailable(STATIC_REASONS.versions);
      const [model, useCase, ...rest] = String(card).split('|');
      if (!model?.trim() || !useCase?.trim() || rest.length) {
        throw new DataClientError({ status: 422, code: 'invalid_parameter', title: 'Invalid card', detail: `card: expected an AI system and a function separated by |, got ${card}.` });
      }
      const recorded = await guardedRead(() => staticPaths.cardVersions({ model, useCase }), { options }).catch(async (error) => {
        // A card the snapshot does not hold has no version, as the API says.
        if (error?.code !== STATIC_UNAVAILABLE || error.detail !== STATIC_REASONS.missing) throw error;
        const meta = await readFile(staticPaths.meta(), options.signal);
        return { dataset_version: meta.dataset_version, versions: [] };
      });
      return cardVersionsAnswer(recorded, { after });
    },

    // Contract v1.14 (§32): the card record of every card, as JSON and as JSON-LD.
    getCardRecord({ model, useCase, format } = {}, options = {}) {
      return guardedRead(() => staticPaths.cardRecord({ model, useCase, format: format === 'jsonld' ? 'jsonld' : 'json' }), { options });
    },

    // The comparison (contract v1.13, CONTRACT.md §25): the published rule over
    // the recorded facts and cells of each card (api/staticComparison.js).
    async getComparison({ cards = [], scope = 'atlas', chapterId, age, sex, ethnicity, setting, population, ontology } = {}, options = {}) {
      // Contract v1.14 (§29): the comparison is recorded at Any setting only.
      if (lensSetting({ setting })) throw staticUnavailable(STATIC_REASONS.settingComparison);
      const parsed = parseCardIds(cards);
      if (parsed.error) {
        throw new DataClientError({ status: 422, code: 'invalid_cards', title: 'Invalid cards', detail: parsed.error });
      }
      const chosenScope = scope === 'chapter' ? 'chapter' : 'atlas';
      if (chosenScope === 'chapter' && !chapterId) {
        throw new DataClientError({ status: 422, code: 'missing_chapter_id', title: 'A chapter scope needs a chapter' });
      }
      const params = { age, sex, ethnicity, population, ontology };
      const reason = await reasonFor({ params, options });
      if (reason) throw staticUnavailable(reason);
      const other = otherOntology(ontology);
      const registry = await readFile(staticPaths.models(), options.signal);
      for (const { model, useCase } of parsed.pairs) {
        const entry = registry.models.find((candidate) => candidate.model_version === model);
        if (!entry) {
          throw new DataClientError({ status: 404, code: 'unknown_model', title: 'Unknown model', detail: `Unknown model '${model}'.` });
        }
        if (!entry.use_cases.some((variant) => variant.use_case === useCase)) {
          throw new DataClientError({ status: 404, code: 'unknown_use_case', title: 'Unknown function', detail: `${model} has no function '${useCase}'.` });
        }
      }
      const lens = lensOf(params);
      const [rows, ...cardFiles] = await Promise.all([
        readFile(staticPaths.comparisonRows(other), options.signal),
        ...parsed.pairs.map(({ model, useCase }) => readFile(staticPaths.comparisonCard({ model, useCase, ontology: other, ...lens }), options.signal))
      ]);
      const answer = comparisonAnswer({ rows, cards: cardFiles, scope: chosenScope, chapterId, lens });
      if (!answer) throw unknownConcept(chapterId);
      return answer;
    },

    async getMultimorbidityCandidates(params = {}, options = {}) {
      const reason = multimorbidityReason(params, options);
      if (reason) throw staticUnavailable(reason);
      const selected = selectedOf(params);
      const scope = params.scope === 'chapter' ? 'chapter' : 'atlas';
      if (scope === 'chapter' && !params.chapterId) {
        throw new DataClientError({ status: 422, code: 'missing_chapter_id', title: 'A chapter scope needs a chapter' });
      }
      const index = await multimorbidityIndex(params, options.signal);
      if (!index.candidates.includes(selectionKey(selected))) {
        return emptySelectionAnswer(index.templates.candidates[scope], selected);
      }
      const bundle = await readFile(staticPaths.multimorbidityCandidates({ ...params, selected }), options.signal);
      const answer = scope === 'chapter' ? bundle.chapters[params.chapterId] : bundle.atlas;
      if (!answer) throw staticUnavailable();
      return withSelection(answer, selected);
    },

    async getMultimorbidityCombination(params = {}, options = {}) {
      const reason = multimorbidityReason(params, options);
      if (reason) throw staticUnavailable(reason);
      const selected = selectedOf(params);
      if (new Set(selected).size < 2) {
        throw new DataClientError({ status: 422, code: 'invalid_selection', title: 'A combination needs at least two conditions' });
      }
      const index = await multimorbidityIndex(params, options.signal);
      if (!index.combinations.includes(selectionKey(selected))) {
        return emptySelectionAnswer(index.templates.combination, selected);
      }
      return withSelection(await readFile(staticPaths.multimorbidityCombination({ ...params, selected }), options.signal), selected);
    },

    async searchConcepts({ q, limit, population, ontology } = {}, options = {}) {
      const reason = await reasonFor({ params: { population, ontology }, options });
      if (reason) throw staticUnavailable(reason);
      const size = limit == null ? DEFAULT_SEARCH_LIMIT : Number(limit);
      if (!Number.isInteger(size) || size < 1 || size > MAX_SEARCH_LIMIT) {
        throw new DataClientError({ status: 422, code: 'invalid_limit', title: `limit must be between 1 and ${MAX_SEARCH_LIMIT}` });
      }
      throwIfQueryTooLong(q);
      const answer = (await getSearchIndex(otherOntology(ontology), options.signal)).search(q, size);
      if (!answer) {
        throw new DataClientError({ status: 422, code: 'invalid_query', title: 'Enter an ICD-11 code, a concept id, or part of a name.' });
      }
      return answer;
    },

    /**
     * Contract v1.14 (§31): the interpreter's port (staticInterpret.js) over the recorded
     * registry and axes and the static search with its recorded synonyms. Setting chips
     * come from the Context axis, as from the API.
     */
    async interpretQuery({ q } = {}, options = {}) {
      const version = options.version ?? 'live';
      if (version !== 'live') throw staticUnavailable(STATIC_REASONS.version);
      throwIfQueryTooLong(q);
      const query = String(q ?? '').split(/\s+/).filter(Boolean).join(' ');
      if (!query) {
        throw new DataClientError({ status: 422, code: 'invalid_query', title: 'Enter a few words, for example: heart failure in older women.' });
      }
      const [meta, models, index] = await Promise.all([
        readFile(staticPaths.meta(), options.signal),
        readFile(staticPaths.models(), options.signal),
        getSearchIndex(null, options.signal)
      ]);
      const vocabulary = vocabularyOf(models, meta.axes);
      return interpretQuery(query, vocabulary, index, (conceptId) => index.conceptById(conceptId));
    },
    interpretQueryWithHelper: () => reject(STATIC_REASONS.writes),

    exportConcept: () => reject(STATIC_REASONS.exports),
    exportDataset: () => reject(STATIC_REASONS.exports),
    lookup: () => reject(STATIC_REASONS.lookup),
    // Contract v1.14 (§33): the CDS Hooks service needs the local app.
    getCdsServices: () => reject(STATIC_REASONS.lookup),
    callCdsService: () => reject(STATIC_REASONS.lookup),

    listDatasets: () => reject(STATIC_REASONS.writes),
    /** No templates in the static demo: a link to nothing. */
    getTemplateUrl: () => '#',
    createUpload: () => reject(STATIC_REASONS.writes),
    createRecordsUpload: () => reject(STATIC_REASONS.writes),
    getUpload: () => reject(STATIC_REASONS.writes),
    discardUpload: () => reject(STATIC_REASONS.writes),
    getAnnotatedUploadUrl: () => '#',
    getUploadChanges: () => reject(STATIC_REASONS.writes),
    publishUpload: () => reject(STATIC_REASONS.writes),
    removePopulation: () => reject(STATIC_REASONS.writes),
    listIncidents: () => reject(STATIC_REASONS.writes),
    listVersions: () => reject(STATIC_REASONS.writes),
    rollbackVersion: () => reject(STATIC_REASONS.writes),
    getAssistStatus: () => reject(STATIC_REASONS.writes),
    configureAssist: () => reject(STATIC_REASONS.writes),
    clearAssist: () => reject(STATIC_REASONS.writes),
    proposeRecords: () => reject(STATIC_REASONS.writes),
    // Contract v1.13 (CONTRACT.md §26): not recorded; the Data Library is not in the static build.
    getNarrowModelCard: () => reject(STATIC_REASONS.missing),
    updateInstance: () => reject(STATIC_REASONS.writes),
    createSubmission: () => reject(STATIC_REASONS.writes),
    listSubmissions: () => reject(STATIC_REASONS.writes),
    getSubmission: () => reject(STATIC_REASONS.writes),
    acceptSubmission: () => reject(STATIC_REASONS.writes),
    returnSubmission: () => reject(STATIC_REASONS.writes),
    createModelCardUpload: () => reject(STATIC_REASONS.writes),
    getModelCardProposals: () => reject(STATIC_REASONS.writes),
    createEvaluationUpload: () => reject(STATIC_REASONS.writes),
    getEvaluationProposals: () => reject(STATIC_REASONS.writes),
    getReleaseExportUrl: () => '#',
    importPublicRelease: () => reject(STATIC_REASONS.writes),
    getReleaseImport: () => reject(STATIC_REASONS.writes),
    publishReleaseImport: () => reject(STATIC_REASONS.writes),
    discardReleaseImport: () => reject(STATIC_REASONS.writes)
  };

  return adapter;
}

export { DEFAULT_LENS };
