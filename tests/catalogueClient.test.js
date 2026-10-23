// The data client's getCatalogue (contract v1.6, CONTRACT.md §17): request
// mapping over a mocked fetch, the catalogue query key, and the real backend
// (contract shape, tile counts equal to /metrics/summary, ETag revalidation).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { catalogueQuery } from '../frontend/src/api/queryKeys.js';
import { schemaErrors } from './support/openapiSchema.js';
import { apiClient, startTestBackend } from './support/backend.js';

const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function mockClient(adapterOptions = {}) {
  const requests = [];
  const fetchMock = async (input, init = {}) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), init });
    return json({ tiles: [] });
  };
  return { client: createDataClient(createApiAdapter({ fetch: fetchMock, ...adapterOptions })), requests };
}

test('getCatalogue reads /catalogue with the version from either argument', async () => {
  const { client, requests } = mockClient();
  const controller = new AbortController();

  await client.getCatalogue();
  assert.equal(requests.at(-1).path, '/api/v1/catalogue');
  assert.deepEqual(requests.at(-1).query, {}, 'live is the default and is left out');

  await client.getCatalogue({ version: 'staged:up_1', signal: controller.signal });
  assert.deepEqual(requests.at(-1).query, { version: 'staged:up_1' });
  assert.equal(requests.at(-1).init.signal, controller.signal);

  await client.getCatalogue({}, { version: 'staged:up_2', signal: controller.signal });
  assert.deepEqual(requests.at(-1).query, { version: 'staged:up_2' });
  assert.equal(requests.at(-1).init.signal, controller.signal);

  const staged = mockClient({ defaultVersion: 'staged:up_3' });
  await staged.client.getCatalogue();
  assert.deepEqual(staged.requests.at(-1).query, { version: 'staged:up_3' });
  await staged.client.getCatalogue({ version: 'live' });
  assert.deepEqual(staged.requests.at(-1).query, {}, 'a read can ask for live data explicitly');
});

test('catalogueQuery keys by version and dataset version and passes the signal', async () => {
  assert.equal(catalogueQuery().key, 'catalogue|live|');
  assert.equal(catalogueQuery({ datasetVersion: '5' }).key, 'catalogue|live|5');
  assert.notEqual(catalogueQuery({ datasetVersion: '5' }).key, catalogueQuery({ datasetVersion: '6' }).key);
  assert.equal(catalogueQuery({ version: 'staged:up_1' }).key, 'catalogue|staged:up_1|');

  const { client, requests } = mockClient();
  const controller = new AbortController();
  await catalogueQuery({ version: 'staged:up_1' }).fetch(client, { signal: controller.signal });
  assert.deepEqual(requests.at(-1).query, { version: 'staged:up_1' });
  assert.equal(requests.at(-1).init.signal, controller.signal);
});

// ------------------------------------------------------------ real backend

let backend;
before(async () => {
  backend = await startTestBackend();
});
after(() => backend?.stop());

test('the real catalogue has the contract shape and the atlas counts', async () => {
  const client = apiClient(backend.origin);
  const [catalogue, registry, meta] = await Promise.all([client.getCatalogue(), client.listModels(), client.getMeta()]);
  assert.deepEqual(schemaErrors('getCatalogue', catalogue), []);
  assert.equal(catalogue.dataset_version, meta.dataset_version);
  const cards = registry.models.flatMap((model) => model.use_cases.map((useCase) => `${model.model_version}|${useCase.use_case}`));
  assert.deepEqual(catalogue.tiles.map((tile) => tile.card_id), cards, 'one tile per configuration, in registry order');

  for (const tile of catalogue.tiles) {
    assert.equal(tile.chapters.length, meta.chapters.length);
    const params = { model: tile.model_version, useCase: tile.use_case };
    const [overall, intendedUse] = await Promise.all([
      client.getMetricSummary({ ...params, view: 'overall' }),
      client.getMetricSummary({ ...params, view: 'intended_use' })
    ]);
    assert.deepEqual(tile.distribution.overall, overall.counts, tile.card_id);
    assert.deepEqual(tile.distribution.intended_use, { ...intendedUse.intended_use_counts, no_data: intendedUse.counts.no_data }, tile.card_id);
  }
});

test('the catalogue revalidates with its ETag', async () => {
  const url = `${backend.origin}/api/v1/catalogue`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.ok(first.headers.get('x-dataset-version'));
  const again = await fetch(url, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.ok((await first.arrayBuffer()).byteLength < 300_000, 'within the 300 KB budget');
});
