// Release 0.5 phase Q7 (contract v1.14, CONTRACT.md §32, §33): the card
// record download, evaluation results imports, and the CDS Hooks mode of the
// live interaction page. React-free modules and the data client over a mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { STATIC_UNAVAILABLE, createStaticAdapter } from '../frontend/src/api/staticAdapter.js';
import { CARD_RECORD_COPY, cardRecordFilename } from '../frontend/src/features/summary/cardRecord.js';
import {
  EVALUATION_FORMAT,
  MAX_EVALUATION_BYTES,
  evaluationExample,
  evaluationState,
  proposalRows,
  readEvaluationFile,
  stageEvaluation,
  studyLine
} from '../frontend/src/features/admin/evaluations.js';
import { PART_WORDS, partState } from '../frontend/src/features/admin/submissions.js';
import { emptySubmitForm, runSubmission, submissionParts } from '../frontend/src/features/admin/submitForm.js';
import {
  ICD10CM_SYSTEM,
  ICD11_SYSTEM,
  cdsCodes,
  cdsRequest,
  detailParagraphs,
  parseIcd10cmCodes,
  syntheticBirthDate
} from '../frontend/src/features/plugin/cdsHooks.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const PROPOSALS = Object.freeze({
  upload_id: 'up-1',
  model_version: 'MediCore-2.5',
  use_case: 'Clinician Facing CDSS',
  study: { study_id: 'EVAL-BENCH-1-0-20261018', title: 'Bench (fictional) 1.0: evaluation of MediCore 2.5', conducted_by: 'independent', patients: 300, sites: 2, publication_date: '2026-10-18' },
  metrics: {
    model_version: 'MediCore-2.5',
    use_case: 'Clinician Facing CDSS',
    records: [
      { code: '5A11', age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities', perf: 0.8, ci_low: 0.7, ci_high: 0.86, n_samples: 200 },
      { code: 'BA41', age: 'Age 65+', sex: 'All sexes', ethnicity: 'All ethnicities', perf: 0.7, ci_low: null, ci_high: null, n_samples: 100 }
    ]
  },
  results: [
    { result: 0, code: '5A11', concept_id: '5A11', measure: 'Top-3 diagnostic accuracy' },
    { result: 1, code: 'BA41.Z', concept_id: 'BA41', measure: 'Top-3 diagnostic accuracy' }
  ],
  notes: []
});

function stubClient({ conflict = [], fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async createRecordsUpload(request) {
      calls.push(request);
      const part = request.kind === 'studies' ? 'study' : 'metrics';
      if (fail === part) throw Object.assign(new Error('Down'), { code: 'backend_unavailable' });
      if (conflict.includes(part) && !request.replaceStaged) throw Object.assign(new Error('Waiting'), { code: 'staged_upload_exists' });
      return { upload_id: `up-${calls.length}`, kind: request.kind, status: 'checking', target: request.modelVersion ? { model_version: request.modelVersion, use_case: request.useCase } : null };
    }
  };
}

test('the card record downloads under a plain file name, and the Summary offers it (in the static build without the dataset export)', () => {
  assert.equal(cardRecordFilename('SynGPT-2.0', 'Clinician Facing CDSS'), 'broad-modelcard-card-record-syngpt-2-0-clinician-facing-cdss.json');
  assert.equal(CARD_RECORD_COPY.button, 'Card record (JSON)');
  assert.match(CARD_RECORD_COPY.hint, /Synthetic data, not a certification/);
  const atlas = read('../frontend/src/app/AtlasApp.jsx');
  assert.match(atlas, /onClick: IS_STATIC_BUILD \? null : handleExportDataset,[^}]*onCardRecord: handleExportCardRecord/);
  assert.match(atlas, /client\.getCardRecord\(\{ model: filters\.model, useCase: filters\.useCase \}\)/);
  assert.match(read('../frontend/src/features/summary/SummaryPanel.jsx'), /datasetExport\.onCardRecord \? <CardRecordExport/);
});

test('the data client reads the record, calls the CDS Hooks service in a POST body, and imports evaluation results', async () => {
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': url.searchParams.get('format') === 'jsonld' ? 'application/ld+json' : 'application/json' } });
  };
  const client = createDataClient(createApiAdapter({ fetch }));
  await client.getCardRecord({ model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' });
  assert.equal(requests.at(-1).url.pathname, '/api/v1/cards/record');
  assert.deepEqual(Object.fromEntries(requests.at(-1).url.searchParams), { model: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS' });
  await client.getCardRecord({ model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', format: 'jsonld' });
  assert.equal(requests.at(-1).url.searchParams.get('format'), 'jsonld');
  await client.getCdsServices();
  assert.equal(requests.at(-1).url.pathname, '/api/v1/cds-services');
  const body = cdsRequest({ model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', codesText: '5A11', lens: { age_group: '65+', sex: 'female' } });
  await client.callCdsService(body);
  const call = requests.at(-1);
  assert.equal(call.method, 'POST');
  assert.equal(call.url.pathname, '/api/v1/cds-services/bmc-condition-status');
  assert.equal(call.url.search, '', 'the case never travels in the URL');
  assert.deepEqual(call.body, body);
  await client.createEvaluationUpload({ content: '{}', filename: 'run.json', submissionId: 'sub-1', replaceStaged: true });
  assert.deepEqual(requests.at(-1).body, { content: '{}', filename: 'run.json', submission_id: 'sub-1', replace_staged: true });
  await client.getEvaluationProposals({ uploadId: 'up-9' });
  assert.equal(requests.at(-1).url.pathname, '/api/v1/admin/uploads/up-9/evaluation-proposals');
});

test('the static demo offers none of the new operations but the recorded card record', async () => {
  const adapter = createStaticAdapter({ fetch: async () => ({ ok: false }) });
  // The card record is recorded per card (Q9): a card the snapshot lacks says so.
  for (const name of ['getCardRecord', 'getCdsServices', 'callCdsService', 'createEvaluationUpload', 'getEvaluationProposals']) {
    await assert.rejects(adapter[name]({}), (error) => error.code === STATIC_UNAVAILABLE, name);
  }
});

test('proposed records read as rows, a study line, and check states', () => {
  const rows = proposalRows(PROPOSALS);
  assert.deepEqual(rows.map((row) => [row.code, row.conceptId, row.group, row.interval]), [
    ['5A11', '5A11', 'All patients', '0.7–0.86'],
    ['BA41.Z', 'BA41', 'Age 65+', null]
  ]);
  assert.match(studyLine(PROPOSALS.study), /EVAL-BENCH-1-0-20261018: benchmark run by an independent group, 300 cases at 2 sites/);
  assert.match(studyLine(PROPOSALS.study), /Risk of bias Unclear until a reviewer judges it/);
  assert.equal(evaluationState({ status: 'valid', report: { notes: [{}] } }).word, 'Ready, 1 note');
  assert.equal(evaluationState({ status: 'invalid', report: { errors: [{ count: 2 }] } }).word, 'Needs a fix: 2 problems');
  assert.equal(partState({ kind: 'evaluation_results', status: 'published' }).word, 'Records published');
  assert.equal(PART_WORDS.evaluation_results, 'Evaluation results');
});

test('staging sends the study first, then the ticked rows; a waiting update is asked about', async () => {
  const client = stubClient();
  const outcome = await stageEvaluation(client, PROPOSALS, { recordIndexes: [1] });
  assert.deepEqual(client.calls.map((call) => call.kind), ['studies', 'metrics']);
  assert.deepEqual(client.calls[0].records, [PROPOSALS.study]);
  assert.deepEqual(client.calls[1].records.map((record) => record.code), ['BA41']);
  assert.equal(client.calls[1].modelVersion, 'MediCore-2.5');
  assert.deepEqual(outcome.created.map((item) => item.part), ['study', 'metrics']);

  const busy = stubClient({ conflict: ['study'] });
  const first = await stageEvaluation(busy, PROPOSALS, { submissionId: 'sub-1' });
  assert.deepEqual(first.conflicts, ['study']);
  assert.ok(busy.calls.every((call) => call.submissionId === 'sub-1'));
  const second = await stageEvaluation(busy, PROPOSALS, { replaceStaged: ['study'], recordIndexes: [] });
  assert.equal(second.conflicts.length, 0);
  assert.equal(busy.calls.at(-1).replaceStaged, true);

  const failing = stubClient({ fail: 'study' });
  const stopped = await stageEvaluation(failing, PROPOSALS);
  assert.equal(stopped.error.code, 'backend_unavailable');
  assert.equal(failing.calls.length, 1, 'nothing after a failure');
});

test('an evaluation results file is read whole or refused, and the example is in the format', async () => {
  const example = JSON.parse(evaluationExample({ modelVersion: 'MediCore-2.5', useCase: 'Clinician Facing CDSS', configurationId: 'cfg-1' }));
  assert.equal(example.format, EVALUATION_FORMAT);
  assert.equal(example.model_version, 'MediCore-2.5');
  assert.ok(example.benchmark.name.includes('fictional'));
  const file = { name: 'run.json', size: 10, text: async () => '{"a":1}' };
  assert.deepEqual(await readEvaluationFile(file), { content: '{"a":1}', filename: 'run.json' });
  assert.match((await readEvaluationFile({ name: 'big.json', size: MAX_EVALUATION_BYTES + 1, text: async () => '' })).problem, /larger than 1 MB/);
  const docs = JSON.parse(read('../docs/evaluation-results-example.json'));
  assert.equal(docs.format, EVALUATION_FORMAT);
});

test('a submission may carry evaluation results, sent last', async () => {
  const form = { ...emptySubmitForm('Bench Lab (fictional)'), system: 'existing', existing: 'MediCore-2.5', evaluation: { content: '{"format":"bmc-evaluation-results/1"}', filename: 'run.json' } };
  assert.deepEqual(submissionParts(form), ['evaluation_results']);
  const calls = [];
  const client = {
    createSubmission: async () => ({ submission_id: 'sub-7' }),
    createEvaluationUpload: async (request) => {
      calls.push(request);
      return { upload_id: 'up-1' };
    }
  };
  const outcome = await runSubmission(client, form, { systems: [{ model_version: 'MediCore-2.5', use_cases: [{ use_case: 'Clinician Facing CDSS' }] }] });
  assert.equal(outcome.error, null);
  assert.deepEqual(calls, [{ content: form.evaluation.content, filename: 'run.json', submissionId: 'sub-7' }]);
});

test('the CDS Hooks request carries a synthetic patient and one condition per code', () => {
  const today = new Date('2026-10-22T12:00:00Z');
  assert.equal(syntheticBirthDate('65+', today), '1952-01-01');
  assert.equal(syntheticBirthDate(null, today), null);
  assert.deepEqual(parseIcd10cmCodes('E11.9, i10; j44.9 5A11'), { codes: ['E11.9', 'I10', 'J44.9'], ignored: 1 });
  const current = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', codesText: 'E11.9, I10, J44.9', lens: { age_group: '65+', sex: 'female', ethnicity: 'asian' }, setting: 'emergency_department', population: 'northbridge-region' };
  const request = cdsRequest(current, { codeSystem: 'icd10cm', hookInstance: 'h-1', today });
  assert.equal(request.hook, 'patient-view');
  assert.equal(request.hookInstance, 'h-1');
  assert.deepEqual(request.prefetch.patient, { resourceType: 'Patient', id: 'synthetic-patient-1', birthDate: '1952-01-01', gender: 'female' });
  assert.equal(request.prefetch.conditions.resourceType, 'Bundle');
  assert.deepEqual(
    request.prefetch.conditions.entry.map((entry) => entry.resource.code.coding[0]),
    ['E11.9', 'I10', 'J44.9'].map((code) => ({ system: ICD10CM_SYSTEM, code }))
  );
  assert.deepEqual(request.extension, { 'broad-modelcard': { card_id: 'SynGPT-2.0|Clinician Facing CDSS', setting: 'emergency_department', population: 'northbridge-region' } });
  assert.ok(!JSON.stringify(request).includes('asian'), 'ethnicity is not part of the request');
  const icd11 = cdsRequest({ ...current, codesText: '5A11, nonsense', lens: {}, setting: null, population: null }, { today });
  assert.equal(icd11.prefetch.conditions.entry[0].resource.code.coding[0].system, ICD11_SYSTEM);
  assert.ok(!('birthDate' in icd11.prefetch.patient) && !('gender' in icd11.prefetch.patient));
  assert.deepEqual(cdsCodes('5A11, nonsense', 'icd11'), { codes: ['5A11'], ignored: 1 });
});

test('a card detail renders bold and italic runs only', () => {
  const paragraphs = detailParagraphs('**Overall: Weak**, Evidence: Strong\n\n**Top warnings:** High uncertainty.\n\n*Demonstration on synthetic data, not for clinical use.*');
  assert.equal(paragraphs.length, 3);
  assert.deepEqual(paragraphs[0][0], { text: 'Overall: Weak', strong: true });
  assert.deepEqual(paragraphs[2], [{ text: 'Demonstration on synthetic data, not for clinical use.', em: true }]);
  assert.deepEqual(detailParagraphs('<b>x</b>'), [[{ text: '<b>x</b>' }]], 'markup stays text');
});

test('the CDS Hooks mode says what it sends, and is not in the static build', () => {
  const stage = read('../frontend/src/features/plugin/CdsHooksStage.jsx');
  assert.match(stage, /Send as CDS Hooks request/);
  assert.match(stage, /synthetic patient/);
  assert.match(stage, /client\.callCdsService/);
  const plugin = read('../frontend/src/features/plugin/PluginApp.jsx');
  assert.match(plugin, /Demonstration on synthetic data, not for clinical use/);
  assert.match(read('../frontend/vite.config.js'), /input: isStatic\s*\? \{ main: page\('index\.html'\), atlas: page\('atlas\.html'\), compare: page\('compare\.html'\) \}/);
});
