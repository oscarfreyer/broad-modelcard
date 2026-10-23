// Release 0.5, phase Q8: the function categories of
// contract v1.14 in the catalogue's filters and the audience copy, the v1.14
// registry fields in "Submit an AI system" (checked as the registry upload
// checks them), and the Setting of the one-row metrics form. The last two
// tests send the forms' records to a real backend.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FUNCTION_CATEGORY_LABELS, functionCategoryLabel, functionCategoryPhrase } from '../frontend/src/shared/aiSystem.js';
import { FILTER_LABELS, filterOptions, matchesFilters, visibleTiles } from '../frontend/src/features/catalogue/catalogueModel.js';
import { EMPTY_FILTERS, FILTER_PARAMS, SORTS, TABS, catalogueSearch, parseCatalogueState } from '../frontend/src/features/catalogue/catalogueState.js';
import { ATLAS_PARAMS } from '../frontend/src/features/catalogue/pageLinks.js';
import { ENTRY_FIXES, emptyEntryFields, entryFieldProblems, entryRecordCells, toolNames } from '../frontend/src/features/admin/registryEntryFields.js';
import { emptySubmitForm, problemSummary, registryRecord, runSubmission, submitProblems } from '../frontend/src/features/admin/submitForm.js';
import { emptyMetricRow, metricRecord } from '../frontend/src/features/admin/records.js';
import { audienceSummary } from '../frontend/src/features/summary/audienceModel.js';
import { apiClient, copyStore, startTestBackend } from './support/backend.js';

const ADMIN = fileURLToPath(new URL('../frontend/src/features/admin/', import.meta.url));
const source = (name) => readFileSync(`${ADMIN}${name}`, 'utf8');

function tile(modelVersion, useCase, category, kind = 'product') {
  return {
    card_id: `${modelVersion}|${useCase}`,
    model_version: modelVersion,
    use_case: useCase,
    function_category: category,
    system: { display_name: modelVersion, kind, ai_type: 'llm', developer: 'Dev (fictional)', status: 'ACTIVE', built_on: [] },
    distribution: { overall: { strong: 1 } },
    chapters: [],
    last_updated: { version: 1, at: '2026-10-01T00:00:00Z' },
    staged_change: false
  };
}

const TILES = [
  tile('SynGPT-2.0', 'Clinician Facing CDSS', 'decision_support', 'model'),
  tile('Parlowe-Answers-1.0', 'Patient question answering', 'patient_communication'),
  tile('Tallyfern-Coding-1.4', 'Clinical coding support', 'administrative'),
  tile('Quillary-Scribe-1.0', 'Discharge letter generation', 'documentation'),
  tile('Old-1', 'Something', null, 'model')
];

// ------------------------------------------------------------ catalogue

test('the catalogue filters cards by function category, the two new ones included (G11)', () => {
  assert.equal(FILTER_LABELS.category, 'Function category');
  assert.equal(FILTER_PARAMS.category, 'category');
  assert.ok(!ATLAS_PARAMS.includes('category'), 'never an atlas parameter, so the catalogue does not forward');
  const options = filterOptions(TILES).category;
  assert.deepEqual(
    options.map((option) => [option.value, option.label, option.count]),
    [
      ['administrative', 'Administrative', 1],
      ['decision_support', 'Decision support', 1],
      ['documentation', 'Documentation', 1],
      ['patient_communication', 'Patient communication', 1]
    ],
    'every category present, by label; a card without one is not a choice'
  );
  const shown = (category) =>
    visibleTiles(TILES, { tab: TABS.performance, filters: { ...EMPTY_FILTERS, category }, sort: SORTS.name }).map((entry) => entry.model_version);
  assert.deepEqual(shown('patient_communication'), ['Parlowe-Answers-1.0']);
  assert.deepEqual(shown('administrative'), ['Tallyfern-Coding-1.4']);
  assert.equal(matchesFilters(TILES[4], { ...EMPTY_FILTERS, category: 'administrative' }), false);
  // Faceted: with Kind Model set, the product categories count 0.
  const faceted = Object.fromEntries(filterOptions(TILES, { ...EMPTY_FILTERS, kind: 'model' }).category.map((option) => [option.value, option.count]));
  assert.deepEqual(faceted, { administrative: 0, decision_support: 1, documentation: 0, patient_communication: 0 });
});

test('the category filter lives in the catalogue URL', () => {
  const state = parseCatalogueState('?category=administrative&kind=product');
  assert.equal(state.filters.category, 'administrative');
  assert.equal(parseCatalogueState('?category=Not%20a%20code!').filters.category, null);
  assert.equal(catalogueSearch({ filters: { ...EMPTY_FILTERS, category: 'patient_communication' } }), '?category=patient_communication');
  const bar = readFileSync(fileURLToPath(new URL('../frontend/src/features/catalogue/FilterBar.jsx', import.meta.url)), 'utf8');
  assert.match(bar, /category: 'All categories'/);
});

test('category words fit running text', () => {
  assert.equal(functionCategoryLabel('patient_communication'), 'Patient communication');
  assert.equal(functionCategoryLabel('administrative'), 'Administrative');
  assert.equal(functionCategoryPhrase('administrative'), 'administrative work');
  assert.equal(functionCategoryPhrase('patient_communication'), 'patient communication');
  assert.equal(functionCategoryPhrase('decision_support'), 'decision support');
  assert.equal(functionCategoryPhrase(null), null);
});

test("the patient summary says what a coding product helps with, in the card's own words", () => {
  const ready = (data) => ({ data, error: null });
  const functionEntry = {
    use_case: 'Clinical coding support',
    function_category: 'administrative',
    intended_use_defined: false,
    declarations: { declared_intended_purpose: 'Suggests diagnosis codes to clinical coders (fictional).' }
  };
  const summary = audienceSummary('patient', {
    entry: { model_version: 'Tallyfern-Coding-1.4', display_name: 'Tallyfern Coding 1.4', use_cases: [functionEntry] },
    functionEntry,
    summary: ready({ total: 10, view: 'overall', counts: { strong: 3, moderate: 2, weak: 1, out_of_scope: 0, no_data: 4 }, chapters: [] }),
    tile: ready({ card_id: 'Tallyfern-Coding-1.4|Clinical coding support', safety: { serious: 0, caution: 0, open: 0, mitigated: 0, closed: 0 } }),
    chapterCard: null,
    chapterLabels: {},
    instance: null,
    hasIntendedUse: false,
    resultFor: 'All patients, default prevalence'
  });
  const used = summary.lines.find((line) => line.id === 'used');
  assert.match(used.text, /^Tallyfern Coding 1\.4 helps with administrative work \(Clinical coding support\)\./);
  assert.doesNotMatch(JSON.stringify(summary), /decision support/i);
});

// ------------------------------------------------- Submit an AI system

const NEW_SYSTEM = {
  ...emptySubmitForm('Tallyfern Health Records (fictional)'),
  modelVersion: 'Tallyfern-Coding-2.0',
  displayName: 'Tallyfern Coding 2.0',
  useCase: 'Clinical coding support',
  kind: 'product',
  category: 'administrative',
  resultsFile: { name: 'metrics.csv' }
};

const FILLED = {
  replaces: 'Tallyfern-Coding-1.4',
  configurationId: 'cfg-tallyfern-2026-11',
  configurationDate: '2026-11-02',
  promptSummary: 'Suggests codes for a stay;\nthe coder confirms each one (fictional).',
  promptSha256: 'A'.repeat(64),
  retrieval: 'Coding rules (fictional)',
  tools: 'icd11_lookup; coding_rules_check; icd11_lookup',
  temperature: '0,1',
  topP: '1',
  maxTokens: '800',
  fineTuning: '',
  measure: 'Agreement with coded discharge diagnoses',
  referenceStandard: 'Codes set by two senior coders (fictional)',
  dataUse: 'Reads the discharge summary only (fictional).',
  dataLocation: 'Hospital network (fictional)',
  retention: 'Not kept (fictional)',
  privacyContact: 'privacy@tallyfern-health-records.example'
};

test('the form offers every function category, the two new ones included', () => {
  assert.deepEqual(Object.keys(FUNCTION_CATEGORY_LABELS), ['decision_support', 'documentation', 'image_analysis', 'triage', 'patient_communication', 'administrative']);
  const page = source('SubmitPage.jsx');
  assert.match(page, /options=\{options\(FUNCTION_CATEGORY_LABELS\)\}/);
  assert.match(page, /<RegistryEntryFields/);
  const fields = source('RegistryEntryFields.jsx');
  for (const label of [
    'Replaces', 'Configuration ID', 'Configuration date', 'Prompt summary', 'Prompt SHA-256', 'Retrieval', 'Fine-tuning', 'Tools',
    'Sampling temperature', 'Sampling top-p', 'Max output tokens', 'Performance measure', 'Reference standard',
    'Declared data use', 'Declared data location', 'Declared retention', 'Declared privacy contact'
  ]) {
    assert.match(fields, new RegExp(`label="${label}"`), label);
  }
  assert.match(fields, /Never paste the full prompt/);
  assert.match(fields, /declared by the developer, never as checked/);
});

test('the v1.14 fields are optional, and a filled one is checked as the registry upload checks it', () => {
  assert.deepEqual(emptySubmitForm('').entry, emptyEntryFields());
  assert.deepEqual(submitProblems(NEW_SYSTEM), {}, 'empty fields need nothing');
  assert.deepEqual(submitProblems({ ...NEW_SYSTEM, entry: { ...emptyEntryFields(), ...FILLED } }), {});
  const bad = {
    replaces: 'Tallyfern-Coding-2.0',
    configurationId: 'cfg 2026/11',
    configurationDate: '2026-02-30',
    promptSha256: 'not-a-checksum',
    tools: Array.from({ length: 11 }, (_, index) => `tool_${index}`).join('; '),
    temperature: '2.5',
    topP: '90%',
    maxTokens: '0',
    measure: 'x'.repeat(201),
    dataUse: 'y'.repeat(501)
  };
  const problems = submitProblems({ ...NEW_SYSTEM, entry: { ...emptyEntryFields(), ...bad } });
  assert.deepEqual(problems, {
    replaces: ENTRY_FIXES.replacesSelf,
    configurationId: ENTRY_FIXES.configurationId,
    configurationDate: ENTRY_FIXES.configurationDate,
    promptSha256: ENTRY_FIXES.promptSha256,
    tools: ENTRY_FIXES.tooMany,
    temperature: ENTRY_FIXES.temperature,
    topP: ENTRY_FIXES.topP,
    maxTokens: ENTRY_FIXES.maxTokens,
    measure: 'At most 200 characters.',
    dataUse: 'At most 500 characters.'
  });
  assert.equal(problemSummary(problems), '10 fields still need an answer. Nothing was sent.');
  assert.equal(entryFieldProblems({ tools: `${'t'.repeat(61)}; ok` }).tools, ENTRY_FIXES.toolName);
  // An AI system already listed sends no registry part, so these fields are not asked.
  assert.deepEqual(submitProblems({ ...NEW_SYSTEM, system: 'existing', existing: 'SynGPT-2.0', entry: { ...emptyEntryFields(), ...bad } }), {});
  assert.deepEqual(toolNames(' a ; b;;A ; c '), ['a', 'b', 'c']);
});

test('the registry record carries the filled v1.14 fields only', () => {
  const plain = registryRecord(NEW_SYSTEM);
  assert.equal(plain.function_category, 'Administrative');
  assert.ok(!('configuration_id' in plain) && !('replaces' in plain), 'empty fields are not sent');
  const record = registryRecord({ ...NEW_SYSTEM, entry: { ...emptyEntryFields(), ...FILLED } });
  assert.deepEqual(entryRecordCells({ ...emptyEntryFields(), ...FILLED }), {
    replaces: 'Tallyfern-Coding-1.4',
    configuration_id: 'cfg-tallyfern-2026-11',
    configuration_date: '2026-11-02',
    prompt_summary: 'Suggests codes for a stay; the coder confirms each one (fictional).',
    prompt_sha256: 'a'.repeat(64),
    retrieval: 'Coding rules (fictional)',
    tools: 'icd11_lookup; coding_rules_check',
    sampling_temperature: 0.1,
    sampling_top_p: 1,
    sampling_max_output_tokens: 800,
    performance_measure: 'Agreement with coded discharge diagnoses',
    reference_standard: 'Codes set by two senior coders (fictional)',
    declared_data_use: 'Reads the discharge summary only (fictional).',
    declared_data_location: 'Hospital network (fictional)',
    declared_retention: 'Not kept (fictional)',
    declared_privacy_contact: 'privacy@tallyfern-health-records.example'
  });
  assert.equal(record.performance_measure, 'Agreement with coded discharge diagnoses');
  assert.equal(record.model_version, 'Tallyfern-Coding-2.0');
});

test('a changed v1.14 field is sent again into the same submission', async () => {
  const calls = [];
  const client = {
    createSubmission: async () => ({ submission_id: 's-1' }),
    createRecordsUpload: async (request) => calls.push(request),
    createUpload: async (request) => calls.push(request)
  };
  const form = { ...NEW_SYSTEM, entry: { ...emptyEntryFields(), ...FILLED } };
  const first = await runSubmission(client, form);
  assert.equal(first.error, null);
  assert.equal(calls[0].kind, 'models');
  assert.equal(calls[0].records[0].configuration_id, 'cfg-tallyfern-2026-11');
  const second = await runSubmission(client, { ...form, entry: { ...form.entry, configurationId: 'cfg-tallyfern-2026-12' } }, { opened: first.opened });
  assert.equal(second.error, null);
  assert.deepEqual([calls.at(-1).kind, calls.at(-1).replaceStaged, calls.at(-1).records[0].configuration_id], ['models', true, 'cfg-tallyfern-2026-12']);
});

// --------------------------------------------- the one-row metrics form

test('the one-row metrics form sends a specific care setting as the record’s Setting', () => {
  const empty = emptyMetricRow();
  assert.equal(empty.setting, '', 'Any setting by default');
  const form = { ...empty, condition: { code: '5A11', name: 'Type 2 diabetes mellitus' }, source: 'S', study: 'T' };
  assert.ok(!('setting' in metricRecord(form)), 'Any setting sends what the form sent before');
  assert.equal(metricRecord({ ...form, setting: 'Inpatient ward' }).setting, 'Inpatient ward');
  assert.ok(!('setting' in metricRecord({ ...form, setting: 'Clinical' })), 'the Any-setting axis value is Any setting');
  const page = source('MetricRowForm.jsx');
  assert.match(page, /label="Setting"/);
  assert.match(page, /placeholder=\{ANY_SETTING_LABEL\}/);
  assert.match(page, /condition, group, and setting/);
});

// -------------------------------------------- against a real backend

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

async function checked(upload) {
  let current = upload;
  while (current.status === 'checking') {
    await new Promise((resolve) => setTimeout(resolve, 50));
    current = await client.getUpload({ uploadId: upload.upload_id });
  }
  return current;
}

test('the backend accepts the form’s registry record and finds the same problems the form names', async () => {
  const opened = await client.createSubmission({ developerName: 'Tallyfern Health Records (fictional)', modelVersion: 'Tallyfern-Coding-2.0' });
  const good = { ...registryRecord({ ...NEW_SYSTEM, entry: { ...emptyEntryFields(), ...FILLED, replaces: 'SynGPT-2.0' } }) };
  const staged = await checked(await client.createRecordsUpload({ kind: 'models', submissionId: opened.submission_id, records: [good] }));
  const codes = (staged.report?.errors ?? []).map((group) => group.code);
  assert.deepEqual(codes.filter((code) => code !== 'use_case_without_metrics'), [], JSON.stringify(staged.report?.errors));
  // The same record with the problems the form refuses: the backend names them too.
  const refusedCodes = async (record) => {
    const refused = await checked(
      await client.createRecordsUpload({ kind: 'models', submissionId: opened.submission_id, records: [record], replaceStaged: true })
    );
    return new Set((refused.report?.errors ?? []).map((group) => group.code));
  };
  const cells = await refusedCodes({ ...good, configuration_id: 'cfg 2026/11', prompt_sha256: 'not-a-checksum', sampling_temperature: 2.5 });
  for (const code of ['invalid_configuration_id', 'invalid_sha256', 'out_of_range']) {
    assert.ok(cells.has(code), `${code} in ${[...cells]}`);
  }
  assert.ok((await refusedCodes({ ...good, replaces: 'Tallyfern-Coding-2.0' })).has('replaces_self'));
});

test('a setting row from the one-row form is stored for that setting only', async () => {
  const card = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' };
  const form = {
    ...emptyMetricRow(),
    condition: { code: '5A11', name: 'Type 2 diabetes mellitus' },
    setting: 'Inpatient ward',
    source: 'Form test ward study (fictional)',
    study: 'FTS-WARD-2026'
  };
  form.values = { ...form.values, perf: '0.77', ci_low: '0.72', ci_high: '0.82', n_samples: '600', n_studies: '1', validation_type: 'clinical_study_single_site' };
  const staged = await checked(
    await client.createRecordsUpload({ kind: 'metrics', modelVersion: card.model, useCase: card.useCase, records: [metricRecord(form)], replaceStaged: true })
  );
  assert.equal(staged.status, 'valid', JSON.stringify(staged.report?.errors));
  const changes = await client.getUploadChanges({ uploadId: staged.upload_id });
  assert.deepEqual(changes.rows.settings?.map((entry) => entry.setting), ['Inpatient ward']);
  const version = `staged:${staged.upload_id}`;
  const atWard = await client.getConceptMetrics({ ...card, conceptId: '5A11', setting: 'Inpatient ward' }, { version });
  assert.equal(atWard.metrics?.perf, 0.77);
  const anySetting = await client.getConceptMetrics({ ...card, conceptId: '5A11' }, { version });
  assert.notEqual(anySetting.metrics?.perf, 0.77, 'Any setting keeps its own result');
  await client.discardUpload({ uploadId: staged.upload_id });
});
