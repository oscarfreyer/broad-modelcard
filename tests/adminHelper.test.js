// The study helper in the Data Library (S5f; contract v1.9, CONTRACT.md §20). Helper off: the Data Library is unchanged
// and says how to turn the helper on. The API key is write-only in the page:
// never rendered back, never held in React state, never put in web storage.
// Proposals show their sources, flags, and the items left out; accepting maps
// only the ticked records, with their edits, to a merge records upload. The
// last test runs the whole path against a real backend with a stub local
// model (tests/support/assistStub.js). Components render through Vite's SSR
// loader, as in adminRecords.test.js.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import {
  configureRequest,
  describeAssistProblem,
  creditsStoredValues,
  editProblems,
  endpointOrigin,
  fieldsForReading,
  helperDetail,
  initialReview,
  isLoopbackUrl,
  keyLeftBehind,
  keyStaysWith,
  proposalSummary,
  recordTitle,
  rememberHelperEntry,
  reviewProblems,
  settingsForm,
  settingsProblems,
  stageRequest
} from '../frontend/src/features/admin/assist.js';
import { DATASETS } from '../frontend/src/features/admin/datasets.js';
import { DataClientError } from '../frontend/src/api/dataClient.js';
import { apiClient, copyStore, startTestBackend } from './support/backend.js';
import { cannedMetricsAnswer, startAssistStub } from './support/assistStub.js';

const CARD = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' };
const CANARY = 'canary-key-0123456789-never-shown';

let vite;
const load = (path) => vite.ssrLoadModule(path);
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

before(async () => {
  vite = await createServer({
    configFile: false,
    root: new URL('../frontend/', import.meta.url).pathname,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    oxc: { jsx: { runtime: 'automatic' } },
    optimizeDeps: { noDiscovery: true, include: [] }
  });
});
after(async () => {
  await vite?.close();
});

async function renderWithClient(element) {
  const { DataClientProvider } = await load('/src/api/DataClientProvider.jsx');
  return renderToStaticMarkup(h(DataClientProvider, { client: {} }, element));
}

const OFF = {
  enabled: false,
  provider: null,
  model: null,
  base_url: null,
  key_set: false,
  accepts: [],
  kinds: ['metrics', 'safety'],
  max_input_bytes: 10485760,
  updated_at: null,
  how_to_enable: 'The helper is off. To turn it on, add your own API key for a hosted model (Anthropic), or point it to a local model.',
  privacy: 'When you ask for a proposal, the study you submit … are sent to the provider you configured, and nowhere else.'
};
const HOSTED = { ...OFF, enabled: true, provider: 'hosted', model: 'claude-sonnet-5-5', key_set: true, accepts: ['pdf', 'text', 'csv', 'xlsx'], how_to_enable: null };
const LOCAL = { ...OFF, enabled: true, provider: 'local', model: 'llama3.1:8b', base_url: 'http://127.0.0.1:11434/v1', key_set: false, accepts: ['text', 'csv', 'xlsx'], how_to_enable: null };

const src = (value, location) => ({ quote: value, location });
const study = (quote, location, extra = {}) => ({ origin: 'study', source: src(quote, location), confidence: 0.95, uncertain: false, reason: null, ...extra });
const kept = (origin) => ({ origin, source: null, confidence: null, uncertain: false, reason: null });

/** Two proposed rows for the card (one uncertain) and one dropped item, as the API answers (E1, E4, E5 of the study set). */
function metricsProposals() {
  const row = (code, perf, perfField) => ({
    record: {
      code,
      age: 'All ages',
      sex: code === 'CA40' ? 'Sex Female' : 'All sexes',
      ethnicity: 'All ethnicities',
      perf,
      ci_low: null,
      ci_high: null,
      evidence_grade: 'B',
      n_samples: 1240,
      n_sites: 5,
      n_studies: 1,
      peer_reviewed_studies: 1,
      validation_type: 'Clinical study (multisite)',
      in_intended_use: 'Yes',
      intended_use_coverage: 1.0,
      intended_use_level: 'In scope',
      warnings: 'clinician_review_required',
      source: 'Harrowgate multisite evaluation (fictional)',
      study: 'HMS-2026-07',
      source_date: '2026-10-02'
    },
    fields: {
      code: study('type 2 diabetes mellitus', 'Results, page 2'),
      age: kept('default'),
      sex: code === 'CA40' ? study('mostly female', 'paragraph 1', { uncertain: true, confidence: 0.4, reason: 'The cohort is mostly, not only, female.' }) : kept('default'),
      ethnicity: kept('default'),
      perf: perfField,
      ci_low: kept('store'),
      ci_high: kept('store'),
      evidence_grade: kept('store'),
      n_samples: study('over 1,240 cases', 'Results, page 2'),
      n_sites: study('at 5 hospitals', 'Methods'),
      n_studies: study('Harrowgate multisite evaluation', 'title'),
      peer_reviewed_studies: study('(peer reviewed)', 'title'),
      validation_type: study('multisite', 'Methods'),
      in_intended_use: kept('store'),
      intended_use_coverage: kept('store'),
      intended_use_level: kept('store'),
      warnings: kept('store'),
      source: study('Harrowgate multisite evaluation (fictional)', 'title'),
      study: study('Study ID: HMS-2026-07', 'title'),
      source_date: study('Published 2026-10-02', 'title')
    },
    uncertain: perfField.uncertain || code === 'CA40',
    conditions: [{ code, name: code === '5A11' ? 'Type 2 diabetes mellitus' : 'Pneumonia' }]
  });
  return {
    kind: 'metrics',
    provider: 'hosted',
    model: 'claude-sonnet-5-5',
    dataset_version: 7,
    input: { media: 'text', bytes: 812, sha256: 'f'.repeat(64), filename: 'e1-harrowgate-medicore.txt' },
    batches: [
      {
        kind: 'metrics',
        model_version: CARD.model,
        use_case: CARD.useCase,
        records: [
          row('5A11', 0.83, study('the accuracy was 0.83', 'Results, page 2')),
          row('CA40', 0.7, study('around 0.7', 'paragraph 1', { uncertain: true, confidence: 0.6, reason: 'Approximate value (around 0.7).' }))
        ]
      }
    ],
    dropped: [
      {
        reason: 'unknown_code',
        detail: 'ZZ99 is not an ICD-11 code in the atlas; the helper does not guess another.',
        values: { code: 'ZZ99', condition: 'Grevell syndrome', perf: 0.66 },
        source: src('Grevell syndrome', 'paragraph 2')
      }
    ],
    notes: ['Grevell syndrome is described as a fictional condition.'],
    requests: 3,
    synthetic_data_notice: 'All data in Broad Modelcard is synthetic demonstration data. It is not clinical evidence.'
  };
}

function helperState(proposals, patch = {}) {
  return {
    source: 'text',
    text: '',
    file: null,
    proposals,
    review: proposals ? initialReview(proposals) : { kept: {}, edits: {}, editing: {} },
    busy: false,
    problem: null,
    stagedIds: [],
    setSource() {},
    setText() {},
    setFile() {},
    propose() {},
    cancel() {},
    clear() {},
    clearProblem() {},
    toggleKept() {},
    setEditing() {},
    setEdit() {},
    undoEdits() {},
    markStaged() {},
    ...patch
  };
}

const assistState = (status, patch = {}) => ({ status, error: null, isOpen: false, open() {}, close() {}, reload() {}, save: async () => null, turnOff: async () => true, busy: null, problem: null, clearProblem() {}, ...patch });

// ------------------------------------------------------------- helper off

test('helper off: the sidebar row says Off, and step 2 keeps its default entry', async () => {
  const { Sidebar } = await load('/src/features/admin/AdminApp.jsx');
  const html = renderToStaticMarkup(h(Sidebar, { page: 'metrics', datasets: [], onNavigate() {}, assist: assistState(OFF) }));
  assert.match(html, /Study helper/);
  assert.match(html, /sidebar-detail"[^>]*>Off</);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.equal(helperDetail(HOSTED), 'On, hosted model, claude-sonnet-5-5');
  assert.equal(helperDetail(LOCAL), 'On, local model, llama3.1:8b');
  // Without the helper the sidebar is exactly the S3 sidebar.
  assert.doesNotMatch(renderToStaticMarkup(h(Sidebar, { page: 'metrics', datasets: [], onNavigate() {} })), /Study helper/);

  const { default: UploadStep } = await load('/src/features/admin/UploadStep.jsx');
  const session = { upload: null, pendingReplace: null, busy: null, send() {} };
  const form = h('form', { 'aria-label': 'Enter one row of performance metrics' });
  const helperNode = h('div', { className: 'study-helper-stub' }, 'helper');
  const props = { dataset: DATASETS.metrics, session, disabledReason: null, mode: 'replace', onModeChange() {}, onEntryChange() {}, recordForm: form, studyHelper: helperNode };
  const fileEntry = renderToStaticMarkup(h(UploadStep, { ...props, entry: 'file' }));
  assert.match(fileEntry, /Enter one row/);
  assert.match(fileEntry, /From a study/);
  assert.match(fileEntry, /Upload a file/);
  assert.match(fileEntry, /How should this file change the data\?/, 'the file path is unchanged');
  assert.doesNotMatch(fileEntry, /study-helper-stub/, 'the helper is never the default entry');
  assert.match(renderToStaticMarkup(h(UploadStep, { ...props, entry: 'study' })), /study-helper-stub/);
  // A data set without a form has no helper either.
  assert.doesNotMatch(renderToStaticMarkup(h(UploadStep, { ...props, dataset: DATASETS.prevalence, recordForm: null, entry: 'file' })), /From a study/);

  // The page's defaults stay: Safety (and, v1.13, Studies) open on the form, metrics on the file.
  const page = readFileSync(new URL('../frontend/src/features/admin/DatasetPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /useState\(\['incident', 'study', 'effect'\]\.includes\(dataset\.recordForm\) \? 'record' : 'file'\)/);
});

test('helper off: "From a study" explains how to turn it on and what would leave the machine', async () => {
  const { default: StudyHelper } = await load('/src/features/admin/StudyHelper.jsx');
  const html = await renderWithClient(h(StudyHelper, { assist: assistState(OFF), kind: 'metrics', card: CARD, helper: helperState(null), models: [], meta: null, onStage() {}, isStaging: false }));
  assert.match(html, /The study helper is off/);
  assert.match(html, /add your own API key for a hosted model/);
  assert.match(html, /What leaves this computer once it is on/);
  assert.match(html, /nowhere else/);
  assert.match(html, /Set up the helper/);
  assert.doesNotMatch(html, /button-filled/, 'quiet: no primary button while off');
  assert.doesNotMatch(html, /Propose/);
});

// ---------------------------------------------------------- the API key

test('the key field is write-only: never rendered back, a stored key reads "A key is set"', async () => {
  const { default: HelperSettingsSheet, KeyField } = await load('/src/features/admin/HelperSettingsSheet.jsx');
  const off = await renderWithClient(h(HelperSettingsSheet, { assist: assistState(OFF) }));
  const input = off.match(/<input[^>]*type="password"[^>]*>/)?.[0];
  assert.ok(input, 'a password field while no key is stored');
  assert.doesNotMatch(input, /value=/, 'the key field is uncontrolled and starts empty');
  assert.match(input, /autoComplete="off"|autocomplete="off"/);
  assert.match(off, /A hosted model, with your own API key/);
  assert.match(off, /A local model on this computer/);
  assert.match(off, /What leaves this computer/);
  assert.match(off, />Turn on</);

  const on = await renderWithClient(h(HelperSettingsSheet, { assist: assistState(HOSTED) }));
  assert.match(on, /A key is set/);
  assert.match(on, />Replace</);
  assert.match(on, />Remove</);
  assert.doesNotMatch(on, /type="password"/, 'a stored key shows no field at all');
  assert.match(on, /Turn the helper off/);

  const replacing = renderToStaticMarkup(h(KeyField, { inputRef: { current: null }, keyKept: true, isReplacing: true, onReplace() {}, onKeep() {}, onRemove() {} }));
  assert.match(replacing, /New API key/);
  assert.match(replacing, /Keep the current key/);
  assert.doesNotMatch(replacing.match(/<input[^>]*>/)[0], /value=/);

  // The key is passed through, never held: the request carries it only when typed.
  assert.deepEqual(configureRequest({ provider: 'hosted', model: '', baseUrl: '' }), { provider: 'hosted' });
  assert.deepEqual(configureRequest({ provider: 'hosted', model: ' claude-x ', baseUrl: '' }, CANARY), { provider: 'hosted', model: 'claude-x', apiKey: CANARY });
  assert.deepEqual(configureRequest({ provider: 'local', model: 'llama3.1:8b', baseUrl: 'http://127.0.0.1:11434/v1' }), {
    provider: 'local',
    model: 'llama3.1:8b',
    baseUrl: 'http://127.0.0.1:11434/v1'
  });
  assert.deepEqual(settingsForm(HOSTED), { provider: 'hosted', model: 'claude-sonnet-5-5', baseUrl: '' });
  assert.ok(!('apiKey' in settingsForm(HOSTED)), 'the form never starts with a key');
  assert.deepEqual(Object.keys(settingsProblems({ provider: 'hosted' }, { keyTyped: false, keyKept: false })), ['apiKey']);
  assert.deepEqual(settingsProblems({ provider: 'hosted' }, { keyTyped: false, keyKept: true }), {});
  assert.deepEqual(Object.keys(settingsProblems({ provider: 'local', model: '', baseUrl: '' }, { keyTyped: false, keyKept: false })).sort(), ['baseUrl', 'model']);
});

test('a stored key stays only with its provider and address; a changed address asks for the key again', async () => {
  const GATEWAY = { ...HOSTED, base_url: 'https://gateway.example.org/anthropic' };
  const form = (provider, baseUrl, model = '') => ({ provider, model, baseUrl });
  assert.equal(endpointOrigin('hosted', ''), 'https://api.anthropic.com:443');
  assert.equal(endpointOrigin('hosted', 'https://API.anthropic.com/'), 'https://api.anthropic.com:443');
  assert.equal(endpointOrigin('local', 'http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
  assert.equal(endpointOrigin('local', 'not a url'), null);
  // Same provider and origin: kept (a path change on the same origin too).
  assert.equal(keyStaysWith(HOSTED, form('hosted', '')), true);
  assert.equal(keyStaysWith(GATEWAY, form('hosted', 'https://gateway.example.org/other')), true);
  // Another host, port, or scheme: the key is left behind, and a hosted model needs it typed again.
  for (const next of ['https://other-host.example', 'https://gateway.example.org:8443/anthropic', '']) {
    assert.equal(keyStaysWith(GATEWAY, form('hosted', next)), false, next);
    assert.equal(keyLeftBehind(GATEWAY, form('hosted', next)), true, next);
  }
  assert.deepEqual(settingsProblems(form('hosted', 'https://other-host.example'), { keyTyped: false, keyKept: false, addressChanged: true }), {
    apiKey: 'The address changed: enter the API key again.'
  });
  assert.deepEqual(settingsProblems(form('hosted', 'https://other-host.example'), { keyTyped: true, keyKept: false, addressChanged: true }), {});
  const localWithKey = { ...LOCAL, key_set: true };
  assert.equal(keyStaysWith(localWithKey, form('local', 'http://127.0.0.1:11434/v1')), true);
  assert.equal(keyLeftBehind(localWithKey, form('local', 'http://127.0.0.1:8080/v1')), true);
  // Another provider is not "the address changed": the switch notice covers it.
  assert.equal(keyLeftBehind(HOSTED, form('local', 'http://127.0.0.1:11434/v1')), false);

  // The sheet wires it: the kept key comes from keyStaysWith, and the changed address is said and required.
  const sheet = readFileSync(new URL('../frontend/src/features/admin/HelperSettingsSheet.jsx', import.meta.url), 'utf8');
  assert.match(sheet, /const keyKept = keyStaysWith\(status, form\);/);
  assert.match(sheet, /The address changed, so enter the API key again\./);
  assert.match(sheet, /settingsProblems\(form, \{ keyTyped: Boolean\(apiKey\), keyKept, addressChanged \}\)/);
});

test('a local model is on this computer: the form refuses another host before saving', () => {
  for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost:8080/v1', 'http://[::1]:11434/v1']) assert.equal(isLoopbackUrl(url), true, url);
  for (const url of ['http://192.168.1.20:11434/v1', 'https://models.example/v1', 'http://localhost.example.org/v1', 'nonsense']) assert.equal(isLoopbackUrl(url), false, url);
  const problems = settingsProblems({ provider: 'local', model: 'm', baseUrl: 'http://10.0.0.5:11434/v1' }, { keyTyped: false, keyKept: false });
  assert.deepEqual(Object.keys(problems), ['baseUrl']);
  assert.match(problems.baseUrl, /this computer: use 127\.0\.0\.1, ::1, or localhost/);
  assert.deepEqual(settingsProblems({ provider: 'local', model: 'm', baseUrl: 'http://localhost:11434/v1' }, { keyTyped: false, keyKept: false }), {});
});

test('the key never goes to web storage, state, URLs, or logs (source check of the helper modules)', () => {
  const dir = new URL('../frontend/src/features/admin/', import.meta.url);
  const sources = Object.fromEntries(readdirSync(dir).filter((name) => /\.(js|jsx)$/.test(name)).map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]));
  for (const [name, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /localStorage/, `${name}: no localStorage in the Data Library`);
    assert.doesNotMatch(source, /console\.(log|info|debug|warn|error)/, `${name}: no logging`);
    for (const match of source.matchAll(/sessionStorage\.setItem\(([^,]+),/g)) {
      // The workspace choice (contract v1.13, §26: a role and a name, never a key) is the one other entry.
      if (name === 'workspace.js' && match[1] === 'STORAGE_KEY') continue;
      assert.match(match[1], /^(CARD_KEY|ENTRY_KEY|HELPER_ENTRY_KEY) \+ upload\.upload_id$/, `${name}: sessionStorage keeps only per-upload form state and markers`);
    }
  }
  const sheet = sources['HelperSettingsSheet.jsx'];
  const keyInput = sheet.match(/<input\s+ref=\{inputRef\}[\s\S]*?\/>/)?.[0];
  assert.ok(keyInput, 'the key input takes a ref');
  assert.doesNotMatch(keyInput, /\bvalue=|onChange=/, 'the key input is uncontrolled: React state never holds the key');
  assert.match(sheet, /if \(input\) input\.value = '';/, 'the field empties as soon as the key is read');
  assert.doesNotMatch(sheet, /useState\([^)]*[Kk]ey[^)]*\)\s*;?\s*\/\/?/, 'no state named after the key value');
  assert.doesNotMatch(sources['useAssist.js'], /useState\([^)]*apiKey/);
  // The helper's marker in sessionStorage is "1", never a value from the form.
  assert.match(sources['assist.js'], /sessionStorage\.setItem\(HELPER_ENTRY_KEY \+ upload\.upload_id, '1'\)/);
});

// ------------------------------------------------------------- proposals

test('proposals show each value with its source, flag uncertain fields, and list what was left out', async () => {
  const proposals = metricsProposals();
  assert.deepEqual(proposalSummary(proposals), { records: 2, uncertainFields: 2, dropped: 1 });
  const { shown, folded } = fieldsForReading('metrics', proposals.batches[0].records[1]);
  assert.deepEqual(
    shown.map((entry) => entry.key),
    ['code', 'sex', 'perf', 'n_samples', 'n_sites', 'n_studies', 'peer_reviewed_studies', 'validation_type', 'source', 'study', 'source_date']
  );
  assert.deepEqual(
    folded.map((group) => group.label),
    ['Default', 'Kept from the stored row']
  );
  assert.deepEqual(recordTitle('metrics', proposals.batches[0].records[1].record, proposals.batches[0].records[1].conditions), {
    title: 'Pneumonia (CA40)',
    detail: 'Female'
  });

  const { default: StudyHelper } = await load('/src/features/admin/StudyHelper.jsx');
  const html = await renderWithClient(
    h(StudyHelper, { assist: assistState(HOSTED), kind: 'metrics', card: CARD, helper: helperState(proposals), models: [], meta: null, onStage() {}, isStaging: false })
  );
  const words = text(html);
  assert.match(words, /rows proposed 2/);
  assert.match(words, /fields to check 2/);
  assert.match(words, /left out 1/);
  assert.match(words, /From “e1-harrowgate-medicore\.txt” \(text, 812 bytes\), read by the hosted model claude-sonnet-5-5, 3 requests/);
  assert.match(words, /Type 2 diabetes mellitus \(5A11\)/);
  assert.match(words, /“the accuracy was 0\.83”, Results, page 2/, 'every study value carries its quote and location');
  assert.match(words, /Check: Approximate value \(around 0\.7\)\./);
  assert.match(words, /Check: The cohort is mostly, not only, female\./);
  assert.match(words, /2 to check/);
  assert.equal((html.match(/proposal-field is-uncertain/g) ?? []).length, 2, 'only the uncertain fields are flagged');
  // Stored values under this study's source: the whole row is credited to it (review S5 #9).
  assert.match(words, /Kept from the stored row, credited to this study if staged: CI low Empty; CI high Empty; Evidence grade B/);
  assert.match(words, /Left out \(1\)/);
  assert.match(words, /Code not in the atlas/);
  assert.match(words, /ZZ99 is not an ICD-11 code in the atlas/);
  assert.match(words, /Proposed: ICD-11 code ZZ99; Condition Grevell syndrome/);
  assert.match(words, /Grevell syndrome is described as a fictional condition/);
  assert.match(words, /synthetic demonstration data/);
  assert.match(words, /Staging is not publishing\./);
  assert.match(words, /Stage 2 rows as an update/);
  assert.equal((html.match(/type="checkbox"[^>]*checked=""/g) ?? []).length, 2, 'every record starts ticked');
});

test('a row that credits stored values to this study says so, with the API’s flag on Source', async () => {
  const proposals = metricsProposals();
  const entry = proposals.batches[0].records[0];
  assert.equal(creditsStoredValues('metrics', entry), true);
  const MIXED = 'Some values come from the stored row, not this study; the whole row will be credited to this study.';
  const flagged = { ...entry, fields: { ...entry.fields, source: { ...entry.fields.source, uncertain: true, reason: MIXED } }, uncertain: true };
  const { default: ProposalRecord } = await load('/src/features/admin/ProposalRecord.jsx');
  const words = text(renderToStaticMarkup(h(ProposalRecord, { id: '0:0', kind: 'metrics', entry: flagged, kept: true, edits: undefined, isEditing: false, helper: helperState(proposals), models: [], meta: null })));
  assert.match(words, /Source Harrowgate multisite evaluation \(fictional\)/);
  assert.match(words, /Check: Some values come from the stored row, not this study; the whole row will be credited to this study\./);
  assert.match(words, /Kept from the stored row, credited to this study if staged: /);
  // Nothing kept from the stored row, or no source from this study: no such line.
  const allStudy = { ...entry, fields: Object.fromEntries(Object.entries(entry.fields).map(([key, field]) => [key, field.origin === 'store' ? { ...field, origin: 'study' } : field])) };
  assert.equal(creditsStoredValues('metrics', allStudy), false);
  const noSource = { ...entry, fields: { ...entry.fields, source: { ...entry.fields.source, origin: 'default' }, study: { ...entry.fields.study, origin: 'default' }, source_date: { ...entry.fields.source_date, origin: 'default' } } };
  assert.equal(creditsStoredValues('metrics', noSource), false);
  assert.equal(creditsStoredValues('safety', entry), false);
});

test('a file the helper read only in part says so above the proposals', async () => {
  const { default: StudyHelper } = await load('/src/features/admin/StudyHelper.jsx');
  const render = (input) =>
    renderWithClient(h(StudyHelper, { assist: assistState(HOSTED), kind: 'metrics', card: CARD, helper: helperState({ ...metricsProposals(), input }), models: [], meta: null, onStage() {}, isStaging: false }));
  const base = metricsProposals().input;
  assert.match(text(await render({ ...base, truncated: true })), /The helper read only the first part of this file/);
  assert.doesNotMatch(text(await render({ ...base, truncated: false })), /read only the first part/);
  assert.doesNotMatch(text(await render(base)), /read only the first part/, 'absent means the whole file was read');
});

test('editing an uncertain field keeps its “Check:” in the amber treatment, under its source', async () => {
  const proposals = metricsProposals();
  const entry = proposals.batches[0].records[1];
  const { default: ProposalRecord } = await load('/src/features/admin/ProposalRecord.jsx');
  const html = await renderWithClient(
    h(ProposalRecord, { id: '0:1', kind: 'metrics', entry, kept: true, edits: undefined, isEditing: true, helper: helperState(proposals), models: [], meta: { axes: { age: ['All ages'], sex: ['All sexes', 'Sex Female'], ethnicity: ['All ethnicities'] } } })
  );
  const checks = html.match(/<span class="proposal-check">[\s\S]*?<\/span>/g) ?? [];
  assert.equal(checks.length, 2, 'one amber check per uncertain field (performance and sex)');
  assert.match(text(checks.join(' ')), /Check: Approximate value \(around 0\.7\)\./);
  assert.match(text(checks.join(' ')), /Check: The cohort is mostly, not only, female\./);
  assert.match(html, /“around 0\.7”, paragraph 1<br\/>/, 'the source comes first, the check on its own line');
  assert.doesNotMatch(html, /· Check:/, 'never folded into the grey hint');
});

test('accepting stages only the ticked records, with their edits, as a merge for the page card', () => {
  const proposals = metricsProposals();
  const review = initialReview(proposals);
  // Untick the uncertain row; edit the first one.
  review.kept['0:1'] = false;
  review.edits['0:0'] = { perf: '0,85', n_samples: '1300', validation_type: 'benchmark', sex: 'Sex Female' };
  const request = stageRequest(proposals, review, { card: CARD });
  assert.equal(request.kind, 'metrics');
  assert.equal(request.modelVersion, CARD.model);
  assert.equal(request.useCase, CARD.useCase);
  assert.equal(request.skipped, 0);
  assert.equal(request.records.length, 1);
  assert.deepEqual(request.records[0], {
    ...proposals.batches[0].records[0].record,
    perf: 0.85,
    n_samples: 1300,
    validation_type: 'benchmark',
    sex: 'Sex Female'
  });
  assert.ok(!('__conditions' in request.records[0]));

  // A value the page rejects blocks staging and is named.
  review.edits['0:0'] = { perf: '1.5', n_samples: '1,300' };
  assert.deepEqual(editProblems('metrics', review.edits['0:0']), { perf: 'Between 0 and 1.', n_samples: 'A whole number in digits only, e.g. 1200 (no separators).' });
  assert.equal(reviewProblems(proposals, review).length, 1);
  review.kept['0:0'] = false;
  assert.equal(reviewProblems(proposals, review).length, 0, 'an unticked record never blocks');
  assert.equal(stageRequest(proposals, review, { card: CARD }).records.length, 0);

  // A batch for another card than the page's is never staged here.
  const other = stageRequest(proposals, initialReview(proposals), { card: { model: 'MediCore-2.5', useCase: 'Clinician Facing CDSS' } });
  assert.equal(other.records.length, 0);
  assert.equal(other.skipped, 2);

  // Safety: one batch; each incident names its card; "All …" groups stay empty.
  const safety = {
    kind: 'safety',
    batches: [
      {
        kind: 'safety',
        model_version: null,
        use_case: null,
        records: [
          {
            record: { incident_id: 'AST-d7e2e990-1', model_version: 'Vantrel-Triage-2.1', use_case: 'Emergency department triage', codes: 'BA41', age: 'Age 40-64', incident_type: 'Harmful or incorrect recommendation', harm: 'Possible', summary: 'Synthetic example.' },
            fields: {},
            uncertain: false,
            conditions: [{ code: 'BA41', name: 'Acute myocardial infarction' }]
          }
        ]
      }
    ],
    dropped: []
  };
  const safetyReview = initialReview(safety);
  safetyReview.edits['0:0'] = { age: 'All ages', harm: 'occurred', codes: 'BA41; 5A11', __conditions: [] };
  const staged = stageRequest(safety, safetyReview);
  assert.deepEqual(staged, {
    kind: 'safety',
    records: [
      {
        incident_id: 'AST-d7e2e990-1',
        model_version: 'Vantrel-Triage-2.1',
        use_case: 'Emergency department triage',
        codes: 'BA41; 5A11',
        age: null,
        incident_type: 'Harmful or incorrect recommendation',
        harm: 'occurred',
        summary: 'Synthetic example.'
      }
    ],
    skipped: 0
  });
  assert.deepEqual(recordTitle('safety', safety.batches[0].records[0].record, safety.batches[0].records[0].conditions), {
    title: 'Harmful or incorrect recommendation',
    detail: 'Vantrel-Triage-2.1, Emergency department triage; Acute myocardial infarction (BA41); Age 40–64'
  });
});

test('helper failures read in plain words, with the API’s redacted detail where it helps', () => {
  const problem = (status, code, detail) => describeAssistProblem(new DataClientError({ status, code, title: code, detail }));
  assert.equal(problem(409, 'assist_not_configured').title, 'The study helper is off');
  const provider = problem(502, 'assist_provider_error', 'The provider answered 401: invalid x-api-key.');
  assert.equal(provider.title, 'The model could not be reached or gave no usable answer');
  assert.match(provider.text, /Nothing was staged/);
  assert.equal(provider.detail, 'The provider answered 401: invalid x-api-key.');
  assert.match(problem(422, 'assist_unsupported_input', 'paste the text').text, /Paste the text of the PDF/);
  assert.match(problem(413, 'upload_too_large').text, /10 MB or 200,000 characters/);
  assert.match(problem(415, 'unsupported_file_type').text, /PDF \(hosted model only\)/);
  assert.equal(problem(413, 'upload_too_large', 'secret detail').detail, null);
  const busy = problem(409, 'assist_busy', 'The helper is still reading another study.');
  assert.equal(busy.title, 'The helper is still reading another study');
  assert.match(busy.text, /one study at a time.*cancelled.*3 minutes/);
});

test('a staged helper entry that fails its check is fixed in the proposals, or proposed again after a reload', async () => {
  const { default: CheckStep } = await load('/src/features/admin/CheckStep.jsx');
  const upload = {
    upload_id: 'u-helper',
    kind: 'metrics',
    filename: 'metrics-records.csv',
    origin: 'records',
    mode: 'merge',
    status: 'invalid',
    report: { row_count: 1, errors: [{ code: 'missing_provenance', count: 1, message: 'A row has no source.', fix: 'Give Source, Study, and Source date.', examples: [] }], notes: [] }
  };
  const render = (state) => renderWithClient(h(CheckStep, { session: { upload, busy: null }, formEntry: { state, onRestart() {} } }));
  assert.match(text(await render('helper')), /Fix the values named below in the helper’s proposals above \(they are still there/);
  const lost = text(await render('helperLost'));
  assert.match(lost, /the helper’s proposals are gone/);
  assert.match(lost, /Open the study helper/);
});

test('the change summary of a helper entry says the rows came from the helper, not typed in', async () => {
  const { default: ChangesStep } = await load('/src/features/admin/ChangesStep.jsx');
  const upload = { upload_id: 'u-helper-words', kind: 'metrics', origin: 'records', mode: 'merge', status: 'valid' };
  const changes = { kind: 'metrics', base_version: 7, rows: { added: 0, changed: 1, removed: 0, samples: [] }, status_shifts: [] };
  const render = (props) => renderWithClient(h(ChangesStep, { dataset: DATASETS.metrics, target: { model: CARD.model, useCase: CARD.useCase }, upload, ...props }));
  const marked = new Set();
  const previous = globalThis.window;
  globalThis.window = { sessionStorage: { getItem: (key) => (marked.has(key) ? '1' : null), setItem: (key) => marked.add(key) } };
  try {
    assert.match(text(await render({ changes })), /Only the rows you entered, compared with the live data \(version 7\)/);
    rememberHelperEntry(upload);
    assert.match(text(await render({ changes })), /Only the rows the helper proposed and you staged, compared with the live data \(version 7\)/);
    const none = { ...changes, rows: { added: 0, changed: 0, removed: 0, samples: [] } };
    assert.match(text(await render({ changes: none })), /What you staged from the helper matches the live data exactly/);
  } finally {
    globalThis.window = previous;
  }
});

// --------------------------------------------- end to end, stub local model

test('end to end: configure a local model, propose, stage the kept rows as a merge, never publish', { timeout: 120000 }, async () => {
  const store = copyStore();
  const backend = await startTestBackend({ db: store.path });
  const stub = await startAssistStub(() => cannedMetricsAnswer({ model: CARD.model, useCase: CARD.useCase }));
  try {
    const client = apiClient(backend.origin);
    for (const entry of await client.listDatasets()) {
      for (const uploadId of entry.staged_upload_ids ?? []) await client.discardUpload({ uploadId });
    }
    const off = await client.getAssistStatus();
    assert.equal(off.enabled, false);
    assert.match(off.how_to_enable, /API key/);
    await assert.rejects(client.proposeRecords({ kind: 'metrics', text: 'Synthetic.' }), (error) => error.code === 'assist_not_configured' && error.status === 409);

    // Local model with an optional bearer key: the status never carries the key.
    const on = await client.configureAssist({ provider: 'local', model: 'stub-model', baseUrl: stub.url, apiKey: CANARY });
    assert.equal(on.enabled, true);
    assert.equal(on.key_set, true);
    assert.deepEqual(on.accepts, ['text', 'csv', 'xlsx']);
    assert.ok(!JSON.stringify(on).includes(CANARY));
    assert.ok(!JSON.stringify(await client.getAssistStatus()).includes(CANARY));

    // A PDF to a local model is refused before anything is sent.
    const before = stub.requests.length;
    const pdf = new File(['%PDF-1.4 synthetic'], 'study.pdf', { type: 'application/pdf' });
    await assert.rejects(client.proposeRecords({ kind: 'metrics', file: pdf, modelVersion: CARD.model, useCase: CARD.useCase }), (error) => error.code === 'assist_unsupported_input' && error.status === 422);
    assert.equal(stub.requests.length, before);

    const proposals = await client.proposeRecords({ kind: 'metrics', text: 'Synthetic stub study (fictional): accuracy 0.83 and around 0.7.', modelVersion: CARD.model, useCase: CARD.useCase });
    assert.equal(stub.requests.at(-1).headers.authorization, `Bearer ${CANARY}`, 'the key goes to the configured provider only');
    assert.ok(!JSON.stringify(proposals).includes(CANARY));
    assert.equal(proposals.provider, 'local');
    assert.equal(proposals.model, 'stub-model');
    assert.equal(proposals.batches.length, 1);
    assert.equal(proposals.batches[0].model_version, CARD.model);
    assert.equal(proposals.batches[0].records.length, 2);
    assert.deepEqual(proposals.dropped.map((item) => item.reason), ['unknown_code'], 'a code the atlas lacks is dropped, never guessed');
    const summary = proposalSummary(proposals);
    assert.ok(summary.uncertainFields >= 1, 'the approximate value is flagged');
    const [first] = proposals.batches[0].records;
    assert.equal(first.fields.perf.source.quote, 'accuracy was 0.83');

    // Proposing staged nothing.
    const metricsSet = (await client.listDatasets()).find((entry) => entry.kind === 'metrics');
    assert.deepEqual(metricsSet.staged_upload_ids ?? [], []);

    // Accept: only the first row, with one edit.
    const review = initialReview(proposals);
    review.kept['0:1'] = false;
    review.edits['0:0'] = { n_samples: '1300' };
    const request = stageRequest(proposals, review, { card: CARD });
    assert.equal(request.records.length, 1);
    let upload = await client.createRecordsUpload(request);
    assert.equal(upload.origin, 'records');
    assert.equal(upload.mode, 'merge');
    while (upload.status === 'checking') {
      await new Promise((resolve) => setTimeout(resolve, 50));
      upload = await client.getUpload({ uploadId: upload.upload_id });
    }
    assert.equal(upload.status, 'valid', JSON.stringify(upload.report?.errors));
    const changes = await client.getUploadChanges({ uploadId: upload.upload_id });
    assert.equal(changes.rows.added + changes.rows.changed, 1, 'one row changes; the others stay');
    assert.equal(changes.rows.removed, 0);

    // Nothing was published: the live version is unchanged, and the upload waits.
    const versions = await client.listVersions({});
    assert.ok(!versions.some((entry) => entry.upload_id === upload.upload_id));
    await client.discardUpload({ uploadId: upload.upload_id });
    assert.equal(await client.clearAssist(), null);
    assert.equal((await client.getAssistStatus()).enabled, false);
  } finally {
    await stub.stop();
    await backend.stop();
    store.dispose();
  }
});
