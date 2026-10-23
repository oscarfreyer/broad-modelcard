// Intervention effects (contract v1.13, CONTRACT.md §27):
// the condition card's "Effects on outcomes" at both depths, its plot
// geometry, the one-effect form of the Data Library, the data client's
// listEffects, the static adapter, and the whole path on the real backend
// (a trial entered with the study form, an effect with the effect form, the
// concept read with and without it). All effects are synthetic and fictional.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { createStaticAdapter, STATIC_REASONS, STATIC_UNAVAILABLE } from '../frontend/src/api/staticAdapter.js';
import { EffectsOnOutcomes } from '../frontend/src/features/details/EffectSections.js';
import {
  EFFECTS_NOT_GRADED,
  effectFacts,
  effectNumbers,
  effectPlot,
  effectSentence,
  effectSize,
  effectVerdict,
  figure
} from '../frontend/src/features/details/copy/effectCopy.js';
import { DATASETS, DATASET_ORDER, recordCount } from '../frontend/src/features/admin/datasets.js';
import { effectProblems, effectRecord, effectRowWords, effectStudies, emptyEffect, storedEffectForm, toolForStudy } from '../frontend/src/features/admin/effects.js';
import { headline, rowNoun } from '../frontend/src/features/admin/changeSummary.js';
import { parseAdminRoute } from '../frontend/src/features/admin/adminRoute.js';
import { schemaErrors } from './support/openapiSchema.js';
import { apiClient, copyStore, startTestBackend } from './support/backend.js';

const TRIAL = Object.freeze({
  study_id: 'VANTREL-RCT-2026',
  title: 'Vantrel emergency triage randomized trial (fictional)',
  design: 'randomized_trial',
  setting: 'Emergency departments, 4 hospitals (fictional)',
  sites: 4,
  patients: 9600,
  peer_reviewed: true,
  conducted_by: 'independent',
  reporting_guideline: 'consort_ai',
  guideline_followed: 'yes',
  risk_of_bias: 'low',
  risk_of_bias_notes: null,
  population: 'Adults attending the emergency department (synthetic)',
  evaluation_conditions: 'Synthetic.',
  model_version: 'Vantrel-Triage-2.1',
  publication_date: '2026-08-20',
  source_url: null
});

const TIME = Object.freeze({
  effect_id: 'EFF-VT-01',
  study_id: 'VANTREL-RCT-2026',
  model_version: 'Vantrel-Triage-2.1',
  use_case: 'Emergency department triage',
  codes: ['BA41'],
  condition_ids: ['BA41'],
  chapter_id: null,
  outcome: 'Time from arrival to first treatment',
  outcome_type: 'process',
  population: 'Adults attending with chest pain (synthetic)',
  comparator: 'Usual triage without the AI system',
  effect_measure: 'mean_difference',
  estimate: -14,
  ci_low: -21,
  ci_high: -7,
  unit: 'minutes',
  direction: 'lower_is_better',
  follow_up: 'Index visit',
  appraisal_tool: 'rob2',
  judgement: 'low',
  notes: null,
  study: TRIAL
});

const HARM = Object.freeze({
  ...TIME,
  effect_id: 'EFF-VT-02',
  codes: [],
  condition_ids: [],
  chapter_id: 'CH-11',
  outcome: 'Under-triage of patients who needed immediate care',
  outcome_type: 'harm',
  effect_measure: 'risk_ratio',
  estimate: 1.18,
  ci_low: 0.94,
  ci_high: 1.48,
  unit: null,
  judgement: 'some_concerns'
});

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------ the card copy

test('an effect reads as one plain sentence against its comparator', () => {
  assert.equal(effectVerdict(TIME), 'better');
  assert.equal(effectSentence(TIME), 'Better with the AI system than usual triage without the AI system: about 14 minutes less.');
  assert.equal(effectVerdict(HARM), 'unclear', 'the interval includes a ratio of 1');
  assert.equal(effectSentence(HARM), 'No clear difference from usual triage without the AI system.');
  assert.equal(effectSize(HARM), 'about 18% higher risk');
  const worse = { ...HARM, ci_low: 1.05 };
  assert.equal(effectVerdict(worse), 'worse');
  assert.equal(effectSentence(worse), 'Worse with the AI system than usual triage without the AI system: about 18% higher risk.');
  const higher = { ...TIME, direction: 'higher_is_better', estimate: 0.3, ci_low: 0.1, ci_high: 0.5, effect_measure: 'standardized_mean_difference', unit: null };
  assert.equal(effectSentence(higher), 'Better with the AI system than usual triage without the AI system.', 'no plain amount for a standardized difference');
  assert.equal(effectNumbers(TIME), 'Mean difference −14 minutes (95% CI −21 to −7)');
  assert.equal(figure(-6.2), '−6.2');
});

test('the plot puts no effect in the middle, on a log scale for ratios, with the better side named', () => {
  const time = effectPlot(TIME);
  assert.equal(time.nullPct, 50);
  assert.equal(time.betterSide, 'left');
  assert.equal(time.scale, 'linear');
  assert.ok(time.ciStartPct < time.estimatePct && time.estimatePct < time.ciEndPct && time.ciEndPct < 50, 'all of it on the better side');
  const harm = effectPlot(HARM);
  assert.equal(harm.scale, 'log');
  assert.ok(harm.ciStartPct < 50 && harm.ciEndPct > 50, 'the interval crosses no effect');
  // On a log scale, 0.5 and 2 sit equally far from 1.
  const symmetric = effectPlot({ ...HARM, estimate: 1, ci_low: 0.5, ci_high: 2 });
  assert.ok(Math.abs(50 - symmetric.ciStartPct - (symmetric.ciEndPct - 50)) < 1e-9);
  for (const plot of [time, harm, symmetric]) {
    for (const value of [plot.ciStartPct, plot.ciEndPct, plot.estimatePct]) assert.ok(value >= 0 && value <= 100);
  }
});

test('Effects on outcomes renders one sentence per effect at plain depth and the numbers at expert depth', () => {
  const plain = renderToStaticMarkup(h(EffectsOnOutcomes, { effects: [TIME, HARM], depth: 'plain' }));
  assert.match(plain, /<h3 id="detail-effects" class="group-heading">Effects on outcomes<\/h3>/);
  const words = text(plain);
  assert.match(words, /Better with the AI system than usual triage without the AI system: about 14 minutes less\./);
  assert.match(words, /Randomized trial, risk of bias low \(RoB 2\)\. Vantrel emergency triage randomized trial \(fictional\)\./);
  assert.ok(words.includes(EFFECTS_NOT_GRADED), 'the fixed line');
  assert.doesNotMatch(words, /95% CI/, 'no numbers on screen at plain depth (the plot label reads them)');
  assert.match(plain, /role="img" aria-label="Mean difference −14 minutes \(95% CI −21 to −7\)\./);
  // Never a status word or a status colour: effects are not graded.
  assert.doesNotMatch(plain, /tone-|Strong|Moderate|Weak|range-zone/);

  const expert = text(renderToStaticMarkup(h(EffectsOnOutcomes, { effects: [TIME, HARM], depth: 'expert' })));
  assert.match(expert, /Estimate Mean difference −14 minutes \(95% CI −21 to −7\)/);
  assert.match(expert, /Estimate Risk ratio 1\.18 \(95% CI 0\.94 to 1\.48\)/);
  assert.match(expert, /No effect \(1\)/);
  assert.match(expert, /Study VANTREL-RCT-2026, Randomized trial by an independent group, 4 sites, 9,600 patients/);
  assert.match(expert, /Risk of bias RoB 2: some concerns/);
  // Nothing at all without effects (the card shows no section).
  assert.equal(renderToStaticMarkup(h(EffectsOnOutcomes, { effects: [], depth: 'plain' })), '');
  // A study record that is gone is said so.
  assert.equal(effectFacts({ ...TIME, study: null }).find((fact) => fact.label === 'Study').value, 'VANTREL-RCT-2026 (no longer in Studies)');
});

test('the condition card places Effects on outcomes after Study quality, and the Summary says what grades cover', () => {
  const card = readFileSync(new URL('../frontend/src/features/details/DetailCard.jsx', import.meta.url), 'utf8');
  const quality = card.indexOf("layout.lead.includes('studyQuality') ? null : lead.studyQuality");
  // The Payer preset moves the effects under the header; elsewhere they come here.
  const effects = card.indexOf("layout.lead.includes('effects') ? null : effectsSection");
  assert.ok(quality > 0 && effects > quality, 'after Study quality');
  assert.ok(effects < card.indexOf("layout.lead.includes('acrossGroups') ? null : lead.acrossGroups"));
  const summary = readFileSync(new URL('../frontend/src/features/summary/SummaryPanel.jsx', import.meta.url), 'utf8');
  assert.match(summary, /Grades cover predictive performance only/);
});

// ---------------------------------------------------------- data client

test('listEffects reads the effects with filters and the version; the static demo serves its recorded list (R7)', async () => {
  const requests = [];
  const fetchMock = async (input) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    return new Response(JSON.stringify({ dataset_version: '1', effects: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = createDataClient(createApiAdapter({ fetch: fetchMock }));
  await client.listEffects();
  assert.deepEqual(requests.at(-1), { path: '/api/v1/effects', query: {} });
  await client.listEffects({ model: 'Vantrel-Triage-2.1', useCase: 'Emergency department triage' }, { version: 'staged:up_1' });
  assert.deepEqual(requests.at(-1).query, { model: 'Vantrel-Triage-2.1', use_case: 'Emergency department triage', version: 'staged:up_1' });

  const missing = createStaticAdapter({ fetch: async () => new Response('{}', { status: 404 }) });
  await assert.rejects(missing.listEffects({}), (error) => error.code === STATIC_UNAVAILABLE && error.detail === STATIC_REASONS.missing);
  const recorded = { dataset_version: '1', effects: [{ effect_id: 'E1', model_version: 'Vantrel-Triage-2.1', use_case: 'Emergency department triage' }] };
  const adapter = createStaticAdapter({ fetch: async (url) => new Response(JSON.stringify(url.endsWith('effects.json') ? recorded : {}), { status: 200 }) });
  assert.deepEqual((await adapter.listEffects({ model: 'Vantrel-Triage-2.1' })).effects.map((effect) => effect.effect_id), ['E1']);
  assert.deepEqual((await adapter.listEffects({ model: 'Quillary-Scribe-1.0' })).effects, []);
});

// ---------------------------------------------------------- Data Library

test('Effects on outcomes is the data set after Studies, with the one-effect form and merge by default', () => {
  assert.deepEqual(DATASET_ORDER.slice(-3, -1), ['studies', 'effects'], 'Local results (R5) close the list');
  const effects = DATASETS.effects;
  assert.equal(effects.title, 'Effects on outcomes');
  assert.equal(effects.recordForm, 'effect');
  assert.equal(effects.defaultMode, 'merge');
  assert.equal(recordCount('effects', 3), '3 effects');
  assert.deepEqual(rowNoun({ kind: 'effects' }), ['effect', 'effects']);
  assert.equal(headline({ kind: 'effects', rows: { added: 0, changed: 0, removed: 0, unchanged: 2 }, status_shifts: [] }), 'No changes: the effects match the live data.');
  assert.equal(parseAdminRoute('?set=effects').page, 'effects');
  const page = readFileSync(new URL('../frontend/src/features/admin/DatasetPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /dataset\.kind !== 'effects' && assist/, 'the study helper does not propose effects');
});

test('the effect form checks its fields, matches the tool to the study, and maps to the template record', () => {
  const studies = [TRIAL, { ...TRIAL, study_id: 'PROS-1', design: 'prospective' }, { ...TRIAL, study_id: 'VIG-1', design: 'vignette' }];
  assert.deepEqual(effectStudies(studies).map((study) => study.study_id), ['VANTREL-RCT-2026', 'PROS-1']);
  assert.equal(toolForStudy(studies, 'PROS-1'), 'robins_i');
  assert.equal(toolForStudy(studies, 'VANTREL-RCT-2026'), 'rob2');

  const empty = emptyEffect({ card: { model: 'Tiny-1', useCase: 'CDSS' } });
  assert.equal(empty.model, 'Tiny-1');
  const problems = effectProblems(empty, studies);
  for (const field of ['effectId', 'studyId', 'where', 'outcome', 'outcomeType', 'population', 'comparator', 'measure', 'estimate', 'ciLow', 'ciHigh', 'direction', 'tool', 'judgement']) {
    assert.ok(problems[field], field);
  }
  const filled = {
    ...empty,
    effectId: 'E-1', studyId: 'PROS-1', codes: [{ code: 'BA41', name: 'Acute myocardial infarction' }], outcome: 'Time to treatment',
    outcomeType: 'process', population: 'Adults (synthetic)', comparator: 'Usual care', measure: 'mean_difference',
    estimate: '−12', ciLow: '-20', ciHigh: '-4,5', unit: 'minutes', direction: 'lower_is_better', tool: 'rob2', judgement: 'low'
  };
  assert.deepEqual(effectProblems(filled, studies), { tool: 'The study is not randomized: use ROBINS-I.' });
  assert.deepEqual(effectProblems({ ...filled, tool: 'robins_i' }, studies), {});
  assert.match(effectProblems({ ...filled, tool: 'robins_i', ciHigh: '-15' }, studies).ciLow, /CI low must not be above the estimate/);
  assert.match(effectProblems({ ...filled, tool: 'robins_i', measure: 'risk_ratio' }, studies).estimate, /A ratio is above 0/);
  assert.match(effectProblems({ ...filled, studyId: 'VANTREL-RCT-2026', judgement: 'critical' }, studies).judgement, /RoB 2 ends at High/);
  assert.deepEqual(effectRecord({ ...filled, tool: 'robins_i' }), {
    effect_id: 'E-1', study_id: 'PROS-1', model_version: 'Tiny-1', use_case: 'CDSS', codes: 'BA41', outcome: 'Time to treatment',
    outcome_type: 'process', population: 'Adults (synthetic)', comparator: 'Usual care', effect_measure: 'mean_difference',
    estimate: -12, ci_low: -20, ci_high: -4.5, unit: 'minutes', direction: 'lower_is_better', follow_up: null, appraisal_tool: 'robins_i',
    judgement: 'low', notes: null
  });
  assert.equal(effectRecord({ ...filled, scope: 'chapter', chapterNo: '11' }).codes, 'chapter 11');

  const edited = storedEffectForm(HARM, [{ concept_id: 'CH-11', chapter_no: '11' }]);
  assert.deepEqual(edited.editing, { id: 'EFF-VT-02' });
  assert.equal(edited.scope, 'chapter');
  const record = effectRecord(edited);
  assert.equal(record.codes, 'chapter 11');
  assert.equal(record.estimate, 1.18);
  assert.equal(effectRecord(storedEffectForm(TIME)).codes, 'BA41');
  assert.deepEqual(effectRowWords(TIME), {
    title: 'Time from arrival to first treatment',
    text: 'Process, Mean difference -14 minutes (-21 to -7)',
    appraisal: 'RoB 2 low',
    meta: 'Vantrel-Triage-2.1, VANTREL-RCT-2026'
  });
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

async function stageAndPublish(kind, records, note) {
  const staged = await client.createRecordsUpload({ kind, records, replaceStaged: true });
  const checked = await waitFor(staged.upload_id);
  assert.equal(checked.status, 'valid', JSON.stringify(checked.report?.errors));
  await client.publishUpload({ uploadId: staged.upload_id, previewed: false, note });
}

test('an effect entered with the form comes back on the condition card, and nothing else moves', async () => {
  const models = await client.listModels();
  const model = models.models[0];
  const card = { model: model.model_version, useCase: model.use_cases[0].use_case };
  const map = await client.getMetricMap({ ...card, scope: 'atlas' });
  const conceptId = map.rows.find((entry) => entry[map.columns.indexOf('child_count')] === null)[0];
  const before = await client.getConceptMetrics({ ...card, conceptId });
  assert.equal('effects' in before, false, 'no effects, no key');
  const summaryBefore = await client.getMetricSummary({ ...card, view: 'overall' });

  await stageAndPublish('studies', [{ ...TRIAL, study_id: 'FE-RCT-1', model_version: null, peer_reviewed: true }], 'A synthetic trial.');
  const studies = await client.listStudies();
  const form = {
    ...emptyEffect({ card }),
    effectId: 'FE-EFF-1', studyId: 'FE-RCT-1', codes: [{ code: before.concept.icd11_code ?? conceptId, name: 'x' }], outcome: 'Time to treatment (synthetic)',
    outcomeType: 'process', population: 'Adults (synthetic)', comparator: 'Usual care without the AI system', measure: 'mean_difference',
    estimate: '-12', ciLow: '-20', ciHigh: '-4', unit: 'minutes', direction: 'lower_is_better', tool: 'rob2', judgement: 'low'
  };
  assert.deepEqual(effectProblems(form, studies.studies), {});
  await stageAndPublish('effects', [effectRecord(form)], 'A synthetic effect.');

  const listed = await client.listEffects({ model: card.model });
  assert.deepEqual(schemaErrors('listEffects', listed), []);
  assert.equal(listed.effects[0].study.study_id, 'FE-RCT-1');
  const after = await client.getConceptMetrics({ ...card, conceptId });
  assert.deepEqual(schemaErrors('getConceptMetrics', after), []);
  assert.deepEqual(after.effects.map((entry) => entry.effect_id), ['FE-EFF-1']);
  const { effects, dataset_version: version, ...rest } = after;
  const { dataset_version: versionBefore, ...restBefore } = before;
  assert.deepEqual(rest, restBefore, 'the result itself is unchanged');
  const summaryAfter = await client.getMetricSummary({ ...card, view: 'overall' });
  assert.deepEqual({ ...summaryAfter, dataset_version: '*' }, { ...summaryBefore, dataset_version: '*' }, 'no grade or status moved');
  assert.match(text(renderToStaticMarkup(h(EffectsOnOutcomes, { effects, depth: 'plain' }))), /Better with the AI system than usual care without the AI system: about 12 minutes less\./);
});
