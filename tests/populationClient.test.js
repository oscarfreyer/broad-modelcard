// Local populations through the data client (contract v1.10, CONTRACT.md §21):
// the optional `population` param of every prevalence-dependent read, the
// upload, template, and removal methods, the query keys, and the real backend
// on a private copy of the store (upload → preview → publish → read → remove).
// Population data is synthetic and fictional.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { catalogueQuery, conceptMetricsQuery, filtersKey, metricParams } from '../frontend/src/api/queryKeys.js';
import { openapi, schemaErrors } from './support/openapiSchema.js';
import { apiClient, copyStore, startTestBackend } from './support/backend.js';

const FILTERS = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
const POPULATION = 'test-coast';

const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function mockClient() {
  const requests = [];
  const fetchMock = async (input, init = {}) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ url, path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method ?? 'GET', init });
    return json({});
  };
  return { client: createDataClient(createApiAdapter({ fetch: fetchMock })), last: () => requests.at(-1) };
}

function declaredQuery(operationId) {
  for (const item of Object.values(openapi.paths)) {
    for (const op of Object.values(item)) {
      if (op.operationId === operationId) {
        return (op.parameters ?? [])
          .map((p) => (p.$ref ? openapi.components.parameters[p.$ref.split('/').pop()] : p))
          .filter((p) => p.in === 'query')
          .map((p) => p.name);
      }
    }
  }
  throw new Error(operationId);
}

const READS = {
  getCatalogue: (client, population) => client.getCatalogue({ population }),
  getAtlasOverview: (client, population) => client.getAtlasOverview({ population }),
  getChapter: (client, population) => client.getChapter({ chapterId: 'CH-05', population }),
  getMetricMap: (client, population) => client.getMetricMap({ ...FILTERS, scope: 'atlas', population }),
  getMetricSummary: (client, population) => client.getMetricSummary({ ...FILTERS, view: 'evidence', population }),
  getConceptMetrics: (client, population) => client.getConceptMetrics({ ...FILTERS, conceptId: '5A11', population }),
  getMultimorbidityCandidates: (client, population) => client.getMultimorbidityCandidates({ ...FILTERS, scope: 'atlas', population }),
  getMultimorbidityCombination: (client, population) => client.getMultimorbidityCombination({ ...FILTERS, selected: ['5A11', 'GB61'], population }),
  searchConcepts: (client, population) => client.searchConcepts({ q: 'diabetes', population }),
  exportConcept: (client, population) => client.exportConcept({ ...FILTERS, conceptId: '5A11', population }),
  exportDataset: (client, population) => client.exportDataset({ model: FILTERS.model, useCase: FILTERS.useCase, population })
};

test('every prevalence-dependent read sends population only when it is given', async () => {
  const { client, last } = mockClient();
  for (const [operationId, read] of Object.entries(READS)) {
    assert.ok(declaredQuery(operationId).includes('population'), `${operationId} declares population`);
    await read(client, undefined);
    assert.equal('population' in last().query, false, `${operationId}: the default population is left out`);
    await read(client, POPULATION);
    assert.equal(last().query.population, POPULATION, operationId);
  }
  for (const operationId of ['getMeta', 'listModels', 'lookup']) {
    assert.equal(declaredQuery(operationId).includes('population'), false, `${operationId} takes no population query`);
  }
  await client.getCatalogue({ population: POPULATION, version: 'staged:up_1' });
  assert.deepEqual(last().query, { population: POPULATION, version: 'staged:up_1' }, 'population combines with a staged version');
});

test('the lookup names a local population in its body, never in the URL', async () => {
  const { client, last } = mockClient();
  const body = { context: { card: { model_version: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS' }, conditions: [{ code: '5A11' }], population_id: POPULATION } };
  await client.lookup(body);
  assert.deepEqual(last().query, {});
  assert.equal(JSON.parse(last().init.body).context.population_id, POPULATION);
  const context = openapi.components.schemas.LookupContext;
  assert.ok(context.properties.population_id && !context.required.includes('population_id'));
});

test('population uploads, templates, and removal map to their operations', async () => {
  const { client, last } = mockClient();
  await client.createUpload({ kind: 'population', file: new File(['x'], 'p.csv'), populationId: POPULATION, populationName: 'Test coast (fictional)' });
  const form = last().init.body;
  assert.equal(form.get('kind'), 'population');
  assert.equal(form.get('population_id'), POPULATION);
  assert.equal(form.get('population_name'), 'Test coast (fictional)');
  await client.createUpload({ kind: 'metrics', file: new File(['x'], 'm.csv'), modelVersion: 'M', useCase: 'U' });
  assert.equal(last().init.body.has('population_id'), false);

  const template = new URL(client.getTemplateUrl({ kind: 'population', filled: true, populationId: POPULATION }), 'http://localhost');
  assert.equal(template.pathname, '/api/v1/admin/templates/population.csv');
  assert.deepEqual(Object.fromEntries(template.searchParams), { filled: 'true', population_id: POPULATION });

  await client.removePopulation({ populationId: POPULATION, note: 'Not needed.' });
  assert.equal(last().method, 'POST');
  assert.equal(last().path, `/api/v1/admin/populations/${POPULATION}/remove`);
  assert.deepEqual(JSON.parse(last().init.body), { note: 'Not needed.' });
  await client.removePopulation({ populationId: POPULATION });
  assert.equal(last().init.body, undefined, 'without a note there is no body');
  assert.equal(openapi.paths['/admin/populations/{population_id}/remove'].post.operationId, 'removePopulation');
});

test('query keys carry a population only when one is set', () => {
  assert.equal(filtersKey(FILTERS), 'SynGPT-2.0|Clinician Facing CDSS|All ages|All sexes|All ethnicities', 'default keys are unchanged');
  assert.equal(filtersKey({ ...FILTERS, population: POPULATION }), `${filtersKey(FILTERS)}|population:${POPULATION}`);
  assert.deepEqual(Object.keys(metricParams(FILTERS)), ['model', 'useCase', 'age', 'sex', 'ethnicity']);
  assert.equal(metricParams({ ...FILTERS, population: POPULATION }).population, POPULATION);
  assert.notEqual(conceptMetricsQuery(FILTERS, '5A11').key, conceptMetricsQuery({ ...FILTERS, population: POPULATION }, '5A11').key);
  assert.equal(catalogueQuery({ datasetVersion: '7' }).key, 'catalogue|live|7');
  assert.equal(catalogueQuery({ datasetVersion: '7', population: POPULATION }).key, `catalogue|live|7|population:${POPULATION}`);
});

// ------------------------------------------------------------ real backend

let store;
let backend;
let client;

before(async () => {
  store = copyStore();
  backend = await startTestBackend({ db: store.path });
  client = apiClient(backend.origin);
  for (const entry of await client.listDatasets()) {
    for (const uploadId of entry.staged_upload_ids ?? []) {
      await client.discardUpload({ uploadId });
    }
  }
});
after(async () => {
  await backend?.stop();
  store?.dispose();
});

async function checked(upload) {
  let current = upload;
  while (current.status === 'checking') {
    await new Promise((resolve) => setTimeout(resolve, 50));
    current = await client.getUpload({ uploadId: upload.upload_id });
  }
  return current;
}

test('a local population goes through check and preview, and reads name it (real backend)', async () => {
  const csv = 'ICD-11 code,Commonness\n5A11,Very rare\nBA00,Rare\n';
  const upload = await checked(
    await client.createUpload({ kind: 'population', file: new File([csv], 'coast.csv', { type: 'text/csv' }), populationId: POPULATION, populationName: 'Test coast (fictional)' })
  );
  assert.equal(upload.status, 'valid', JSON.stringify(upload.report));
  assert.deepEqual(upload.target, { population_id: POPULATION, population_name: 'Test coast (fictional)' });
  const changes = await client.getUploadChanges({ uploadId: upload.upload_id });
  assert.deepEqual(schemaErrors('getUploadChanges', changes), []);
  assert.equal(changes.rows.added, 2);

  await assert.rejects(client.getConceptMetrics({ ...FILTERS, conceptId: '5A11', population: POPULATION }), { status: 404, code: 'unknown_population' });
  const preview = await client.getConceptMetrics({ ...FILTERS, conceptId: '5A11', population: POPULATION }, { version: `staged:${upload.upload_id}` });
  assert.equal(preview.concept.prevalence_tier, 'very_rare');
  assert.deepEqual(preview.population, { id: POPULATION, name: 'Test coast (fictional)' });

  const published = await client.publishUpload({ uploadId: upload.upload_id, previewed: true, note: 'Test coast.' });
  assert.equal(published.kind, 'population');
  const meta = await client.getMeta();
  // Only this test's own population counts: a demo store also holds Northbridge region.
  const own = (populations) => populations.filter(({ id }) => id === POPULATION).map(({ id, codes }) => [id, codes]);
  assert.deepEqual(own(meta.populations), [[POPULATION, 2]]);
  const others = meta.populations.filter(({ id }) => id !== POPULATION);

  const local = await client.getMetricMap({ ...FILTERS, scope: 'atlas', population: POPULATION });
  const plain = await client.getMetricMap({ ...FILTERS, scope: 'atlas' });
  assert.deepEqual(schemaErrors('getMetricMap', local), []);
  assert.equal(local.population.id, POPULATION);
  assert.equal('population' in plain, false, 'a default read does not name a population');
  const tiles = await client.getCatalogue({ population: POPULATION });
  assert.deepEqual(schemaErrors('getCatalogue', tiles), []);
  assert.equal(tiles.population.name, 'Test coast (fictional)');

  const removed = await client.removePopulation({ populationId: POPULATION, note: 'Done.' });
  assert.equal(removed.note, 'Done.');
  const afterRemoval = (await client.getMeta()).populations;
  assert.deepEqual(own(afterRemoval), []);
  assert.deepEqual(afterRemoval, others, 'other populations are left as they were');
  await assert.rejects(client.removePopulation({ populationId: POPULATION }), { status: 404, code: 'unknown_population' });
});
