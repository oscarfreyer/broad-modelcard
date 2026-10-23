// release 0.4, phase R8 follow-ups: the search palette names
// the classification on screen; the condition-card export carries the study
// appraisal (§22) and the effects on outcomes (§27); Custodian review shows a
// part's full change summary under it. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchWords } from '../frontend/src/features/search/searchWords.js';
import { buildConceptCardFile, exportAppraisal, exportEffects } from '../frontend/src/features/details/conceptCardExport.js';

test('the search palette names the classification it searches', () => {
  assert.equal(searchWords().dialog, 'Search ICD-11');
  assert.match(searchWords().hint, /an ICD-11 code \(for example 5A11\)/);
  const mondo = searchWords('MONDO');
  assert.equal(mondo.dialog, 'Search MONDO');
  assert.equal(mondo.field, 'Search conditions and MONDO codes');
  assert.match(mondo.hint, /^Type a MONDO code or part/);
  assert.match(searchWords('ICD-10-CM').hint, /^Type an ICD-10-CM code/);
  assert.match(searchWords('MONDO').empty, /search by MONDO code/);
  // Combinations stay ICD-11 whatever the classification.
  assert.match(searchWords('ICD-11', true).hint, /ICD-11 code to add it to the combination/);
  const palette = readFileSync(new URL('../frontend/src/features/search/SearchPalette.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(palette, /"Search ICD-11"|Search conditions and ICD-11 codes/);
  const atlas = readFileSync(new URL('../frontend/src/app/AtlasApp.jsx', import.meta.url), 'utf8');
  assert.match(atlas, /classification=\{shownOntology\?\.name \?\? 'ICD-11'\}/);
});

const study = {
  study_id: 'RAD-RCT-2026',
  title: 'Fictional randomized trial',
  design: 'randomized_trial',
  setting: 'Radiology, 3 hospitals',
  sites: 3,
  patients: 1200,
  peer_reviewed: true,
  conducted_by: 'independent',
  reporting_guideline: 'consort_ai',
  guideline_followed: 'yes',
  risk_of_bias: 'low',
  risk_of_bias_notes: null,
  population: 'Adults',
  evaluation_conditions: 'Prospective reading',
  model_version: 'radAIology-1',
  publication_date: '2026-03-01',
  scope: 'public'
};
const effect = {
  effect_id: 'E-1',
  study_id: 'VANTREL-RCT-2026',
  outcome: 'Time to treatment',
  outcome_type: 'benefit',
  population: 'Adults in the emergency department',
  comparator: 'Usual care without the AI system',
  effect_measure: 'mean_difference',
  estimate: -14,
  ci_low: -21,
  ci_high: -7,
  unit: 'minutes',
  direction: 'lower_is_better',
  follow_up: null,
  appraisal_tool: 'rob2',
  judgement: 'low',
  notes: null,
  study: { ...study, study_id: 'VANTREL-RCT-2026', title: 'Fictional triage trial' }
};
const conceptExport = (row) => ({
  exported_at: '2026-10-20T00:00:00Z',
  audience_view: 'expert',
  dataset_version: '28',
  synthetic_data_notice: 'Synthetic.',
  concept: { code: 'BA41', block: 'Ischaemic heart diseases', name: 'Acute myocardial infarction', hierarchy: [] },
  context: { model: 'Vantrel-Triage-2.1', use_case: 'Emergency department triage', population: { context: 'Clinical', age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' } },
  model_card: row,
  warnings: [],
  safeguards: []
});

test('the condition-card export carries the study appraisal and the effects, and nothing new without them', () => {
  const appraisal = exportAppraisal({ study, study_adjustment: 0.05, applied: true, terms: { signal: 0.8 } });
  assert.equal(appraisal.study.reporting_guideline, 'CONSORT-AI, followed');
  assert.equal(appraisal.study.risk_of_bias, 'Low');
  assert.equal(appraisal.study.design, 'Randomized trial');
  assert.match(appraisal.study.summary, /randomized trial at 3 sites/);
  assert.equal(appraisal.evidence_signal_adjustment, 0.05);
  assert.equal(exportAppraisal(null), null);
  assert.equal(exportAppraisal({ study: null, study_adjustment: -0.02, applied: true, terms: null }).study, null);

  const [record] = exportEffects([effect]);
  assert.equal(record.outcome, 'Time to treatment');
  assert.match(record.summary, /^Better with the AI system than usual care/);
  assert.match(record.estimate, /Mean difference −14 minutes \(95% CI −21 to −7\)/);
  assert.match(record.risk_of_bias, /Randomized trial, risk of bias low \(RoB 2\)/);

  const row = { perf: 0.8, ci_low: 0.7, ci_high: 0.9, appraisal: { study, study_adjustment: 0.05, applied: true, terms: null } };
  const file = buildConceptCardFile(conceptExport(row), { effects: [effect] });
  assert.ok(file.study_appraisal);
  assert.equal(file.effects_on_outcomes.effects.length, 1);
  assert.match(file.effects_on_outcomes.note, /predictive performance only/);
  const plain = buildConceptCardFile(conceptExport({ perf: 0.8, ci_low: 0.7, ci_high: 0.9 }));
  assert.equal('study_appraisal' in plain, false);
  assert.equal('effects_on_outcomes' in plain, false);

  const atlas = readFileSync(new URL('../frontend/src/app/AtlasApp.jsx', import.meta.url), 'utf8');
  assert.match(atlas, /effects: currentDetails\.effects \?\? \[\]/);
});

test('Custodian review shows a part’s full change summary under the part', () => {
  const review = readFileSync(new URL('../frontend/src/features/admin/ReviewPage.jsx', import.meta.url), 'utf8');
  assert.match(review, /import ChangesStep from '\.\/ChangesStep\.jsx'/);
  assert.match(review, /<ChangesStep dataset=\{dataset\}/);
  assert.match(review, /aria-expanded=\{shownChanges === upload\.upload_id\}/);
  assert.match(review, /below=\{\(upload\) =>/);
  const parts = readFileSync(new URL('../frontend/src/features/admin/SubmissionParts.jsx', import.meta.url), 'utf8');
  assert.match(parts, /className="submission-part-below"/);
});
