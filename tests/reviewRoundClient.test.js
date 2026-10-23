// Contract v1.11 through the data client:
// listIncidents, the catalogue snapshot as `snapshot.blocks`, no
// `not_validated` anywhere, and the no-change rollback. Request mapping over a
// mocked fetch, then the real backend on a private copy of the store.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { withSnapshotBlocks } from '../frontend/src/api/catalogueSnapshot.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { schemaErrors } from './support/openapiSchema.js';
import { apiClient, copyStore, startTestBackend } from './support/backend.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function mockClient(body = {}) {
  const requests = [];
  const fetchMock = async (input, init = {}) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method ?? 'GET' });
    return json(body);
  };
  return { client: createDataClient(createApiAdapter({ fetch: fetchMock })), last: () => requests.at(-1) };
}

test('listIncidents reads the admin incident list with the card and version', async () => {
  const { client, last } = mockClient({ dataset_version: '3', incidents: [] });
  await client.listIncidents();
  assert.equal(last().path, '/api/v1/admin/safety/incidents');
  assert.deepEqual(last().query, {});
  await client.listIncidents({ model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' });
  assert.deepEqual(last().query, { model: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS' });
  await client.listIncidents({ model: 'SynGPT-2.0', version: 'staged:up_1' });
  assert.deepEqual(last().query, { model: 'SynGPT-2.0', version: 'staged:up_1' });
});

test('withSnapshotBlocks adds one object per subchapter and keeps the wire arrays', () => {
  const catalogue = {
    snapshot_blocks: [{ id: 'B1', chapter: 'CH-01' }, { id: 'B2', chapter: 'CH-02' }],
    tiles: [
      { card_id: 'A|F', snapshot: { overview: ['strong', 'no_data'], safety: [null, 'serious'] } },
      { card_id: 'B|F' }
    ]
  };
  const expanded = withSnapshotBlocks(catalogue);
  assert.deepEqual(expanded.tiles[0].snapshot.blocks, [
    { id: 'B1', chapter: 'CH-01', overview: 'strong', safety: null },
    { id: 'B2', chapter: 'CH-02', overview: 'no_data', safety: 'serious' }
  ]);
  assert.deepEqual(expanded.tiles[0].snapshot.overview, ['strong', 'no_data']);
  assert.equal(expanded.tiles[1].snapshot, undefined, 'a tile without a snapshot is left as it is');
  assert.equal(catalogue.tiles[0].snapshot.blocks, undefined, 'the input is not changed');
  assert.equal(withSnapshotBlocks({ tiles: [] }).tiles.length, 0);
});

test('getCatalogue resolves with snapshot blocks', async () => {
  const { client } = mockClient({ snapshot_blocks: [{ id: 'B1', chapter: 'CH-01' }], tiles: [{ snapshot: { overview: ['weak'], safety: ['caution'] } }] });
  const catalogue = await client.getCatalogue();
  assert.deepEqual(catalogue.tiles[0].snapshot.blocks, [{ id: 'B1', chapter: 'CH-01', overview: 'weak', safety: 'caution' }]);
});

// ------------------------------------------------------------ real backend

let store;
let backend;
let client;

before(async () => {
  store = copyStore();
  backend = await startTestBackend({ db: store.path });
  client = apiClient(backend.origin);
});
after(async () => {
  await backend?.stop();
  store?.dispose();
});

test('the real catalogue has one snapshot block per subchapter on every tile', async () => {
  const [catalogue, overview] = await Promise.all([client.getCatalogue(), client.getAtlasOverview()]);
  assert.deepEqual(schemaErrors('getCatalogue', catalogue), []);
  assert.deepEqual(catalogue.snapshot_blocks.map((block) => block.id), overview.blocks.map((block) => block.concept_id), 'atlas order');
  for (const tile of catalogue.tiles) {
    assert.equal(tile.snapshot.blocks.length, catalogue.snapshot_blocks.length, tile.card_id);
    assert.equal(typeof tile.intended_use_defined, 'boolean');
  }
  assert.ok(!JSON.stringify(catalogue).includes('not_validated'));
});

test('listIncidents lists every stored incident and validates', async () => {
  const body = await client.listIncidents();
  assert.deepEqual(schemaErrors('listIncidents', body), []);
  assert.ok(Array.isArray(body.incidents));
});

test('a rollback that would change nothing is refused with rollback_no_change', async () => {
  const [latest] = await client.listVersions();
  await assert.rejects(
    client.rollbackVersion({ versionId: latest.version_id, kind: 'models' }),
    (error) => error.status === 409 && error.code === 'rollback_no_change'
  );
  const [still] = await client.listVersions();
  assert.equal(still.version_id, latest.version_id, 'no version was added');
});
