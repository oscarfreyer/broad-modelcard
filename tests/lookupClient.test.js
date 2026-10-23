// Contract v1.8: the live interaction plugin's lookup through the data client
// (CONTRACT.md §19). Request mapping over a mocked fetch (POST, body as given,
// only the version in the query), then against a real backend started with
// debug logging: the response validates, equals the atlas card reads at the same
// lens, its card links are the atlas URLs startupParams.js writes, and nothing
// of the request body reaches the server's log output.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { DataClientError, createDataClient } from '../frontend/src/api/dataClient.js';
import { atlasSearch, parseStartupParams, readableSearch } from '../frontend/src/app/startupParams.js';
import { isStateUrl, withProfileDefaults } from '../frontend/src/app/profileDefaults.js';
import { schemaErrors } from './support/openapiSchema.js';
import { apiClient, freePort } from './support/backend.js';
import { setupProblem, spawnBackend, stopProcess, waitForBackend } from '../scripts/backendServer.mjs';

const ICD11 = 'http://id.who.int/icd/release/11/mms';
const CARD = { model_version: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS' };

const lookupBody = (codes, population) => ({
  hook: 'broad-modelcard-lookup',
  context: { card: CARD, conditions: codes.map((code) => ({ system: ICD11, code })), ...(population ? { population } : {}) }
});

function mockClient() {
  const requests = [];
  const fetchMock = async (input, init = {}) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ url, path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method ?? 'GET', init });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { client: createDataClient(createApiAdapter({ fetch: fetchMock })), last: () => requests.at(-1) };
}

test('lookup posts the body as given and puts only the version into the URL', async () => {
  const { client, last } = mockClient();
  const body = lookupBody(['5A11', 'GB61'], { age_group: '65+', sex: 'female', ethnicity: null });
  await client.lookup(body);
  assert.equal(last().method, 'POST');
  assert.equal(last().path, '/api/v1/lookup');
  assert.deepEqual(last().query, {}, 'live reads send no query');
  assert.equal(last().init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(last().init.body), body);

  const controller = new AbortController();
  await client.lookup(body, { version: 'staged:up_1', signal: controller.signal });
  assert.deepEqual(last().query, { version: 'staged:up_1' });
  assert.equal(last().init.signal, controller.signal);
  for (const value of ['5A11', '65+', 'female', 'SynGPT']) {
    assert.ok(!decodeURIComponent(last().url.href).includes(value), `${value} stays out of the URL`);
  }
});

// ------------------------------------------------------------ real backend

let backend;
let client;
let output = '';

before(async () => {
  const problem = setupProblem(process.env);
  if (problem) {
    throw new Error(`The lookup client test needs the backend.\n${problem}`);
  }
  const port = await freePort();
  // Debug logging, so the access log and every application log line are captured.
  const child = spawnBackend({ port, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], args: ['--log-level', 'debug'] });
  const collect = (chunk) => {
    output += chunk;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const kill = () => child.kill('SIGKILL');
  process.once('exit', kill);
  await waitForBackend(port, { child, timeoutMs: 60000 });
  backend = { origin: `http://127.0.0.1:${port}`, stop: () => stopProcess(child).then(() => process.removeListener('exit', kill)) };
  client = apiClient(backend.origin);
});

after(async () => {
  await backend?.stop();
});

const lens = { age: 'Age 65+', sex: 'Sex Female', ethnicity: 'All ethnicities' };
const query = { model: CARD.model_version, useCase: CARD.use_case, ...lens };

test('the lookup validates and equals the atlas card at the same lens', async () => {
  const result = await client.lookup(lookupBody(['5A11', 'GB61', '1A03.0', 'ZZ99'], { age_group: '65+', sex: 'female' }));
  assert.deepEqual(schemaErrors('lookup', result), []);
  assert.equal(result.disclaimer, 'Demonstration on synthetic data. Not for clinical use.');
  assert.match(result.synthetic_data_notice, /synthetic/);
  assert.deepEqual(result.lens, { context: 'Clinical', ...lens });
  assert.deepEqual(result.conditions.at(-1), { code: 'ZZ99', matched: false });

  for (const condition of result.conditions.filter(({ matched }) => matched)) {
    const card = await client.getConceptMetrics({ ...query, conceptId: condition.concept_id });
    assert.equal(card.dataset_version, result.dataset_version);
    assert.deepEqual(condition.statuses, { ...card.metrics.status, intended_use: card.metrics.intended_use_level });
    assert.deepEqual(condition.warnings, card.metrics.warnings);
    assert.deepEqual(condition.safeguards, card.metrics.safeguards);
    assert.deepEqual(condition.incidents, card.incidents);
    assert.deepEqual(condition.provenance, card.metrics.provenance);
  }
});

test('card links are the atlas URLs startupParams.js writes and reads', async () => {
  const result = await client.lookup(lookupBody(['5A11', '1A03.0'], { age_group: '65+', sex: 'female' }));
  // Every link names the view of the figures it reports (CONTRACT.md §19).
  const state = { model: CARD.model_version, useCase: CARD.use_case, view: 'overall', lens };
  const href = (url) => {
    assert.match(url, /^atlas\.html\?/, 'relative to the frontend root');
    return url.slice('atlas.html'.length);
  };
  assert.equal(href(result.card.card_url), readableSearch(atlasSearch(state)));

  const [top, deeper] = result.conditions;
  assert.equal(href(top.card_url), readableSearch(atlasSearch({ ...state, conceptId: '5A11' })));
  assert.equal(href(deeper.card_url), readableSearch(atlasSearch({ ...state, chapterId: 'CH-01', conceptId: '1A03.0' })));
  const parsed = parseStartupParams(href(deeper.card_url));
  assert.equal(parsed.model, CARD.model_version);
  assert.equal(parsed.useCase, CARD.use_case);
  assert.deepEqual(parsed.lens, { age: 'Age 65+', sex: 'Sex Female', ethnicity: null });
  assert.equal(parsed.chapterId, 'CH-01');
  assert.equal(parsed.conceptId, '1A03.0');
  assert.equal(parsed.view, 'overall');
});

test('a lookup link opens the figures it reports for every reader, whatever their defaults', async () => {
  // A reader whose profile names a local population, another lens, and a depth.
  const readerDefaults = { card: { model: 'Other', useCase: 'Other' }, lens: { age: 'Age 0-17' }, depth: 'expert', population: 'northbridge-region' };
  const result = await client.lookup(lookupBody(['5A11']));
  for (const url of [result.card.card_url, result.conditions[0].card_url]) {
    const parsed = parseStartupParams(url.slice('atlas.html'.length));
    assert.equal(isStateUrl(parsed), true, url);
    const opened = withProfileDefaults(parsed, readerDefaults);
    assert.deepEqual(opened.appliedDefaults, [], 'no default applies to a link that reports figures');
    assert.deepEqual(
      [opened.model, opened.useCase, opened.view, opened.population, opened.depth, opened.lens],
      [CARD.model_version, CARD.use_case, 'overall', null, null, { age: null, sex: null, ethnicity: null }]
    );
  }
});

test('a stored combination equals the multimorbidity read and links to multimorbidity mode', async () => {
  const { candidate_ids: candidates } = await client.getMultimorbidityCandidates({ ...query, scope: 'atlas', selected: ['5A11'] });
  assert.ok(candidates.length > 0, 'the store has a stored pair with 5A11');
  const partner = candidates[0];
  const result = await client.lookup(lookupBody(['5A11', partner], { age_group: '65+', sex: 'female' }));
  assert.deepEqual(schemaErrors('lookup', result), []);
  const stored = await client.getMultimorbidityCombination({ ...query, selected: ['5A11', partner] });
  const { combination } = result;
  assert.equal(combination.combination_key, stored.combination_key);
  assert.equal(combination.label, stored.combination_label);
  assert.deepEqual(combination.concept_ids, ['5A11', partner]);
  assert.deepEqual(combination.statuses, { ...stored.metrics.status, intended_use: stored.metrics.intended_use_level });
  assert.deepEqual(combination.warnings, stored.metrics.warnings);
  assert.deepEqual(combination.safeguards, stored.metrics.safeguards);
  const state = { model: CARD.model_version, useCase: CARD.use_case, view: 'overall', lens, mode: 'multimorbidity', selectedIds: ['5A11', partner] };
  assert.equal(combination.card_url, `atlas.html${readableSearch(atlasSearch(state))}`);
});

test('unknown keys and free text are rejected with problem details', async () => {
  const withName = lookupBody(['5A11']);
  withName.context.population = { age_group: '65+', name: 'Synthetic Person' };
  await assert.rejects(client.lookup(withName), (error) => {
    assert.ok(error instanceof DataClientError);
    assert.equal(error.status, 422);
    assert.equal(error.code, 'invalid_parameter');
    assert.ok(!error.message.includes('Synthetic Person'));
    return true;
  });
  await assert.rejects(client.lookup(lookupBody(['type 2 diabetes'])), (error) => error.code === 'invalid_selection');
  await assert.rejects(client.lookup(lookupBody([])), (error) => error.code === 'invalid_selection');
  const unknown = lookupBody(['5A11']);
  unknown.context.card = { model_version: 'Nope-1', use_case: 'CDSS' };
  await assert.rejects(client.lookup(unknown), (error) => error.status === 404 && error.code === 'unknown_model');
});

test('the request body never reaches the server log', async () => {
  const marker = 'QX7Z9';
  const secret = 'Synthetic-Case-4711';
  await client.lookup(lookupBody([marker, '5A11'], { age_group: '40-64', ethnicity: 'hispanic' }));
  const withToken = { ...lookupBody([marker]), fhirAuthorization: { access_token: secret } };
  await assert.rejects(client.lookup(withToken), (error) => error.code === 'invalid_parameter');
  await assert.rejects(client.lookup(lookupBody([`${marker} ${secret}`])), (error) => error.code === 'invalid_selection');
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the log lines arrive
  assert.match(output, /POST \/api\/v1\/lookup/, 'the access log is captured');
  for (const value of [marker, secret, '40-64', 'hispanic', 'Synthetic-Case']) {
    assert.ok(!output.includes(value), `${value} must not be logged`);
  }
});
