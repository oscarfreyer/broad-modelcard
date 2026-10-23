// The API adapter against a mocked fetch: request mapping per openapi.json,
// dataset versions, problem details, aborts, uploads, and URL builders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiAdapter, queryString } from '../frontend/src/api/apiAdapter.js';
import { DATA_CLIENT_METHODS, DataClientError, createDataClient } from '../frontend/src/api/dataClient.js';
import { openapi } from './support/openapiSchema.js';

const json = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const problemResponse = (status, code, title, detail) =>
  new Response(JSON.stringify({ type: `urn:broad-modelcard:problem:${code}`, title, status, code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' }
  });

/** A client over a fetch mock that records requests and answers with `respond(request)`. */
function mockClient(respond = () => json({ ok: true }), adapterOptions = {}) {
  const requests = [];
  const fetchMock = async (input, init = {}) => {
    if (init.signal?.aborted) {
      throw new DOMException('This operation was aborted', 'AbortError');
    }
    const url = new URL(input, 'http://localhost');
    const request = { url, path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method ?? 'GET', init };
    requests.push(request);
    return respond(request);
  };
  const client = createDataClient(createApiAdapter({ fetch: fetchMock, ...adapterOptions }));
  return { client, requests, last: () => requests.at(-1) };
}

const FILTERS = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', age: 'Age 65+', sex: 'Sex Female', ethnicity: 'All ethnicities' };
const METRIC_QUERY = { model: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS', age: 'Age 65+', sex: 'Sex Female', ethnicity: 'All ethnicities' };

/** Path template from openapi.json for an operationId, with its method and query parameter names. */
function operation(operationId) {
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (op.operationId === operationId) {
        const params = (op.parameters ?? []).map((p) => (p.$ref ? openapi.components.parameters[p.$ref.split('/').pop()] : p));
        return { path, method: method.toUpperCase(), query: params.filter((p) => p.in === 'query').map((p) => p.name) };
      }
    }
  }
  throw new Error(operationId);
}

/** Does a concrete request path match an openapi path template like /atlas/chapters/{chapter_id}? */
function matchesTemplate(template, path) {
  const pattern = template.replace(/\{[^}]+\}/g, '[^/]+').replace(/\./g, '\\.');
  return new RegExp(`^/api/v1${pattern}$`).test(path);
}

test('the API adapter implements the full data client contract', () => {
  const adapter = createApiAdapter({ fetch: async () => json({}) });
  assert.deepEqual(Object.keys(adapter).sort(), [...DATA_CLIENT_METHODS].sort());
  assert.doesNotThrow(() => createDataClient(adapter));
});

test('every read maps to its openapi operation, path, method, and query names', async () => {
  const { client, last } = mockClient();
  const calls = {
    getMeta: () => client.getMeta(),
    listModels: () => client.listModels(),
    getAtlasOverview: () => client.getAtlasOverview(),
    getChapter: () => client.getChapter({ chapterId: 'CH-05' }),
    getMetricMap: () => client.getMetricMap({ ...FILTERS, scope: 'chapter', chapterId: 'CH-05' }),
    getMetricSummary: () => client.getMetricSummary({ ...FILTERS, view: 'evidence' }),
    getConceptMetrics: () => client.getConceptMetrics({ ...FILTERS, conceptId: '5A11' }),
    getConceptSubgroups: () => client.getConceptSubgroups({ ...FILTERS, conceptId: '5A11' }),
    getMultimorbidityCandidates: () => client.getMultimorbidityCandidates({ ...FILTERS, selected: ['5A11', 'BA00'], scope: 'atlas' }),
    getMultimorbidityCombination: () => client.getMultimorbidityCombination({ ...FILTERS, selected: ['5A11', 'BA00'] }),
    searchConcepts: () => client.searchConcepts({ q: 'diabetes', limit: 5 }),
    exportConcept: () => client.exportConcept({ ...FILTERS, conceptId: '5A11', audience: 'patient' }),
    listDatasets: () => client.listDatasets(),
    getUpload: () => client.getUpload({ uploadId: 'u1' }),
    getUploadChanges: () => client.getUploadChanges({ uploadId: 'u1' }),
    listVersions: () => client.listVersions({ kind: 'prevalence' })
  };
  for (const [operationId, call] of Object.entries(calls)) {
    await call();
    const spec = operation(operationId);
    const request = last();
    assert.equal(request.method, spec.method, operationId);
    assert.ok(matchesTemplate(spec.path, request.path), `${operationId}: ${request.path} vs ${spec.path}`);
    const unknown = Object.keys(request.query).filter((name) => !spec.query.includes(name));
    assert.deepEqual(unknown, [], `${operationId} sends only declared query parameters`);
  }
});

test('metric reads send model, use case, lenses, scope, and selection under their API names', async () => {
  const { client, last } = mockClient();
  await client.getMetricMap({ ...FILTERS, scope: 'chapter', chapterId: 'CH-05' });
  assert.equal(last().path, '/api/v1/metrics/map');
  assert.deepEqual(last().query, { ...METRIC_QUERY, scope: 'chapter', chapter_id: 'CH-05' });

  await client.getMetricMap({ model: 'M', useCase: 'U', scope: 'atlas', chapterId: undefined });
  assert.deepEqual(last().query, { model: 'M', use_case: 'U', scope: 'atlas' }, 'unset lenses and chapter are left out');

  await client.getMultimorbidityCandidates({ ...FILTERS, selected: ['5A11', 'BA00'], scope: 'atlas' });
  assert.equal(last().query.selected, '5A11,BA00', 'selected is comma-separated, in selection order');
  await client.getMultimorbidityCandidates({ ...FILTERS, selected: [], scope: 'atlas' });
  assert.equal('selected' in last().query, false, 'an empty selection is left out');

  await client.getConceptMetrics({ ...FILTERS, conceptId: '1A03.0' });
  assert.equal(last().path, '/api/v1/metrics/concepts/1A03.0');
  await client.getChapter({ chapterId: 'CH 01/x' });
  assert.equal(last().url.pathname, '/api/v1/atlas/chapters/CH%2001%2Fx', 'path segments are encoded');

  await client.searchConcepts({ q: ' 5A11 ', limit: 10 });
  assert.deepEqual(last().query, { q: ' 5A11 ', limit: '10' });
  await client.exportConcept({ ...FILTERS, conceptId: '5A11', audience: 'expert' });
  assert.equal(last().query.audience, 'expert');
});

test('reads use the adapter version unless a read names its own', async () => {
  const live = mockClient();
  await live.client.getMeta();
  assert.equal('version' in live.last().query, false, 'live is the default and is left out');
  await live.client.getMetricMap({ ...FILTERS, scope: 'atlas' }, { version: 'staged:abc' });
  assert.equal(live.last().query.version, 'staged:abc');

  const staged = mockClient(undefined, { defaultVersion: 'staged:up_1' });
  await staged.client.getAtlasOverview();
  assert.equal(staged.last().query.version, 'staged:up_1');
  await staged.client.searchConcepts({ q: 'x' });
  assert.equal(staged.last().query.version, 'staged:up_1');
  await staged.client.getMetricMap({ ...FILTERS, scope: 'atlas' }, { version: 'live' });
  assert.equal('version' in staged.last().query, false, 'a read can ask for live data explicitly');
  await staged.client.listDatasets();
  assert.equal('version' in staged.last().query, false, 'admin operations take no version');
});

test('requests use the default cache mode so the browser revalidates ETags', async () => {
  const { client, last } = mockClient();
  await client.getMetricMap({ ...FILTERS, scope: 'atlas' });
  assert.equal(last().init.cache, undefined);
  assert.equal(last().init.headers, undefined, 'no hand-made If-None-Match');
});

test('problem+json responses become DataClientError with status and code', async () => {
  const { client } = mockClient(() => problemResponse(404, 'unknown_model', 'Unknown model', "Unknown model 'X'."));
  await assert.rejects(client.getMetricMap({ model: 'X', useCase: 'U', scope: 'atlas' }), (error) => {
    assert.ok(error instanceof DataClientError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'unknown_model');
    assert.equal(error.title, 'Unknown model');
    assert.equal(error.detail, "Unknown model 'X'.");
    return true;
  });
});

test('an unreachable backend becomes backend_unavailable; aborts stay AbortError', async () => {
  const down = createDataClient(createApiAdapter({ fetch: async () => { throw new TypeError('fetch failed'); } }));
  await assert.rejects(down.getMeta(), (error) => error instanceof DataClientError && error.code === 'backend_unavailable' && error.status === 0);

  const proxied = mockClient(() => new Response('', { status: 502, statusText: 'Bad Gateway' }));
  await assert.rejects(proxied.client.getMeta(), { code: 'backend_unavailable', status: 502 });

  const html = mockClient(() => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(html.client.getMeta(), { code: 'backend_unavailable' }, 'a static server answering /api with a page');

  const odd = mockClient(() => new Response('teapot', { status: 418, statusText: "I'm a teapot" }));
  await assert.rejects(odd.client.getMeta(), { code: 'unexpected_response', status: 418 });

  const { client } = mockClient();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.getMetricMap({ ...FILTERS, scope: 'atlas' }, { signal: controller.signal }), { name: 'AbortError' });
});

test('the signal reaches fetch', async () => {
  const { client, last } = mockClient();
  const controller = new AbortController();
  await client.getConceptMetrics({ ...FILTERS, conceptId: '5A11' }, { signal: controller.signal });
  assert.equal(last().init.signal, controller.signal);
});

test('createUpload posts multipart form data with the target and replace flag', async () => {
  const { client, last } = mockClient((request) => json({ upload_id: 'u1', status: 'checking' }, { status: 202 }));
  const file = new File(['a,b\n1,2\n'], 'metrics.csv', { type: 'text/csv' });
  const upload = await client.createUpload({ kind: 'metrics', file, modelVersion: 'SynGPT-2.0', useCase: 'CDSS', replaceStaged: true });
  assert.equal(upload.upload_id, 'u1');
  const request = last();
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/v1/admin/uploads');
  const form = request.init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('kind'), 'metrics');
  assert.equal(form.get('model_version'), 'SynGPT-2.0');
  assert.equal(form.get('use_case'), 'CDSS');
  assert.equal(form.get('replace_staged'), 'true');
  assert.equal(form.get('file').name, 'metrics.csv');
  assert.equal(request.init.headers, undefined, 'the browser sets the multipart boundary');

  await client.createUpload({ kind: 'prevalence', file });
  assert.equal(last().init.body.get('model_version'), null);
  assert.equal(last().init.body.get('replace_staged'), null);
});

test('publish, discard, and rollback use their methods and bodies', async () => {
  const { client, last } = mockClient((request) => (request.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ version_id: 4 })));
  await client.publishUpload({ uploadId: 'u1', previewed: true });
  assert.equal(last().method, 'POST');
  assert.equal(last().path, '/api/v1/admin/uploads/u1/publish');
  assert.deepEqual(JSON.parse(last().init.body), { previewed: true });
  assert.equal(last().init.headers['Content-Type'], 'application/json');

  assert.equal(await client.discardUpload({ uploadId: 'u1' }), null);
  assert.equal(last().method, 'DELETE');

  await client.rollbackVersion({ versionId: 1, kind: 'prevalence' });
  assert.equal(last().method, 'POST');
  assert.equal(last().path, '/api/v1/admin/versions/1/rollback');
  assert.deepEqual(last().query, { kind: 'prevalence' });
  await client.rollbackVersion({ versionId: 3 });
  assert.deepEqual(last().query, {});
  await client.rollbackVersion({ versionId: 3, everyKind: true });
  assert.deepEqual(last().query, { every_kind: 'true' });
});

test('409 publish_in_progress surfaces as its problem code', async () => {
  const { client } = mockClient(() => problemResponse(409, 'publish_in_progress', 'Another publish is running'));
  await assert.rejects(client.publishUpload({ uploadId: 'u1' }), { status: 409, code: 'publish_in_progress' });
});

test('URL builders return template and annotated-file URLs without a request', () => {
  const { client, requests } = mockClient();
  assert.equal(client.getTemplateUrl({ kind: 'prevalence', format: 'xlsx' }), '/api/v1/admin/templates/prevalence.xlsx');
  assert.equal(
    client.getTemplateUrl({ kind: 'metrics', format: 'csv', filled: true, modelVersion: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' }),
    '/api/v1/admin/templates/metrics.csv?filled=true&model_version=SynGPT-2.0&use_case=Clinician+Facing+CDSS'
  );
  assert.equal(client.getTemplateUrl({ kind: 'models', format: 'csv', filled: false }), '/api/v1/admin/templates/models.csv');
  assert.equal(client.getAnnotatedUploadUrl({ uploadId: 'u1', format: 'xlsx' }), '/api/v1/admin/uploads/u1/annotated.xlsx');
  assert.equal(requests.length, 0);
  assert.ok(matchesTemplate(operation('downloadTemplate').path, '/api/v1/admin/templates/metrics.csv'));
  assert.ok(matchesTemplate(operation('downloadAnnotatedUpload').path, '/api/v1/admin/uploads/u1/annotated.csv'));
  assert.deepEqual(operation('downloadTemplate').query.sort(), ['filled', 'model_version', 'population_id', 'use_case']); // population_id: v1.10
});

test('a custom base URL is used as given', async () => {
  const { client, last } = mockClient(undefined, { baseUrl: 'http://127.0.0.1:8123/api/v1/' });
  await client.getMeta();
  assert.equal(last().url.href, 'http://127.0.0.1:8123/api/v1/meta');
  assert.equal(client.getTemplateUrl({ kind: 'models' }), 'http://127.0.0.1:8123/api/v1/admin/templates/models.csv');
});

test('exportDataset resolves to a Blob', async () => {
  const { client, last } = mockClient(() => new Response('{"meta":{}}', { headers: { 'Content-Type': 'application/json' } }));
  const blob = await client.exportDataset({ model: 'M', useCase: 'U' });
  assert.ok(blob instanceof Blob);
  assert.equal(await blob.text(), '{"meta":{}}');
  assert.deepEqual(last().query, { model: 'M', use_case: 'U' });
});

test('queryString leaves out empty values and joins arrays', () => {
  assert.equal(queryString({}), '');
  assert.equal(queryString({ a: undefined, b: null, c: '', d: [], e: 0, f: false }), '?e=0&f=false');
  assert.equal(queryString({ selected: ['a', 'b'], q: 'x y' }), '?selected=a%2Cb&q=x+y');
});

test('concurrent /meta reads share one request; each caller keeps its own abort (B14)', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let aborted = 0;
  const requests = [];
  const fetchMock = async (input, init = {}) => {
    requests.push(String(input));
    init.signal?.addEventListener('abort', () => {
      aborted += 1;
    });
    await gate;
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return json({ dataset_version: '7' });
  };
  const client = createDataClient(createApiAdapter({ fetch: fetchMock }));
  // The selection's read (default version) and the version watch's (explicit live) are the same request.
  const first = new AbortController();
  const selection = client.getMeta({}, { signal: first.signal });
  const watch = client.getMeta({}, { version: 'live' });
  const leaving = new AbortController();
  const gone = client.getMeta({}, { signal: leaving.signal });
  leaving.abort();
  await assert.rejects(gone, { name: 'AbortError' });
  release();
  assert.equal((await selection).dataset_version, '7');
  assert.equal((await watch).dataset_version, '7');
  assert.equal(requests.length, 1, 'one request for three callers');
  assert.equal(aborted, 0, 'one caller leaving does not abort the others');
  // A later read is a fresh request (the version watch must see new versions).
  await client.getMeta();
  assert.equal(requests.length, 2);
  // A staged read is a different request.
  await client.getMeta({}, { version: 'staged:up_1' });
  assert.equal(requests.length, 3);
  // When every caller leaves, the request is aborted.
  let stop;
  const hold = new Promise((resolve) => {
    stop = resolve;
  });
  const lonely = createDataClient(
    createApiAdapter({
      fetch: (input, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          hold.then(() => resolve(json({})));
        })
    })
  );
  const only = new AbortController();
  const pending = lonely.getMeta({}, { signal: only.signal });
  only.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  stop();
});
