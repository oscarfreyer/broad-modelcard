// Contract v1.7 through the data client: the records upload, merge mode, change
// notes on publish and rollback, and the safety reads (map column, concept
// incidents, safety summary, catalogue counts). Request mapping over a mocked
// fetch, then one incident entered, checked, previewed, published, and rolled
// back on a private copy of the store.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { schemaErrors } from './support/openapiSchema.js';
import { apiClient, copyStore, startTestBackend } from './support/backend.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function mockClient() {
  const requests = [];
  const fetchMock = async (input, init = {}) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method ?? 'GET', init });
    return json({ upload_id: 'u1', status: 'checking' }, 202);
  };
  return { client: createDataClient(createApiAdapter({ fetch: fetchMock })), last: () => requests.at(-1) };
}

const INCIDENT = {
  incident_id: 'SI-CLIENT-1',
  model_version: 'SynGPT-2.0',
  use_case: 'Clinician Facing CDSS',
  codes: '5A11',
  age: 'Age 65+',
  incident_type: 'Harmful or incorrect recommendation',
  harm: 'Possible',
  status: 'Open',
  source_type: 'Incident report',
  source_reference: 'Fictional incident report (synthetic)',
  reported_date: '2026-10-01',
  summary: 'Synthetic test incident entered through the data client.'
};

test('createRecordsUpload posts JSON records as a merge', async () => {
  const { client, last } = mockClient();
  await client.createRecordsUpload({ kind: 'safety', records: [INCIDENT] });
  assert.equal(last().method, 'POST');
  assert.equal(last().path, '/api/v1/admin/uploads/records');
  assert.equal(last().init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(last().init.body), { kind: 'safety', records: [INCIDENT], mode: 'merge' });

  await client.createRecordsUpload({ kind: 'metrics', records: [{ code: '5A11' }], modelVersion: 'M', useCase: 'U', replaceStaged: true });
  assert.deepEqual(JSON.parse(last().init.body), {
    kind: 'metrics',
    records: [{ code: '5A11' }],
    mode: 'merge',
    model_version: 'M',
    use_case: 'U',
    replace_staged: true
  });
});

test('createUpload sends mode=merge, and leaves replace out', async () => {
  const { client, last } = mockClient();
  const file = new File(['x'], 'incidents.csv', { type: 'text/csv' });
  await client.createUpload({ kind: 'safety', file, mode: 'merge' });
  assert.equal(last().init.body.get('mode'), 'merge');
  await client.createUpload({ kind: 'safety', file, mode: 'replace' });
  assert.equal(last().init.body.get('mode'), null, 'replace is the default');
});

test('publish and rollback carry an optional change note', async () => {
  const { client, last } = mockClient();
  await client.publishUpload({ uploadId: 'u1', previewed: true, note: 'One incident from the form.' });
  assert.deepEqual(JSON.parse(last().init.body), { previewed: true, note: 'One incident from the form.' });
  await client.publishUpload({ uploadId: 'u1' });
  assert.deepEqual(JSON.parse(last().init.body), { previewed: false });

  await client.rollbackVersion({ versionId: 4, kind: 'safety', note: 'Entered by mistake.' });
  assert.equal(last().path, '/api/v1/admin/versions/4/rollback');
  assert.deepEqual(last().query, { kind: 'safety' });
  assert.deepEqual(JSON.parse(last().init.body), { note: 'Entered by mistake.' });
  await client.rollbackVersion({ versionId: 4 });
  assert.equal(last().init.body, undefined, 'no body without a note');
});

test('getMetricSummary passes view=safety', async () => {
  const { client, last } = mockClient();
  await client.getMetricSummary({ model: 'M', useCase: 'U', view: 'safety' });
  assert.equal(last().query.view, 'safety');
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
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = await client.getUpload({ uploadId: upload.upload_id });
  }
  return current;
}

test('one incident is entered, checked, previewed, published with a note, and rolled back', async () => {
  const card = { model: INCIDENT.model_version, useCase: INCIDENT.use_case };
  const started = performance.now();
  const before = await client.getConceptMetrics({ ...card, conceptId: '5A11' });
  assert.deepEqual(schemaErrors('getConceptMetrics', before), []);
  const known = new Set(before.incidents.map((incident) => incident.incident_id));

  const upload = await checked(await client.createRecordsUpload({ kind: 'safety', records: [INCIDENT] }));
  assert.deepEqual(schemaErrors('getUpload', upload), []);
  assert.equal(upload.status, 'valid', JSON.stringify(upload.report));
  assert.equal(upload.mode, 'merge');
  assert.equal(upload.origin, 'records');
  const changes = await client.getUploadChanges({ uploadId: upload.upload_id });
  assert.equal(changes.rows.added, 1);

  const preview = await client.getConceptMetrics({ ...card, conceptId: '5A11' }, { version: `staged:${upload.upload_id}` });
  assert.ok(preview.incidents.some((incident) => incident.incident_id === INCIDENT.incident_id && incident.severity === 'serious'));

  const published = await client.publishUpload({ uploadId: upload.upload_id, previewed: true, note: 'One incident from the form.' });
  assert.deepEqual(schemaErrors('publishUpload', published), []);
  assert.equal(published.kind, 'safety');
  assert.equal(published.note, 'One incident from the form.');
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 60_000, `entered, checked, previewed, and published in ${Math.round(elapsed)} ms`);

  const after = await client.getConceptMetrics({ ...card, conceptId: '5A11' });
  assert.deepEqual(schemaErrors('getConceptMetrics', after), []);
  const added = after.incidents.filter((incident) => !known.has(incident.incident_id));
  assert.deepEqual(added.map((incident) => [incident.incident_id, incident.severity]), [[INCIDENT.incident_id, 'serious']]);
  const younger = await client.getConceptMetrics({ ...card, conceptId: '5A11', age: 'Age 18-39' });
  assert.ok(!younger.incidents.some((incident) => incident.incident_id === INCIDENT.incident_id), 'Age 65+ only');

  const map = await client.getMetricMap({ ...card, scope: 'atlas' });
  assert.deepEqual(schemaErrors('getMetricMap', map), []);
  const safety = map.columns.indexOf('safety');
  assert.equal(map.rows.find((row) => row[0] === '5A11')[safety], 'serious');
  const summary = await client.getMetricSummary({ ...card, view: 'safety' });
  assert.deepEqual(schemaErrors('getMetricSummary', summary), []);
  assert.ok(summary.safety_counts.serious >= 1);
  const catalogue = await client.getCatalogue();
  assert.deepEqual(schemaErrors('getCatalogue', catalogue), []);
  const tile = catalogue.tiles.find((entry) => entry.card_id === `${card.model}|${card.useCase}`);
  assert.ok(tile.safety.open >= 1 && tile.safety.serious >= 1);

  const restored = await client.rollbackVersion({ versionId: published.version_id - 1, kind: 'safety', note: 'Entered by mistake.' });
  assert.deepEqual(schemaErrors('rollbackVersion', restored), []);
  assert.equal(restored.note, 'Entered by mistake.');
  const history = await client.listVersions({ kind: 'safety' });
  assert.deepEqual(history.slice(0, 2).map((entry) => entry.note), ['Entered by mistake.', 'One incident from the form.']);
  const rolledBack = await client.getConceptMetrics({ ...card, conceptId: '5A11' });
  assert.ok(!rolledBack.incidents.some((incident) => incident.incident_id === INCIDENT.incident_id));
});

test('record problems name the record', async () => {
  const upload = await checked(await client.createRecordsUpload({ kind: 'safety', records: [{ ...INCIDENT, codes: 'XX99' }] }));
  assert.equal(upload.status, 'invalid');
  const [group] = upload.report.errors;
  assert.equal(group.code, 'unknown_icd_code');
  assert.equal(group.examples[0].record, 0);
  await client.discardUpload({ uploadId: upload.upload_id });
});
