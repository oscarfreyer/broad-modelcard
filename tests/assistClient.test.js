// Contract v1.9: assisted data entry through the data client (CONTRACT.md §20),
// over a mocked fetch: the helper's operations map onto the admin API, the key
// is sent only on configure, and a proposal is a multipart form. Accepting a
// proposal is the existing createRecordsUpload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';

function mockClient(answer = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })) {
  const requests = [];
  const fetchMock = async (input, init = {}) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ url, path: url.pathname, method: init.method ?? 'GET', init });
    return answer(url, init);
  };
  return { client: createDataClient(createApiAdapter({ fetch: fetchMock })), requests, last: () => requests.at(-1) };
}

test('status, configure, and clear map onto /admin/assist', async () => {
  const { client, last } = mockClient((url, init) =>
    init.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response('{"enabled":false}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  );
  assert.deepEqual(await client.getAssistStatus(), { enabled: false });
  assert.equal(last().path, '/api/v1/admin/assist');
  assert.equal(last().method, 'GET');

  await client.configureAssist({ provider: 'hosted', apiKey: 'sk-test-not-a-real-key' });
  assert.equal(last().method, 'PUT');
  assert.deepEqual(JSON.parse(last().init.body), { provider: 'hosted', api_key: 'sk-test-not-a-real-key' });
  assert.ok(!last().url.href.includes('sk-test'), 'the key never goes into the URL');

  await client.configureAssist({ provider: 'local', model: 'llama3.1:8b', baseUrl: 'http://127.0.0.1:11434/v1' });
  assert.deepEqual(JSON.parse(last().init.body), { provider: 'local', model: 'llama3.1:8b', base_url: 'http://127.0.0.1:11434/v1' });

  assert.equal(await client.clearAssist(), null);
  assert.equal(last().method, 'DELETE');
});

test('proposeRecords posts one study as a form; accepting uses createRecordsUpload', async () => {
  const { client, last } = mockClient();
  const file = new File(['Synthetic study (fictional).'], 'study.txt', { type: 'text/plain' });
  await client.proposeRecords({ kind: 'metrics', file, modelVersion: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' });
  assert.equal(last().path, '/api/v1/admin/assist/proposals');
  assert.equal(last().method, 'POST');
  const form = last().init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('kind'), 'metrics');
  assert.equal(form.get('file').name, 'study.txt');
  assert.equal(form.get('model_version'), 'SynGPT-2.0');
  assert.equal(form.get('text'), null);

  await client.proposeRecords({ kind: 'safety', text: 'Synthetic incident (fictional).' });
  assert.equal(last().init.body.get('text'), 'Synthetic incident (fictional).');
  assert.equal(last().init.body.get('file'), null);

  const batch = { kind: 'metrics', model_version: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS', records: [{ record: { code: '5A11' } }] };
  await client.createRecordsUpload({ kind: batch.kind, modelVersion: batch.model_version, useCase: batch.use_case, records: batch.records.map((r) => r.record) });
  assert.equal(last().path, '/api/v1/admin/uploads/records');
  assert.deepEqual(JSON.parse(last().init.body), { kind: 'metrics', records: [{ code: '5A11' }], mode: 'merge', model_version: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS' });
});
