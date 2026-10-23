// Studies and appraisal (contract v1.13, CONTRACT.md §22): the condition card's "How was this assessed?" and "Study quality" at
// both depths, the one-study form of the Data Library, the data client's
// listStudies and getStudy over a mocked fetch, and the whole path on the real
// backend (a study published with the form, rows linked by a merge, the
// appraisal read back). All studies are synthetic and fictional.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { AssessmentDisclosure, StudyQuality } from '../frontend/src/features/details/StudySections.js';
import {
  assessment,
  guidelineValue,
  signalTermFacts,
  signed,
  studyQuality,
  studySentence
} from '../frontend/src/features/details/copy/studyCopy.js';
import { DATASETS, DATASET_ORDER, recordCount } from '../frontend/src/features/admin/datasets.js';
import { adjustmentWords, emptyStudy, storedStudyForm, studyProblems, studyRecord, studyRowWords } from '../frontend/src/features/admin/studies.js';
import { rowNoun, headline } from '../frontend/src/features/admin/changeSummary.js';
import { schemaErrors } from './support/openapiSchema.js';
import { apiClient, copyStore, startTestBackend } from './support/backend.js';

const WEIGHTS = { type: 0.33, studies: 0.17, sites: 0.12, peer: 0.18, size: 0.2 };
const ADJUSTMENTS = { guideline_followed: 0.05, risk_of_bias: { low: 0, some_concerns: -0.04, high: -0.1, unclear: -0.04 } };

const STUDY = Object.freeze({
  study_id: 'NBR-2026-01',
  title: 'Northbridge multisite validation (fictional)',
  design: 'prospective',
  setting: 'Medical wards, 4 hospitals (fictional)',
  sites: 4,
  patients: 1800,
  peer_reviewed: true,
  conducted_by: 'independent',
  reporting_guideline: 'tripod_ai',
  guideline_followed: 'yes',
  risk_of_bias: 'low',
  risk_of_bias_notes: 'Analysis: low concern (synthetic).',
  population: 'Adults (synthetic)',
  evaluation_conditions: 'Clinician-confirmed diagnosis; synthetic.',
  model_version: 'SynGPT-2.0',
  publication_date: '2026-09-15',
  source_url: 'https://studies.example/nbr-2026-01'
});

const TERMS = {
  type: 1,
  studies: 0.9,
  sites: 0.72,
  peer: 0.9067,
  size: 1,
  base_signal: 0.9246,
  penalties: 0,
  guideline_adjustment: 0.05,
  risk_of_bias_adjustment: 0,
  signal: 0.9746,
  grade: 'A'
};

function row({ appraisal, source = 'condition', lensFallback = false, evidenceGrade = 'A' } = {}) {
  return {
    concept_id: '5A11',
    evidence_grade: evidenceGrade,
    evidence_signal: evidenceGrade ? 0.9746 : null,
    provenance: { source, lens_fallback: lensFallback, rollup: source === 'rollup' ? { child_count: 12, aggregation: 'weighted_mean' } : null },
    ...(appraisal ? { appraisal } : {})
  };
}

const linked = () => row({ appraisal: { study: STUDY, study_adjustment: 0.05, applied: true, terms: TERMS } });
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------ the card copy

test('a study reads as one plain sentence', () => {
  assert.equal(studySentence(STUDY), 'One prospective study at 4 sites, conducted independently, followed TRIPOD+AI; risk of bias low.');
  assert.equal(
    studySentence({ ...STUDY, design: 'retrospective', sites: 1, conducted_by: 'developer', reporting_guideline: 'none', guideline_followed: null, risk_of_bias: 'high' }),
    'One retrospective study at 1 site, conducted by the developer, no reporting guideline; risk of bias high.'
  );
  assert.equal(
    studySentence({ ...STUDY, design: 'randomized_trial', reporting_guideline: 'other', guideline_followed: 'no', risk_of_bias: 'some_concerns' }),
    'One randomized trial at 4 sites, conducted independently, did not follow another reporting guideline; some concerns about bias.'
  );
  assert.equal(guidelineValue({ ...STUDY, guideline_followed: 'partly' }), 'TRIPOD+AI, partly followed');
  assert.equal(guidelineValue({ ...STUDY, reporting_guideline: 'none', guideline_followed: null }), 'None');
  assert.equal(signed(0.05), '+0.05');
  assert.equal(signed(-0.1), '−0.10');
  assert.equal(signed(0), '0.00');
});

test('How was this assessed? says it in words at plain depth and shows the terms at expert depth', () => {
  const plain = assessment({ row: linked(), depth: 'plain', weights: WEIGHTS, adjustments: ADJUSTMENTS });
  assert.equal(plain.lines[0], 'One prospective study at 4 sites, conducted independently, followed TRIPOD+AI; risk of bias low.');
  assert.match(plain.lines[1], /moves the evidence score by \+0\.05/);
  assert.deepEqual(plain.facts, []);
  assert.deepEqual(plain.record, []);

  const expert = assessment({ row: linked(), depth: 'expert', weights: WEIGHTS, adjustments: ADJUSTMENTS });
  const facts = Object.fromEntries(expert.facts.map((fact) => [fact.label, fact.value]));
  assert.equal(facts['Validation type'], '1.00 × 33%', 'the weight comes from /meta');
  assert.equal(facts['Sample size'], '1.00 × 20%');
  assert.equal(facts['Before penalties'], '0.925');
  assert.equal(facts['Reporting guideline'], '+0.05');
  assert.equal(facts['Risk of bias'], '0.00');
  assert.equal(facts['Evidence signal'], '0.975, grade A');
  assert.ok(expert.record.some((fact) => fact.label === 'Study' && fact.value.includes('NBR-2026-01')));
  // Without the weights the terms still read, without restating any weight.
  assert.equal(signalTermFacts(TERMS, null)[0].value, '1.00');
});

test('rows without a linked study say so plainly; aggregated rows give the mean adjustment only', () => {
  const unlinked = assessment({ row: row(), depth: 'plain' });
  assert.equal(unlinked.lines[0], 'No study record is linked. The grade comes from the counts on this result (synthetic).');
  const expertUnlinked = assessment({ row: row(), depth: 'expert', weights: WEIGHTS });
  assert.match(expertUnlinked.lines[0], /No study record is linked/);
  assert.deepEqual(expertUnlinked.facts.map((fact) => fact.value), ['weight 33%', 'weight 17%', 'weight 12%', 'weight 18%', 'weight 20%']);
  assert.equal(assessment({ row: row({ evidenceGrade: null }), depth: 'plain' }).lines[0], 'No validation evidence, so there is nothing to assess.');

  const rollup = row({ source: 'rollup', appraisal: { study: null, study_adjustment: -0.0123, applied: true, terms: null } });
  assert.equal(assessment({ row: rollup, depth: 'plain' }).lines[0], 'Combines several conditions. Their linked studies move the evidence score by −0.01 on average.');
  assert.match(assessment({ row: rollup, depth: 'expert' }).lines[0], /mean study adjustment of its rows \(−0\.012, weighted by prevalence\)/);
  assert.equal(assessment({ row: row({ source: 'rollup' }), depth: 'plain' }).lines[0], 'Combines several conditions; none links a study record.');
  assert.match(assessment({ row: row({ lensFallback: true }), depth: 'plain' }).lines[0], /population groups/);

  const stored = row({ appraisal: { study: STUDY, study_adjustment: 0.05, applied: false, terms: null } });
  assert.match(assessment({ row: stored, depth: 'plain' }).lines[1], /stored one/);
});

test('Study quality is about the underlying study, never about patient groups', () => {
  const quality = studyQuality(linked(), 'plain');
  // What the section is about is its heading's help; a study's facts are the content.
  assert.equal(quality.lead, null);
  assert.equal(quality.help, 'How the study behind this result was run, not how patient groups differ.');
  assert.deepEqual(quality.facts, [
    { label: 'Risk of bias', value: 'Low' },
    { label: 'Reporting guideline', value: 'TRIPOD+AI, followed' },
    { label: 'Conducted by', value: 'An independent group' }
  ]);
  assert.equal(studyQuality(linked(), 'expert').facts.at(-1).label, 'Risk-of-bias notes');
  assert.equal(studyQuality(row(), 'plain').lead, 'Not appraised: no study record is linked to this result.');
  assert.deepEqual(studyQuality(row(), 'plain').facts, []);
  for (const quality of [studyQuality(linked()), studyQuality(row())]) {
    assert.doesNotMatch(`${quality.lead} ${JSON.stringify(quality.facts)}`, /subgroup|across groups|lens/i);
  }
});

test('the card sections render at both depths and without an appraisal (the static demo)', () => {
  const closed = renderToStaticMarkup(h(AssessmentDisclosure, { row: linked(), depth: 'plain' }));
  assert.match(closed, /How was this assessed\?/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /TRIPOD/, 'closed until asked');
  const plain = text(renderToStaticMarkup(h(AssessmentDisclosure, { row: linked(), depth: 'plain', defaultOpen: true })));
  assert.match(plain, /One prospective study at 4 sites/);
  assert.doesNotMatch(plain, /Before penalties/);
  const expert = text(renderToStaticMarkup(h(AssessmentDisclosure, { row: linked(), depth: 'expert', weights: WEIGHTS, defaultOpen: true })));
  assert.match(expert, /Validation type 1\.00 × 33%/);
  assert.match(expert, /Evidence signal 0\.975, grade A/);
  const none = text(renderToStaticMarkup(h(AssessmentDisclosure, { row: row(), depth: 'plain', defaultOpen: true })));
  assert.match(none, /No study record is linked/);

  const quality = renderToStaticMarkup(h(StudyQuality, { row: linked(), depth: 'plain' }));
  assert.match(quality, /<h3 id="detail-study-quality" class="group-heading">Study quality<\/h3>/);
  assert.match(text(quality), /Risk of bias Low/);
  assert.match(text(renderToStaticMarkup(h(StudyQuality, { row: row(), depth: 'expert' }))), /Not appraised: no study record is linked to this result\./);

  const card = readFileSync(new URL('../frontend/src/features/details/DetailCard.jsx', import.meta.url), 'utf8');
  assert.match(card, /<AssessmentDisclosure/);
  assert.match(card, /<StudyQuality/);
  assert.match(card, /<AcrossGroups/, 'Across groups (R3) is its own section, kept apart from Study quality');
});

// ---------------------------------------------------------- Data Library

test('Studies is a data set, with the one-study form and merge by default', () => {
  assert.equal(DATASET_ORDER.indexOf('studies'), 6, 'after Local populations; Effects on outcomes (R6) follows it');
  const studies = DATASETS.studies;
  assert.equal(studies.title, 'Studies');
  assert.equal(studies.recordForm, 'study');
  assert.equal(studies.defaultMode, 'merge');
  assert.deepEqual(studies.counts.map((entry) => entry.key), ['studies']);
  assert.equal(recordCount('studies', 1), '1 study');
  assert.equal(recordCount('studies', 7), '7 studies');
  assert.deepEqual(rowNoun({ kind: 'studies' }), ['study', 'studies']);
  const changes = { kind: 'studies', rows: { added: 1, changed: 0, removed: 0, unchanged: 0 }, status_shifts: [{ view: 'evidence', from: 'moderate', to: 'strong', count: 1, sample_concept_ids: ['1A00'], targets: [{ model_version: 'M', use_case: 'F', count: 1, sample_concept_ids: ['1A00'] }] }] };
  assert.equal(headline(changes), 'Study: 1 added; 1 condition status change.');
  const page = readFileSync(new URL('../frontend/src/features/admin/DatasetPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /dataset\.kind !== 'studies' && dataset\.kind !== 'effects' && assist/, 'the study helper proposes metrics and incidents only');
});

test('the study form checks its fields and maps to the template record', () => {
  const form = emptyStudy({ now: new Date(2026, 9, 20) });
  assert.equal(form.publicationDate, '2026-10-20');
  const problems = studyProblems(form);
  for (const field of ['studyId', 'title', 'design', 'setting', 'sites', 'patients', 'peerReviewed', 'conductedBy', 'guideline', 'risk', 'population', 'conditions']) {
    assert.ok(problems[field], field);
  }
  const filled = {
    ...form,
    studyId: 'T-1',
    title: 'Synthetic study (fictional)',
    design: 'real_world_deployment',
    setting: 'Ward (fictional)',
    sites: '2',
    patients: '300',
    peerReviewed: 'no',
    conductedBy: 'hospital',
    guideline: 'decide_ai',
    followed: '',
    risk: 'some_concerns',
    population: 'Adults (synthetic)',
    conditions: 'Synthetic.'
  };
  assert.deepEqual(Object.keys(studyProblems(filled)), ['followed'], 'a named guideline needs Followed');
  assert.deepEqual(studyProblems({ ...filled, followed: 'partly', sourceUrl: 'ftp://x' }), { sourceUrl: 'Start with https:// or http://, or leave it empty.' });
  const record = studyRecord({ ...filled, followed: 'partly', model: 'Tiny-1' });
  assert.deepEqual(record, {
    study_id: 'T-1', title: 'Synthetic study (fictional)', design: 'real_world_deployment', setting: 'Ward (fictional)', sites: 2, patients: 300,
    peer_reviewed: false, conducted_by: 'hospital', reporting_guideline: 'decide_ai', guideline_followed: 'partly', risk_of_bias: 'some_concerns',
    risk_of_bias_notes: null, population: 'Adults (synthetic)', evaluation_conditions: 'Synthetic.', model_version: 'Tiny-1', publication_date: '2026-10-20',
    source_url: null, scope: 'Public', population_id: null
  });
  assert.equal(studyRecord({ ...filled, guideline: 'none', followed: 'yes' }).guideline_followed, null, 'no guideline, nothing followed');
  const edited = storedStudyForm(STUDY);
  assert.deepEqual(edited.editing, { id: 'NBR-2026-01' });
  // A stored study without a scope (before v1.13 §26) is public.
  assert.deepEqual(studyRecord(edited), { ...STUDY, scope: 'Public', population_id: null });
  assert.equal(adjustmentWords(edited, ADJUSTMENTS), 'Rows linked to this study get +0.05 on their evidence score.');
  assert.equal(adjustmentWords({ ...edited, followed: 'no', risk: 'high' }, ADJUSTMENTS), 'Rows linked to this study get −0.10 on their evidence score.');
  assert.equal(adjustmentWords({ ...edited, followed: 'partly' }, ADJUSTMENTS), 'Rows linked to this study keep their evidence score.');
  assert.deepEqual(studyRowWords(STUDY), {
    title: STUDY.title,
    text: 'Prospective, independent, TRIPOD+AI followed',
    risk: 'Risk of bias low',
    meta: 'SynGPT-2.0, 2026-09-15'
  });
});

// -------------------------------------------------------------- the client

test('listStudies and getStudy read the study records with the version', async () => {
  const requests = [];
  const fetchMock = async (input) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    return new Response(JSON.stringify({ dataset_version: '1', studies: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = createDataClient(createApiAdapter({ fetch: fetchMock }));
  await client.listStudies();
  assert.deepEqual(requests.at(-1), { path: '/api/v1/studies', query: {} });
  await client.listStudies({ model: 'ICU_GPT-1.0' }, { version: 'staged:up_1' });
  assert.deepEqual(requests.at(-1).query, { model: 'ICU_GPT-1.0', version: 'staged:up_1' });
  await client.getStudy({ studyId: 'NBR-2026-01' });
  assert.equal(requests.at(-1).path, '/api/v1/studies/NBR-2026-01');
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

async function waitFor(uploadId) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const upload = await client.getUpload({ uploadId });
    if (upload.status !== 'checking') return upload;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the check did not finish');
}

test('a study entered with the form links rows of a merge and comes back as the appraisal', async () => {
  const meta = await client.getMeta();
  assert.deepEqual(meta.evidence_signal_weights, WEIGHTS);
  assert.deepEqual(meta.evidence_study_adjustments, ADJUSTMENTS);
  const before = await client.listStudies();
  assert.deepEqual(schemaErrors('listStudies', before), []);

  const record = studyRecord({ ...storedStudyForm({ ...STUDY, study_id: 'FE-STUDY-1', model_version: null, guideline_followed: 'no', risk_of_bias: 'high' }), editing: null });
  const staged = await client.createRecordsUpload({ kind: 'studies', records: [record], replaceStaged: true });
  const checked = await waitFor(staged.upload_id);
  assert.equal(checked.status, 'valid', JSON.stringify(checked.report?.errors));
  await client.publishUpload({ uploadId: staged.upload_id, previewed: false, note: 'One synthetic study.' });
  const study = await client.getStudy({ studyId: 'FE-STUDY-1' });
  assert.deepEqual(schemaErrors('getStudy', study), []);
  assert.equal(study.study.risk_of_bias, 'high');
  await assert.rejects(client.getStudy({ studyId: 'FE-NOPE' }), (error) => error.status === 404 && error.code === 'unknown_study');

  // Link one row whose evidence the seed holds (many seed rows have none), at all patients.
  const models = await client.listModels();
  const card = { model: models.models[0].model_version, useCase: models.models[0].use_cases[0].use_case };
  const map = await client.getMetricMap({ ...card, scope: 'atlas' });
  const columns = Object.fromEntries(map.columns.map((name, index) => [name, index]));
  const conditions = map.rows.filter((entry) => entry[columns.child_count] === null && entry[columns.evidence_grade]);
  let target = null;
  for (const entry of conditions.slice(0, 40)) {
    const details = await client.getConceptMetrics({ ...card, conceptId: entry[0] });
    if (details.metrics?.evidence_signal !== null && details.metrics?.n_samples && details.metrics?.n_studies) {
      target = details;
      break;
    }
  }
  assert.ok(target, 'a seed row with a derived evidence signal');
  const metrics = target.metrics;
  const linkRecord = {
    code: target.concept.icd11_code ?? target.concept.concept_id,
    age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities',
    perf: metrics.perf, ci_low: metrics.ci_low, ci_high: metrics.ci_high, evidence_grade: metrics.evidence_grade,
    n_samples: metrics.n_samples, n_sites: metrics.n_sites, n_studies: metrics.n_studies, peer_reviewed_studies: metrics.peer_reviewed_studies,
    validation_type: metrics.validation_type,
    in_intended_use: metrics.in_intended_use === null ? null : metrics.in_intended_use,
    intended_use_coverage: metrics.intended_use_coverage, intended_use_level: metrics.intended_use_level,
    warnings: metrics.warnings.map((warning) => warning.code).join('; '),
    source: 'Synthetic study FE-STUDY-1 (fictional)', study: 'FE-STUDY-1', source_date: '2026-10-18'
  };
  const merge = await client.createRecordsUpload({ kind: 'metrics', modelVersion: card.model, useCase: card.useCase, records: [linkRecord], replaceStaged: true });
  const mergeChecked = await waitFor(merge.upload_id);
  assert.equal(mergeChecked.status, 'valid', JSON.stringify(mergeChecked.report?.errors));
  assert.ok(!mergeChecked.report.notes.some((note) => note.code === 'unknown_study'), 'the study is known');
  await client.publishUpload({ uploadId: merge.upload_id, previewed: false, note: 'Linked to FE-STUDY-1.' });

  const after = await client.getConceptMetrics({ ...card, conceptId: target.concept.concept_id });
  assert.deepEqual(schemaErrors('getConceptMetrics', after), []);
  const appraisal = after.metrics.appraisal;
  assert.equal(appraisal.study.study_id, 'FE-STUDY-1');
  assert.equal(appraisal.terms.risk_of_bias_adjustment, -0.1);
  assert.ok(Math.abs(after.metrics.evidence_signal - Math.max(0, metrics.evidence_signal - 0.1)) < 1e-9, 'a high risk of bias lowers the signal by 0.10');
  const words = assessment({ row: after.metrics, depth: 'plain', weights: meta.evidence_signal_weights, adjustments: meta.evidence_study_adjustments });
  assert.match(words.lines[0], /^One prospective study at 4 sites, conducted independently, did not follow TRIPOD\+AI; risk of bias high\.$/);
});
