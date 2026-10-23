// Release 0.5, phase Q9: the static demo records the v1.14 reads (CONTRACT.md
// §26.7): the group summary, the audience reads (safety incidents, the
// prevalence-weighted shares, a card's change history), the card record, the
// ICD-11 synonyms, and each card's stored care settings at all patients in
// ICD-11. scripts/static/record.mjs compares every one of them with the API
// when it records; these tests cover the paths, the adapter's answers and
// refusals, and the static build's words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STATIC_REASONS, STATIC_UNAVAILABLE, createStaticAdapter, unrecordedReason } from '../frontend/src/api/staticAdapter.js';
import { lensKey, lensSetting, staticPaths } from '../frontend/src/api/staticPaths.js';
import { cardVersionsAnswer, createConceptBundle, incidentsAnswer } from '../frontend/src/api/staticRebuild.js';
import { STATIC_SETTING_LENS_NOTE } from '../frontend/src/app/lensSelection.js';
import { staticSettingNotice } from '../frontend/src/shared/careSetting.js';
import { staticNoticeText } from '../frontend/src/shared/staticNotice.js';
import { specificSettings } from '../scripts/static/record.mjs';

const ED = 'Emergency department';
const ICU = 'Intensive care';
const CARD = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' };
const DIR = 'cards/SynGPT-2.0__Clinician-Facing-CDSS';
const OTHER = { model: 'ICU_GPT-1.0', useCase: 'CDSS' };
const source = (relative) => readFileSync(new URL(`../frontend/src/${relative}`, import.meta.url), 'utf8');

const concept = (id, fields = {}) => ({ concept_id: id, icd11_code: id, pt: id, fsn: `${id} (ICD-11)`, level: 2, parent_id: null, chapter_id: 'CH-11', ...fields });
const CHAPTER = {
  dataset_version: '44',
  chapter: concept('CH-11', { icd11_code: '11', pt: '11 Diseases of the circulatory system', level: 0 }),
  blocks: [concept('BLK-11-A', { icd11_code: 'A', pt: 'Ischaemic heart diseases', level: 1, parent_id: 'CH-11' })],
  concepts: [
    concept('BA41', { pt: 'Acute myocardial infarction', parent_id: 'BLK-11-A', depth_in_kind: 1 }),
    concept('BA41.Z', { pt: 'Acute myocardial infarction, unspecified', parent_id: 'BA41', level: 3 }),
    concept('BA00', { pt: 'Essential hypertension', parent_id: 'BLK-11-A', depth_in_kind: 1 })
  ]
};
const bundleAt = (context) => {
  const collector = createConceptBundle('44');
  ['CH-11', 'BLK-11-A', 'BA41', 'BA41.Z', 'BA00'].forEach((id) =>
    collector.add({ dataset_version: '44', concept: { concept_id: id }, path: [], metrics: { concept_id: id, perf: 0.7, context }, incidents: [] })
  );
  return collector.bundle;
};
const AXES = {
  age: ['All ages', 'Age 0-17', 'Age 18-39', 'Age 40-64', 'Age 65+'],
  sex: ['All sexes', 'Sex Female', 'Sex Male'],
  ethnicity: ['All ethnicities'],
  context: ['Clinical', ED, ICU, 'Inpatient ward', 'Outpatient clinic', 'Primary care']
};
const MODELS = {
  default_model_version: 'SynGPT-2.0',
  models: [
    { model_version: 'SynGPT-2.0', display_name: 'SynGPT 2.0', use_cases: [{ use_case: 'Clinician Facing CDSS', function_category: 'decision_support', settings: ['Clinical', ED] }] },
    { model_version: 'ICU_GPT-1.0', display_name: 'ICU_GPT 1.0', use_cases: [{ use_case: 'CDSS', function_category: 'decision_support' }] }
  ]
};
const INCIDENTS = {
  dataset_version: '44',
  incidents: [
    { incident_id: 'INC-3', model_version: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS', last_date: '2026-09-01' },
    { incident_id: 'INC-2', model_version: 'ICU_GPT-1.0', use_case: 'CDSS', last_date: '2026-08-01' },
    { incident_id: 'INC-1', model_version: 'SynGPT-2.0', use_case: 'Discharge letter generation', last_date: '2026-07-01' }
  ]
};
const VERSIONS = { dataset_version: '44', versions: [{ version_id: 44 }, { version_id: 37 }, { version_id: 12 }, { version_id: 1 }] };
const MANIFEST = { ontologies: ['icd11', 'mondo'], cards: [{ model: CARD.model, use_case: CARD.useCase, settings: [ED] }, { model: OTHER.model, use_case: OTHER.useCase, settings: [] }] };

function fixture(extra = {}) {
  const files = {
    'manifest.json': MANIFEST,
    'meta.json': { dataset_version: '44', chapters: [CHAPTER.chapter], axes: AXES, populations: [] },
    'models.json': MODELS,
    'atlas/chapters/CH-11.json': CHAPTER,
    'atlas/concept-chapters.json': { 'CH-11': ['CH-11', 'BLK-11-A', 'BA41', 'BA41.Z', 'BA00'] },
    'incidents.json': INCIDENTS,
    'synonyms.json': { BA41: ['heart attack', 'myocardial infarct'], BA00: ['high blood pressure'] },
    [`${DIR}/all/concepts-CH-11.json`]: bundleAt('Clinical'),
    [`${DIR}/setting-emergency-department/concepts-CH-11.json`]: bundleAt(ED),
    [`${DIR}/setting-emergency-department/map-atlas.json`]: { file: 'ed-map' },
    [`${DIR}/setting-emergency-department/summary-overall.json`]: { file: 'ed-summary' },
    [`${DIR}/setting-emergency-department/summary-overall-weighted.json`]: { file: 'ed-weighted' },
    [`${DIR}/age-65plus/summary-overall-weighted.json`]: { file: 'age-weighted' },
    [`${DIR}/all/summary-overall-weighted.json`]: { file: 'weighted' },
    [`${DIR}/all/subgroup-summary.json`]: { file: 'group-summary' },
    [`${DIR}/setting-emergency-department/subgroup-summary.json`]: { file: 'ed-group-summary' },
    [`${DIR}/versions.json`]: VERSIONS,
    [`${DIR}/record.json`]: { format: 'bmc-card-record/1' },
    [`${DIR}/record-jsonld.json`]: { '@type': 'obo:MCRO_0000001', format: 'bmc-card-record/1' },
    ...extra
  };
  const requests = [];
  const fetch = async (url) => {
    const path = url.replace(/^static-data\//, '');
    requests.push(path);
    if (!(path in files)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(files[path]) };
  };
  return { adapter: createStaticAdapter({ fetch }), requests };
}

async function rejectsWith(promise, detail) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, STATIC_UNAVAILABLE);
    assert.equal(error.detail, detail);
    return true;
  });
}

test('a specific care setting is a lens folder of its own; Any setting keeps every path', () => {
  assert.equal(lensKey({ setting: ED }), 'setting-emergency-department');
  assert.equal(lensKey({ setting: 'Clinical' }), 'all');
  assert.equal(lensKey({ setting: null, age: 'Age 65+' }), 'age-65plus');
  assert.equal(lensKey({ age: 'Age 65+', setting: ICU }), 'age-65plus__setting-intensive-care');
  assert.equal(lensSetting({ setting: 'Clinical' }), null);
  assert.equal(staticPaths.metricMap({ ...CARD, setting: ED }), `${DIR}/setting-emergency-department/map-atlas.json`);
  assert.equal(staticPaths.metricSummary({ ...CARD, view: 'overall', weights: 'prevalence' }), `${DIR}/all/summary-overall-weighted.json`);
  assert.equal(staticPaths.metricSummary({ ...CARD, view: 'overall' }), `${DIR}/all/summary-overall.json`);
  assert.equal(staticPaths.conceptBundle({ ...CARD, chapterId: 'CH-11' }), `${DIR}/all/concepts-CH-11.json`);
  assert.equal(staticPaths.conceptBundle({ ...CARD, chapterId: 'CH-11', setting: ED }), `${DIR}/setting-emergency-department/concepts-CH-11.json`);
  assert.equal(staticPaths.subgroupBundle({ ...CARD, chapterId: 'CH-11', setting: ED }), `${DIR}/setting-emergency-department/subgroups-CH-11.json`);
  assert.equal(staticPaths.subgroupSummary(CARD), `${DIR}/all/subgroup-summary.json`);
  assert.equal(staticPaths.cardVersions(CARD), `${DIR}/versions.json`);
  assert.equal(staticPaths.cardRecord({ ...CARD, format: 'jsonld' }), `${DIR}/record-jsonld.json`);
  assert.equal(staticPaths.incidents(), 'incidents.json');
  assert.equal(staticPaths.synonyms(), 'synonyms.json');
});

test('the recorder records the specific settings a card stores, never Any setting', () => {
  assert.deepEqual(specificSettings({ settings: ['Clinical', ED, 'Primary care'] }), [ED, 'Primary care']);
  assert.deepEqual(specificSettings({}), []);
});

test('a card’s stored setting is read from its files at all patients in ICD-11', async () => {
  const { adapter } = fixture();
  assert.deepEqual(await adapter.getMetricMap({ ...CARD, scope: 'atlas', setting: ED }), { file: 'ed-map' });
  assert.deepEqual(await adapter.getMetricSummary({ ...CARD, view: 'overall', setting: ED }), { file: 'ed-summary' });
  const card = await adapter.getConceptMetrics({ ...CARD, conceptId: 'BA41', setting: ED });
  assert.equal(card.metrics.context, ED);
  assert.equal((await adapter.getConceptMetrics({ ...CARD, conceptId: 'BA41' })).metrics.context, 'Clinical', 'the Any-setting result stays beside it');
  assert.deepEqual(await adapter.getSubgroupSummary({ ...CARD, setting: ED }), { file: 'ed-group-summary' });
});

test('settings the snapshot does not hold say so in words', async () => {
  const { adapter } = fixture();
  await rejectsWith(adapter.getMetricMap({ ...CARD, scope: 'atlas', setting: ICU }), STATIC_REASONS.settingCard);
  await rejectsWith(adapter.getMetricMap({ ...OTHER, scope: 'atlas', setting: ED }), STATIC_REASONS.settingCard);
  await rejectsWith(adapter.getMetricMap({ ...CARD, scope: 'atlas', setting: ED, age: 'Age 65+' }), STATIC_REASONS.settingLens);
  await rejectsWith(adapter.getMetricSummary({ ...CARD, view: 'overall', setting: ED, ontology: 'mondo' }), STATIC_REASONS.settingOntology);
  await rejectsWith(adapter.getConceptMetrics({ ...CARD, conceptId: 'BA41', setting: ICU }), STATIC_REASONS.settingCard);
  await rejectsWith(adapter.getMultimorbidityCandidates({ ...CARD, selected: [], scope: 'atlas', setting: ED }), STATIC_REASONS.settingMultimorbidity);
  await rejectsWith(adapter.getComparison({ cards: ['SynGPT-2.0|Clinician Facing CDSS', 'ICU_GPT-1.0|CDSS'], setting: ED }), STATIC_REASONS.settingComparison);
  assert.equal(unrecordedReason({ lens: { setting: ED }, settings: [ED] }), null);
  assert.equal(unrecordedReason({ lens: { setting: 'Clinical', age: 'Age 65+' } }), null, 'Any setting is not a setting');
});

test('the weighted shares are read beside each summary at view overall', async () => {
  const { adapter, requests } = fixture();
  assert.deepEqual(await adapter.getMetricSummary({ ...CARD, view: 'overall', weights: 'prevalence' }), { file: 'weighted' });
  assert.deepEqual(await adapter.getMetricSummary({ ...CARD, view: 'overall', weights: 'prevalence', age: 'Age 65+' }), { file: 'age-weighted' });
  assert.deepEqual(await adapter.getMetricSummary({ ...CARD, view: 'overall', weights: 'prevalence', setting: ED }), { file: 'ed-weighted' });
  assert.ok(requests.includes(`${DIR}/all/summary-overall-weighted.json`));
  await assert.rejects(adapter.getMetricSummary({ ...CARD, weights: 'cases' }), { code: 'validation_error' });
  await rejectsWith(adapter.getMetricSummary({ ...CARD, view: 'evidence', weights: 'prevalence' }), STATIC_REASONS.missing);
  await rejectsWith(adapter.getMetricSummary({ ...CARD, weights: 'prevalence', population: 'northbridge-region' }), STATIC_REASONS.population);
});

test('safety incidents are served from the recorded list with the API’s filters, newest first kept', async () => {
  const { adapter } = fixture();
  assert.deepEqual(await adapter.listSafetyIncidents(), INCIDENTS);
  assert.deepEqual((await adapter.listSafetyIncidents({ model: 'SynGPT-2.0' })).incidents.map((entry) => entry.incident_id), ['INC-3', 'INC-1']);
  assert.deepEqual((await adapter.listSafetyIncidents(CARD)).incidents.map((entry) => entry.incident_id), ['INC-3']);
  assert.deepEqual((await adapter.listSafetyIncidents({ useCase: 'CDSS' })).incidents.map((entry) => entry.incident_id), ['INC-2']);
  assert.deepEqual(incidentsAnswer(INCIDENTS, { model: 'nobody' }).incidents, []);
  await rejectsWith(adapter.listSafetyIncidents(CARD, { version: 'staged:abc' }), STATIC_REASONS.version);
});

test('a card’s change history is recorded per card; `after` is applied; the whole feed is not held', async () => {
  const { adapter } = fixture();
  const card = `${CARD.model}|${CARD.useCase}`;
  assert.deepEqual(await adapter.listDatasetVersions({ card }), VERSIONS);
  assert.deepEqual((await adapter.listDatasetVersions({ card, after: 12 })).versions.map((entry) => entry.version_id), [44, 37]);
  assert.deepEqual(cardVersionsAnswer(VERSIONS, { after: 44 }).versions, []);
  assert.deepEqual(await adapter.listDatasetVersions({ card: 'Nobody-1|Nothing' }), { dataset_version: '44', versions: [] });
  await assert.rejects(adapter.listDatasetVersions({ card: 'no-separator' }), { code: 'invalid_parameter' });
  await rejectsWith(adapter.listDatasetVersions({}), STATIC_REASONS.versions);
});

test('the card record is served as JSON and as JSON-LD', async () => {
  const { adapter } = fixture();
  assert.deepEqual(await adapter.getCardRecord(CARD), { format: 'bmc-card-record/1' });
  assert.equal((await adapter.getCardRecord({ ...CARD, format: 'jsonld' }))['@type'], 'obo:MCRO_0000001');
  await rejectsWith(adapter.getCardRecord(OTHER), STATIC_REASONS.missing);
  for (const name of ['getCdsServices', 'callCdsService', 'createEvaluationUpload', 'getEvaluationProposals', 'interpretQueryWithHelper', 'exportDataset']) {
    await assert.rejects(adapter[name]({}), (error) => error.code === STATIC_UNAVAILABLE, name);
  }
});

test('the group summary counts ICD-11 conditions, so one file serves every classification', async () => {
  const { adapter, requests } = fixture();
  assert.deepEqual(await adapter.getSubgroupSummary(CARD), { file: 'group-summary' });
  assert.deepEqual(await adapter.getSubgroupSummary({ ...CARD, ontology: 'mondo' }), { file: 'group-summary' });
  assert.equal(requests.filter((path) => path.endsWith('subgroup-summary.json')).length, 1);
  await rejectsWith(adapter.getSubgroupSummary({ ...CARD, population: 'northbridge-region' }), STATIC_REASONS.population);
  await rejectsWith(adapter.getSubgroupSummary({ ...CARD, ontology: 'icd10cm' }), STATIC_REASONS.ontology);
});

test('the static search matches synonyms, marked; the interpreter reads them and the settings', async () => {
  const { adapter } = fixture();
  const answer = await adapter.searchConcepts({ q: 'heart attack' });
  assert.deepEqual(
    answer.results.map((entry) => [entry.concept_id, entry.match, entry.matched_term]),
    [['BA41', 'synonym', 'heart attack']]
  );
  const read = await adapter.interpretQuery({ q: 'heart attack in older women in the emergency department' });
  assert.deepEqual(
    read.chips.map((chip) => [chip.kind, chip.value]),
    [['condition', 'BA41'], ['sex', 'Sex Female'], ['age', 'Age 65+'], ['setting', ED]]
  );
  assert.equal(read.chips[0].match, 'synonym');
  assert.equal(read.chips[0].matched_term, 'heart attack');
  // A snapshot without synonyms searches as before.
  const plain = createStaticAdapter({
    fetch: async (url) => {
      const path = url.replace(/^static-data\//, '');
      if (path === 'synonyms.json') return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ 'meta.json': { chapters: [CHAPTER.chapter] }, 'atlas/chapters/CH-11.json': CHAPTER }[path] ?? {}) };
    }
  });
  assert.equal((await plain.searchConcepts({ q: 'heart attack' })).total, 0);
});

test('the static atlas applies a setting on a card that stores it, in ICD-11, for all patients', () => {
  const selection = source('app/useModelSelection.js');
  assert.match(selection, /useState\(\(\) => specificSetting\(initial\.setting\)\)/, 'a setting URL parameter is accepted');
  assert.match(selection, /IS_STATIC_BUILD && setting && \(otherOntology\(ontology\) \|\| !selectedSettings\.includes\(setting\)\) \? null : setting/);
  assert.match(selection, /shownSetting \? STATIC_SETTING_LENS_NOTE/);
  assert.match(STATIC_SETTING_LENS_NOTE, /all patients only/);
  assert.match(staticSettingNotice(ICU), /holds Intensive care only for the cards that store results there/);
  // The comparison stays at Any setting in the static demo.
  assert.match(source('features/compare/CompareApp.jsx'), /const settingOptions = IS_STATIC_BUILD \? \[\]/);
});

test('the Summary offers the card record in the static build, without the dataset export', () => {
  const atlas = source('app/AtlasApp.jsx');
  assert.match(atlas, /onClick: IS_STATIC_BUILD \? null : handleExportDataset/);
  assert.match(atlas, /onCardRecord: handleExportCardRecord/);
  assert.match(source('features/summary/SummaryPanel.jsx'), /if \(!datasetExport\.onClick\) \{/);
});

test('the band names the stored care settings when the snapshot holds them', () => {
  const withSettings = staticNoticeText({ dataset_version: '44', recorded_at: '2026-10-22T08:00:00Z', ontologies: ['ICD-11', 'MONDO'], has_settings: true });
  assert.match(withSettings.detail, /one population group at a time, stored care settings for all patients, MONDO for all patients,/);
  assert.match(withSettings.detail, /Not for clinical use\.$/);
  assert.doesNotMatch(staticNoticeText({ dataset_version: '44' }).detail, /care settings/);
});
