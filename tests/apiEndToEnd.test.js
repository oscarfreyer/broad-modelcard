// The app's data client against the real backend (read operations): every
// read returns the contract shape, stays within the 2 MB budget, and reports
// contract problems; the client never downloads a full metrics table.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { DataClientError, createDataClient } from '../frontend/src/api/dataClient.js';
import { schemaErrors } from './support/openapiSchema.js';
import { startTestBackend } from './support/backend.js';

const SCENARIO = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' };
const BUDGET = 2 * 1024 * 1024;

let backend;
let client;
const responses = [];

before(async () => {
  backend = await startTestBackend();
  // Record every response's size and version header.
  const recordingFetch = async (input, init) => {
    const response = await fetch(input, init);
    const bytes = (await response.clone().arrayBuffer()).byteLength;
    responses.push({ url: String(input), status: response.status, bytes, version: response.headers.get('x-dataset-version'), etag: response.headers.get('etag') });
    return response;
  };
  client = createDataClient(createApiAdapter({ baseUrl: `${backend.origin}/api/v1`, fetch: recordingFetch }));
});
after(() => backend?.stop());

const rejectsWith = (promise, status, code) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof DataClientError, `expected DataClientError, got ${error}`);
    assert.equal(error.status, status, `${code}: status`);
    assert.equal(error.code, code);
    return true;
  });

test('every read returns the contract shape from the real store', async () => {
  const meta = await client.getMeta();
  const overview = await client.getAtlasOverview();
  const largest = overview.chapters.reduce((best, chapter) => {
    const count = overview.conditions.filter((condition) => condition.chapter_id === chapter.concept_id).length;
    return !best || count > best.count ? { id: chapter.concept_id, count } : best;
  }, null);
  const reads = {
    getMeta: meta,
    listModels: await client.listModels(),
    getAtlasOverview: overview,
    getChapter: await client.getChapter({ chapterId: largest.id }),
    getMetricMap: await client.getMetricMap({ ...SCENARIO, scope: 'chapter', chapterId: largest.id }),
    getMetricSummary: await client.getMetricSummary({ ...SCENARIO, view: 'evidence' }),
    getConceptMetrics: await client.getConceptMetrics({ ...SCENARIO, conceptId: '5A11', age: 'Age 65+' }),
    getMultimorbidityCandidates: await client.getMultimorbidityCandidates({ ...SCENARIO, selected: ['5A11'], scope: 'atlas' }),
    getMultimorbidityCombination: await client.getMultimorbidityCombination({ ...SCENARIO, selected: ['5A11', '5B81'] }),
    searchConcepts: await client.searchConcepts({ q: 'diabetes', limit: 5 }),
    exportConcept: await client.exportConcept({ ...SCENARIO, conceptId: '5A11', audience: 'patient' })
  };
  for (const [operationId, response] of Object.entries(reads)) {
    assert.deepEqual(schemaErrors(operationId, response), [], operationId);
  }
  assert.equal(meta.chapters.length, 21);
  assert.match(meta.synthetic_data_notice, /synthetic/i);
  assert.equal(reads.searchConcepts.results.length, 5);
  assert.ok(reads.getMultimorbidityCandidates.has_multimorbidity);
  assert.ok(reads.getMultimorbidityCombination.metrics, 'the stored diabetes + obesity pair has a row');
  const atlasMap = await client.getMetricMap({ ...SCENARIO, scope: 'atlas' });
  assert.deepEqual(schemaErrors('getMetricMap', atlasMap), []);
  assert.equal(atlasMap.rows.length, overview.blocks.length + overview.conditions.length);
  const intendedUse = await client.getMetricSummary({ ...SCENARIO, view: 'intended_use' });
  assert.deepEqual(schemaErrors('getMetricSummary', intendedUse), []);
});

test('the metric map carries CI bounds and the concept row the evidence signal', async () => {
  const map = await client.getMetricMap({ ...SCENARIO, scope: 'atlas' });
  // safety appended in v1.7, child_count in v1.10
  assert.deepEqual(map.columns.slice(-4), ['ci_low', 'ci_high', 'safety', 'child_count']);
  const index = Object.fromEntries(map.columns.map((column, i) => [column, i]));
  const row = map.rows.find((values) => values[0] === '5A11');
  assert.equal(row[index.child_count], null, 'a condition row is not a rollup');
  assert.ok(map.rows.some((values) => values[index.child_count] > 0), 'blocks count their conditions');
  assert.ok(row[index.ci_low] <= row[index.perf] && row[index.perf] <= row[index.ci_high]);
  const concept = await client.getConceptMetrics({ ...SCENARIO, conceptId: '5A11' });
  assert.equal(typeof concept.metrics.evidence_signal, 'number');
  assert.equal(concept.metrics.ci_low, row[index.ci_low]);
});

test('responses stay within 2 MB, carry their dataset version, and no full metrics table is downloaded', async () => {
  await client.getAtlasOverview();
  await client.getMetricMap({ ...SCENARIO, scope: 'atlas', age: 'Age 65+' });
  const largest = Math.max(...responses.map((entry) => entry.bytes));
  assert.ok(largest <= BUDGET, `largest response ${largest} bytes`);
  assert.ok(responses.every((entry) => !/\.metrics\.json|data\/tables/.test(entry.url)), 'no static table requests');
  const reads = responses.filter((entry) => entry.status === 200 && !entry.url.includes('/export/'));
  assert.ok(reads.length > 10);
  assert.ok(reads.every((entry) => /^\d+$/.test(entry.version ?? '') && entry.etag), 'live reads carry X-Dataset-Version and an ETag');
});

test('a conditional request with the ETag is answered 304 (what the browser cache relies on)', async () => {
  const url = `${backend.origin}/api/v1/metrics/map?model=SynGPT-2.0&use_case=Clinician%20Facing%20CDSS&scope=atlas`;
  const first = await fetch(url);
  await first.arrayBuffer();
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const again = await fetch(url, { headers: { 'If-None-Match': first.headers.get('etag') } });
  assert.equal(again.status, 304);
});

test('contract problems reach the UI as DataClientError codes', async () => {
  await rejectsWith(client.getMetricMap({ model: 'Nope-1', useCase: 'CDSS', scope: 'atlas' }), 404, 'unknown_model');
  await rejectsWith(client.getMetricMap({ model: 'SynGPT-2.0', useCase: 'Nope', scope: 'atlas' }), 404, 'unknown_use_case');
  await rejectsWith(client.getMetricMap({ ...SCENARIO, age: 'Age 99+', scope: 'atlas' }), 422, 'invalid_lens');
  await rejectsWith(client.getConceptMetrics({ ...SCENARIO, conceptId: 'NOPE' }), 404, 'unknown_concept');
  await rejectsWith(client.getMetricMap({ ...SCENARIO, scope: 'chapter' }), 422, 'missing_chapter_id');
  await rejectsWith(client.searchConcepts({ q: '   ' }), 422, 'invalid_query');
  await rejectsWith(client.getMeta({}, { version: 'staged:no-such-upload' }), 404, 'unknown_upload');
  await rejectsWith(client.getMeta({}, { version: 'yesterday' }), 422, 'invalid_version');
  await rejectsWith(client.getUpload({ uploadId: 'no-such-upload' }), 404, 'unknown_upload');
});

test('empty results and models without multimorbidity data are answers, not errors', async () => {
  const none = await client.searchConcepts({ q: 'zzzz-no-such-condition' });
  assert.equal(none.total, 0);
  assert.deepEqual(none.results, []);
  const withoutData = await client.getMultimorbidityCandidates({ model: 'ICU_GPT-1.0', useCase: 'CDSS', selected: [], scope: 'atlas' });
  assert.equal(withoutData.has_multimorbidity, false);
  assert.deepEqual(withoutData.candidate_ids, []);
});

test('aborted reads reject with AbortError', async () => {
  const controller = new AbortController();
  const pending = client.getAtlasOverview({}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('a stopped backend is reported as backend_unavailable', async () => {
  const stopped = await startTestBackend({ fresh: true });
  const origin = stopped.origin;
  await stopped.stop();
  const orphan = createDataClient(createApiAdapter({ baseUrl: `${origin}/api/v1` }));
  await rejectsWith(orphan.getMeta(), 0, 'backend_unavailable');
});
