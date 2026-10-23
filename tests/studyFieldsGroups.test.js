// Release 0.5, phase Q2 (G3, G4; contract v1.14, CONTRACT.md §22, §24): the optional study fields in Study quality, the
// one-study form, and the export; group sizes in Across groups; and the
// Summary's Across groups block from getSubgroupSummary. All data is synthetic.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { subgroupSummaryQuery } from '../frontend/src/api/queryKeys.js';
import { STATIC_REASONS, createStaticAdapter } from '../frontend/src/api/staticAdapter.js';
import { StudyQuality } from '../frontend/src/features/details/StudySections.js';
import { exportAppraisal } from '../frontend/src/features/details/conceptCardExport.js';
import { appraisalToolValue, studyQualityFacts } from '../frontend/src/features/details/copy/studyCopy.js';
import { acrossGroupsModel, groupSizeWords } from '../frontend/src/features/details/copy/subgroupCopy.js';
import { emptyStudy, storedStudyForm, studyProblems, studyRecord, studyRowWords } from '../frontend/src/features/admin/studies.js';
import GroupSummary from '../frontend/src/features/summary/GroupSummary.js';
import { groupPhrase, groupSummaryModel } from '../frontend/src/features/summary/groupSummaryCopy.js';
import { schemaErrors } from './support/openapiSchema.js';
import { apiClient, copyStore, startTestBackend } from './support/backend.js';

const STUDY = Object.freeze({
  study_id: 'T-1', title: 'Synthetic study (fictional)', design: 'prospective', setting: 'Intensive care unit (fictional)', sites: 3, patients: 900,
  peer_reviewed: true, conducted_by: 'independent', reporting_guideline: 'tripod_ai', guideline_followed: 'yes', risk_of_bias: 'low',
  risk_of_bias_notes: 'Analysis: low concern (synthetic).', population: 'Adults (synthetic)', evaluation_conditions: 'Synthetic.',
  model_version: 'Tiny-1', publication_date: '2026-09-01', source_url: null, scope: 'public', population_id: null
});
const FIELDS = Object.freeze({
  applicability: 'high', applicability_notes: 'One unit only (synthetic notes).', quality_tool: 'appraise_ai', quality_score: 72,
  setting_category: 'intensive_care', configuration_id: 'cfg-2026-03'
});

// ------------------------------------------------------------- Study quality

test('Study quality shows applicability beside risk of bias, the tool and score, and the study facts (G3)', () => {
  const plain = studyQualityFacts({ ...STUDY, ...FIELDS }, 'plain');
  assert.deepEqual(plain.map((fact) => fact.label), ['Risk of bias', 'Applicability concerns', 'Reporting guideline', 'Appraisal tool', 'Conducted by', 'Setting', 'Configuration evaluated']);
  const value = Object.fromEntries(plain.map((fact) => [fact.label, fact.value]));
  assert.equal(value['Applicability concerns'], 'High');
  assert.equal(value['Risk of bias'], 'Low', 'risk of bias is its own line');
  assert.equal(value['Appraisal tool'], 'APPRAISE-AI score 72 of 100');
  assert.equal(value.Setting, 'Intensive care');
  assert.equal(value['Configuration evaluated'], 'cfg-2026-03');
  const expert = studyQualityFacts({ ...STUDY, ...FIELDS }, 'expert').map((fact) => fact.label);
  assert.deepEqual(expert.slice(-2), ['Risk-of-bias notes', 'Applicability notes'], 'notes at expert depth only');
  // A study without the fields reads exactly as before.
  assert.deepEqual(studyQualityFacts(STUDY, 'plain').map((fact) => fact.label), ['Risk of bias', 'Reporting guideline', 'Conducted by']);
  assert.equal(appraisalToolValue({ quality_tool: 'probast_ai' }), 'PROBAST+AI');
  assert.equal(appraisalToolValue({ quality_tool: 'other', quality_score: 61.5 }), 'Another tool score 61.5 of 100');
  assert.equal(appraisalToolValue({}), null);
  const html = renderToStaticMarkup(h(StudyQuality, { row: { appraisal: { study: { ...STUDY, ...FIELDS } } }, depth: 'plain' }));
  assert.match(html, /Applicability concerns<\/dt><dd>High/);
  assert.match(html, /APPRAISE-AI score 72 of 100/);
  assert.match(html, /not how patient groups differ/, 'Study quality stays apart from Across groups');
  assert.doesNotMatch(html, /One unit only/, 'notes only at expert depth');
});

test('the condition card export carries the stated fields only', () => {
  const stated = exportAppraisal({ study: { ...STUDY, ...FIELDS }, study_adjustment: 0.05, applied: true, terms: null }).study;
  assert.equal(stated.applicability_concerns, 'High');
  assert.equal(stated.appraisal_tool, 'APPRAISE-AI score 72 of 100');
  assert.equal(stated.setting_category, 'Intensive care');
  assert.equal(stated.configuration_evaluated, 'cfg-2026-03');
  const plain = exportAppraisal({ study: STUDY, study_adjustment: 0.05, applied: true, terms: null }).study;
  for (const key of ['applicability_concerns', 'applicability_notes', 'appraisal_tool', 'setting_category', 'configuration_evaluated']) {
    assert.ok(!(key in plain), key);
  }
});

// ---------------------------------------------------------- one-study form

test('the one-study form checks and maps the new fields', () => {
  const filled = {
    ...emptyStudy({ now: new Date('2026-10-22T10:00:00Z') }),
    studyId: 'T-1', title: 'Synthetic study (fictional)', design: 'prospective', setting: 'Ward (fictional)', sites: '2', patients: '300',
    peerReviewed: 'no', conductedBy: 'hospital', guideline: 'none', risk: 'low', population: 'Adults (synthetic)', conditions: 'Synthetic.'
  };
  assert.deepEqual(studyProblems(filled), {});
  assert.ok(studyProblems({ ...filled, qualityScore: '72' }).qualityScore.startsWith('Choose the appraisal tool'));
  assert.ok(studyProblems({ ...filled, qualityTool: 'appraise_ai', qualityScore: '140' }).qualityScore.startsWith('A number from 0 to 100'));
  assert.ok(studyProblems({ ...filled, qualityTool: 'appraise_ai', qualityScore: 'high' }).qualityScore);
  assert.ok(studyProblems({ ...filled, configurationId: 'cfg 2026/03' }).configurationId);
  assert.ok(studyProblems({ ...filled, applicabilityNotes: 'x'.repeat(501) }).applicabilityNotes);
  const record = studyRecord({
    ...filled, applicability: 'unclear', applicabilityNotes: ' Notes ', qualityTool: 'appraise_ai', qualityScore: '72', settingCategory: 'primary_care', configurationId: 'cfg-1'
  });
  assert.deepEqual(
    { applicability: record.applicability, applicability_notes: record.applicability_notes, quality_tool: record.quality_tool, quality_score: record.quality_score, setting_category: record.setting_category, configuration_id: record.configuration_id },
    { applicability: 'unclear', applicability_notes: 'Notes', quality_tool: 'appraise_ai', quality_score: 72, setting_category: 'primary_care', configuration_id: 'cfg-1' }
  );
  // Empty fields are left out: the check reads them as empty cells, as before.
  const plain = studyRecord(filled);
  for (const key of ['applicability', 'applicability_notes', 'quality_tool', 'quality_score', 'setting_category', 'configuration_id']) {
    assert.ok(!(key in plain), key);
  }
  const form = storedStudyForm({ ...STUDY, ...FIELDS });
  assert.deepEqual(
    [form.applicability, form.applicabilityNotes, form.qualityTool, form.qualityScore, form.settingCategory, form.configurationId],
    ['high', 'One unit only (synthetic notes).', 'appraise_ai', '72', 'intensive_care', 'cfg-2026-03']
  );
  assert.equal(storedStudyForm(STUDY).qualityScore, '');
  assert.equal(studyRowWords({ ...STUDY, ...FIELDS }).risk, 'Risk of bias low, applicability concerns high');
  assert.equal(studyRowWords(STUDY).risk, 'Risk of bias low');
});

// -------------------------------------------------------------- group sizes

const ENTRY = {
  axis: 'age', group: 'Age 65+', lens: { age: 'Age 65+', sex: 'All sexes', ethnicity: 'All ethnicities' }, has_result: true, perf: 0.8,
  ci_low: 0.75, ci_high: 0.85, status: { performance: 'strong' }, provenance: { source: 'condition', lens_fallback: false },
  n_samples: 1240, n_sites: 6, difference: { delta: 0.02, direction: 'higher', flagged: false, reason: 'below_delta' }
};

test('Across groups lists patients and sites per group at both depths (G4)', () => {
  assert.equal(groupSizeWords(ENTRY), '1,240 patients, 6 sites');
  assert.equal(groupSizeWords({ ...ENTRY, n_sites: 1 }), '1,240 patients, 1 site');
  assert.equal(groupSizeWords({ ...ENTRY, provenance: { source: 'rollup' } }), 'About 1,240 patients, 6 sites per condition');
  assert.equal(groupSizeWords({ ...ENTRY, provenance: { source: 'condition', lens_fallback: true } }), 'About 1,240 patients, 6 sites per group');
  assert.equal(groupSizeWords({ ...ENTRY, n_samples: null, n_sites: null }), null);
  assert.equal(groupSizeWords({ ...ENTRY, n_samples: undefined, n_sites: undefined }), null, 'an answer recorded before v1.14 shows no size');
  const answer = { all_patients: { ...ENTRY, axis: 'all', group: null, n_samples: 5000, n_sites: 9, difference: undefined }, groups: [ENTRY] };
  for (const depth of ['plain', 'expert']) {
    const model = acrossGroupsModel(answer, { depth });
    assert.ok(model.references[0].details.includes('5,000 patients, 9 sites'), depth);
    assert.ok(model.groups[0].rows[0].details.includes('1,240 patients, 6 sites'), depth);
  }
  const empty = acrossGroupsModel({ all_patients: answer.all_patients, groups: [{ ...ENTRY, has_result: false, perf: null, n_samples: null, n_sites: null }] });
  assert.ok(!empty.groups[0].rows[0].details.some((detail) => /patients/.test(detail)));
});

// ----------------------------------------------------------- group summary

function group(axis, value, counts, flagged = []) {
  return {
    axis, group: value, lens: { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities', [axis]: value },
    with_result: 0, no_result: 0, compared: 0, flagged_higher: 0, flagged_lower: 0, ...counts, flagged
  };
}

const SUMMARY = {
  dataset_version: '29', filters: { model: 'M', use_case: 'U', context: 'Clinical' }, classification_basis: 'icd11', total: 10,
  all_patients_with_result: 8, layered: false,
  groups: [
    group('age', 'Age 0-17', { with_result: 0, no_result: 8 }),
    group('age', 'Age 65+', { with_result: 8, compared: 8, flagged_higher: 1, flagged_lower: 3 }, [
      { concept_id: 'BA00', code: 'BA00', pt: 'Essential hypertension', chapter_id: 'CH-11', delta: -0.21, direction: 'lower' },
      { concept_id: '5A11', code: '5A11', pt: 'Type 2 diabetes mellitus', chapter_id: 'CH-05', delta: 0.12, direction: 'higher' }
    ]),
    group('sex', 'Sex Female', { with_result: 8, compared: 8, flagged_lower: 1 }, [
      { concept_id: 'CA40', code: 'CA40', pt: 'Pneumonia', chapter_id: 'CH-12', delta: -0.08, direction: 'lower' }
    ]),
    group('ethnicity', 'Ethnicity Other', { with_result: 0, no_result: 8 })
  ]
};

test('the Summary says which groups differ most and which have no data, in plain words (G4)', () => {
  assert.equal(groupPhrase('age', 'Age 65+'), 'patients aged 65+');
  assert.equal(groupPhrase('sex', 'Sex Female'), 'female patients');
  assert.equal(groupPhrase('ethnicity', 'Ethnicity Asian'), 'Asian patients');
  assert.equal(groupPhrase('ethnicity', 'Ethnicity Other'), 'patients of other ethnicity');
  const plain = groupSummaryModel(SUMMARY, { depth: 'plain' });
  assert.equal(
    plain.lead,
    'Results for patients aged 65+ differ from all patients most often: 4 conditions (1 higher, 3 lower), then female patients. No data for patients aged 0–17 and patients of other ethnicity.'
  );
  assert.ok(plain.lead.split('. ').length <= 2, 'one or two sentences at plain depth');
  assert.deepEqual(plain.groups, [], 'plain depth says it in the lead');
  assert.deepEqual(groupSummaryModel(SUMMARY, { depth: 'expert' }).groups.map((entry) => entry.label), ['Patients aged 65+', 'Female patients']);
  assert.deepEqual(plain.conditions.map((entry) => [entry.conceptId, entry.text]), [
    ['BA00', 'Lower for patients aged 65+ (−0.21)'],
    ['5A11', 'Higher for patients aged 65+ (+0.12)']
  ]);
  assert.equal(plain.canOpen, true);
  assert.match(plain.note, /not a grade/);
  const expert = groupSummaryModel(SUMMARY, { depth: 'expert' });
  assert.equal(expert.groups[0].text, '4 conditions differ (1 higher, 3 lower) of 8 compared');
  assert.equal(expert.conditions[0].text, 'Lower for patients aged 65+ (−0.210)');
  const other = groupSummaryModel(SUMMARY, { classification: 'MONDO' });
  assert.equal(other.canOpen, false);
  assert.match(other.note, /Counted over ICD-11 conditions/);
  // Never "bias" language: a difference from all patients, a heuristic.
  for (const model of [plain, expert, other]) {
    assert.doesNotMatch(JSON.stringify(model), /bias|detected|unfair|discriminat/i);
  }
});

test('the Summary handles cards without group data or without differences', () => {
  const product = { ...SUMMARY, groups: SUMMARY.groups.map((entry) => ({ ...entry, with_result: 0, compared: 0, flagged_higher: 0, flagged_lower: 0, flagged: [] })) };
  assert.equal(groupSummaryModel(product).lead, 'No results by group: results are stored for all patients only.');
  const calm = { ...SUMMARY, groups: SUMMARY.groups.map((entry) => ({ ...entry, flagged_higher: 0, flagged_lower: 0, flagged: [] })) };
  const model = groupSummaryModel(calm);
  assert.equal(model.lead, 'No group differs clearly from all patients in any condition. No data for patients aged 0–17 and patients of other ethnicity.');
  assert.deepEqual(model.conditions, []);
  assert.match(groupSummaryModel({ ...SUMMARY, all_patients_with_result: 0 }).lead, /no results for all patients/);
});

test('the block opens a listed condition and says in words what the static demo lacks', async () => {
  const opened = [];
  const html = renderToStaticMarkup(h(GroupSummary, { query: { data: SUMMARY, error: null }, depth: 'plain', onOpenCondition: (condition) => opened.push(condition) }));
  assert.match(html, /<h3[^>]*>Across groups<\/h3>/);
  assert.match(html, /<button[^>]*class="link-button"[^>]*>Essential hypertension<\/button>/);
  assert.match(html, /synthetic data, not a grade/);
  const plainText = renderToStaticMarkup(h(GroupSummary, { query: { data: SUMMARY, error: null }, classification: 'MONDO', onOpenCondition: () => {} }));
  assert.doesNotMatch(plainText, /class="link-button"/, 'no links in another classification');
  const adapter = createStaticAdapter({ fetch: async () => ({ ok: false, status: 404 }) });
  let caught = null;
  // Recorded since Q9; a local population the static demo does not hold says so.
  await adapter.getSubgroupSummary({ model: 'M', useCase: 'U', population: 'northbridge-region' }).catch((error) => {
    caught = error;
  });
  assert.equal(caught?.code, 'static_unavailable');
  const words = renderToStaticMarkup(h(GroupSummary, { query: { data: null, error: caught } }));
  assert.match(words, new RegExp(STATIC_REASONS.population.slice(0, 40)));
  const failed = renderToStaticMarkup(h(GroupSummary, { query: { data: null, error: new Error('x') } }));
  assert.match(failed, /could not be loaded/);
  assert.match(renderToStaticMarkup(h(GroupSummary, { query: { data: null, error: null } })), /Loading the groups/);
});

test('the summary read is keyed by card and population, never by lens or classification', async () => {
  const filters = { model: 'M', useCase: 'U', age: 'Age 65+', sex: 'All sexes', ethnicity: 'All ethnicities', ontology: 'mondo' };
  const query = subgroupSummaryQuery(filters);
  assert.equal(query.key, subgroupSummaryQuery({ ...filters, age: 'All ages', ontology: null }).key);
  assert.notEqual(query.key, subgroupSummaryQuery({ ...filters, population: 'northbridge-region' }).key);
  assert.equal(subgroupSummaryQuery(null), null);
  const calls = [];
  await subgroupSummaryQuery({ ...filters, population: 'northbridge-region' }).fetch({ getSubgroupSummary: (params) => calls.push(params) }, {});
  assert.deepEqual(calls, [{ model: 'M', useCase: 'U', population: 'northbridge-region' }]);
  const app = readFileSync(new URL('../frontend/src/app/AtlasApp.jsx', import.meta.url), 'utf8');
  assert.match(app, /subgroupSummaryQuery\(shownFiltersRef\.current\)/, 'the Summary reads it for the card on screen');
});

// ---------------------------------------------------------- against the API

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

test('getSubgroupSummary and the group sizes answer as the contract says', async () => {
  const card = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' };
  const summary = await client.getSubgroupSummary(card);
  assert.deepEqual(schemaErrors('getSubgroupSummary', summary), []);
  assert.equal(summary.classification_basis, 'icd11');
  assert.equal(summary.groups.length, 11);
  const model = groupSummaryModel(summary);
  assert.ok(model.lead.length > 0);
  const subgroups = await client.getConceptSubgroups({ ...card, conceptId: '5A11' });
  assert.deepEqual(schemaErrors('getConceptSubgroups', subgroups), []);
  const older = subgroups.groups.find((entry) => entry.group === 'Age 65+');
  const concept = await client.getConceptMetrics({ ...card, conceptId: '5A11', age: 'Age 65+' });
  assert.equal(older.n_samples, concept.metrics.n_samples);
  assert.equal(older.n_sites, concept.metrics.n_sites);
  await assert.rejects(client.getSubgroupSummary({ model: 'SynGPT-2.0', useCase: 'Nope' }), (error) => error.code === 'unknown_use_case');
});
