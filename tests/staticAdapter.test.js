// The static adapter of the read-only GitHub Pages build: which recorded file each read maps to, the rebuilds of
// condition cards and multimorbidity answers, the search fallback, and the
// `static_unavailable` answers for everything the snapshot does not hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_CLIENT_METHODS, createDataClient } from '../frontend/src/api/dataClient.js';
import { STATIC_REASONS, STATIC_UNAVAILABLE, createStaticAdapter } from '../frontend/src/api/staticAdapter.js';
import { cardKey, lensKey, selectionKey, slug, staticPaths } from '../frontend/src/api/staticPaths.js';
import {
  combinationKey,
  conceptMetricsAnswer,
  conceptPath,
  chapterConceptsById,
  createConceptBundle,
  emptySelectionAnswer
} from '../frontend/src/api/staticRebuild.js';
import { createSearchIndex, matchRank } from '../frontend/src/api/staticSearch.js';
import { withOneGroup } from '../frontend/src/app/lensSelection.js';
import { siteNavItems } from '../frontend/src/design/siteNav.js';
import { staticNoticeText } from '../frontend/src/shared/staticNotice.js';
import { recordedLenses, subsets } from '../scripts/static/record.mjs';

const CARD = { model: 'ICU_GPT-1.0', useCase: 'Clinician Facing CDSS' };
const DIR = 'cards/ICU-GPT-1.0__Clinician-Facing-CDSS';

const concept = (id, fields = {}) => ({
  concept_id: id,
  icd11_code: id,
  pt: id,
  fsn: `${id} (ICD-11)`,
  level: 2,
  parent_id: null,
  chapter_id: 'CH-05',
  ...fields
});
const CHAPTER = {
  dataset_version: '19',
  chapter: concept('CH-05', { icd11_code: '05', pt: '05 Endocrine diseases', level: 0 }),
  blocks: [concept('BLK-05-A', { icd11_code: 'A', pt: 'Endocrine diseases', level: 1, parent_id: 'CH-05' })],
  concepts: [
    concept('5A11', { pt: 'Type 2 diabetes mellitus', parent_id: 'BLK-05-A' }),
    concept('5A11.0', { pt: 'Type 2 diabetes mellitus with complications', parent_id: 'BLK-05-A' })
  ]
};
const metrics = (id) => ({ concept_id: id, perf: 0.8, status: { overall: 'strong' } });
const collected = createConceptBundle('19');
['CH-05', 'BLK-05-A', '5A11', '5A11.0'].forEach((id) =>
  collected.add({ dataset_version: '19', concept: { concept_id: id }, path: [], metrics: metrics(id), incidents: [] })
);
const BUNDLE = collected.bundle;
const META = { dataset_version: '19', chapters: [CHAPTER.chapter], populations: [{ id: 'northbridge-region', name: 'Northbridge' }] };
const CANDIDATES_TEMPLATE = {
  dataset_version: '19',
  has_multimorbidity: true,
  selected: ['X'],
  combination_key: null,
  candidate_ids: [],
  display: { columns: ['concept_id'], rows: [] }
};
const COMBINATION_TEMPLATE = { dataset_version: '19', selected: ['X', 'Y'], combination_key: 'X+Y', combination_label: null, metrics: null };
const MM_INDEX = {
  candidates: ['none', '5A11', '5A11_GB61'],
  combinations: ['5A11_GB61'],
  templates: { candidates: { atlas: CANDIDATES_TEMPLATE, chapter: CANDIDATES_TEMPLATE }, combination: COMBINATION_TEMPLATE }
};
const PAIR = {
  atlas: { ...CANDIDATES_TEMPLATE, selected: ['5A11', 'GB61'], combination_key: '5A11+GB61', candidate_ids: ['BD10'], display: { columns: ['concept_id'], rows: [['BD10']] } },
  chapters: { 'CH-05': { ...CANDIDATES_TEMPLATE, selected: ['5A11', 'GB61'], combination_key: '5A11+GB61', candidate_ids: [] } }
};

/** A static adapter over an in-memory snapshot; `requests` lists every file it fetched. */
function fixture(extra = {}) {
  const files = {
    'meta.json': META,
    'models.json': { models: [] },
    'catalogue.json': { tiles: [] },
    'atlas/overview.json': { chapters: [] },
    'atlas/chapters/CH-05.json': CHAPTER,
    'atlas/concept-chapters.json': { 'CH-05': ['CH-05', 'BLK-05-A', '5A11', '5A11.0'] },
    [`${DIR}/all/concepts-CH-05.json`]: BUNDLE,
    [`${DIR}/all/mm/index.json`]: MM_INDEX,
    [`${DIR}/all/mm/candidates-5A11_GB61.json`]: PAIR,
    [`${DIR}/all/mm/combination-5A11_GB61.json`]: { ...COMBINATION_TEMPLATE, selected: ['5A11', 'GB61'], combination_key: '5A11+GB61', metrics: metrics('5A11+GB61') },
    ...extra
  };
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    const path = url.replace(/^static-data\//, '');
    if (!(path in files)) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(files[path]) };
  };
  return { adapter: createStaticAdapter({ fetch }), requests };
}

async function rejectsUnavailable(promise, detail) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, STATIC_UNAVAILABLE);
    assert.equal(error.title, 'Not in the static demo');
    if (detail) assert.equal(error.detail, detail);
    return true;
  });
}

test('names: slugs, card folders, lens folders, and selection keys', () => {
  assert.equal(slug('Age 65+'), 'Age-65plus');
  assert.equal(cardKey('ICU_GPT-1.0', 'Clinician Facing CDSS'), 'ICU-GPT-1.0__Clinician-Facing-CDSS');
  assert.equal(lensKey({}), 'all');
  assert.equal(lensKey({ age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' }), 'all');
  assert.equal(lensKey({ age: 'Age 65+' }), 'age-65plus');
  assert.equal(lensKey({ age: 'Age 0-17' }), 'age-0-17');
  assert.equal(lensKey({ sex: 'Sex Female', ethnicity: 'Ethnicity Black' }), 'sex-female__ethnicity-black');
  assert.equal(selectionKey([]), 'none');
  assert.equal(selectionKey(['GB61', '5A11', 'GB61']), '5A11_GB61');
  assert.equal(staticPaths.metricMap({ ...CARD, sex: 'Sex Male' }), `${DIR}/sex-male/map-atlas.json`);
  assert.equal(staticPaths.metricMap({ ...CARD, chapterId: 'CH-05' }), `${DIR}/all/map-CH-05.json`);
  assert.equal(staticPaths.metricSummary({ ...CARD, view: 'intended_use' }), `${DIR}/all/summary-intended-use.json`);
  assert.equal(staticPaths.conceptBundle({ ...CARD, chapterId: 'CH-05' }), `${DIR}/all/concepts-CH-05.json`);
});

test('every data-client method exists on the static adapter', () => {
  const { adapter } = fixture();
  assert.doesNotThrow(() => createDataClient(adapter));
  DATA_CLIENT_METHODS.forEach((method) => assert.equal(typeof adapter[method], 'function', method));
});

test('each read maps to its recorded file', async () => {
  const cases = [
    [(a) => a.getMeta(), 'meta.json'],
    [(a) => a.listModels(), 'models.json'],
    [(a) => a.getCatalogue(), 'catalogue.json'],
    [(a) => a.getAtlasOverview(), 'atlas/overview.json'],
    [(a) => a.getChapter({ chapterId: 'CH-05' }), 'atlas/chapters/CH-05.json'],
    [(a) => a.getMetricMap({ ...CARD, age: 'All ages', scope: 'atlas' }), `${DIR}/all/map-atlas.json`],
    [(a) => a.getMetricMap({ ...CARD, scope: 'chapter', chapterId: 'CH-05', ethnicity: 'Ethnicity Asian' }), `${DIR}/ethnicity-asian/map-CH-05.json`],
    [(a) => a.getMetricSummary({ ...CARD, view: 'safety', age: 'Age 18-39' }), `${DIR}/age-18-39/summary-safety.json`]
  ];
  for (const [read, file] of cases) {
    const { adapter, requests } = fixture({ [file]: { file } });
    await read(adapter);
    // /meta also reads the manifest, for the classifications the snapshot holds.
    assert.deepEqual(requests.filter((url) => url !== 'static-data/manifest.json'), [`static-data/${file}`]);
  }
});

test('the same file is fetched once', async () => {
  const { adapter, requests } = fixture();
  await Promise.all([adapter.getAtlasOverview(), adapter.getAtlasOverview()]);
  await adapter.getAtlasOverview();
  assert.equal(requests.length, 1);
});

test('/meta lists no local populations: the snapshot holds the default prevalence', async () => {
  const { adapter } = fixture();
  const meta = await adapter.getMeta();
  assert.deepEqual(meta.populations, []);
  assert.equal(meta.dataset_version, '19');
  // ICD-11 only (contract v1.13): the snapshot records no other classification, so the choice stays hidden.
  assert.deepEqual(meta.ontologies.map((entry) => entry.id), ['icd11']);
});

test('reads in a classification the snapshot did not record say so (contract v1.13)', async () => {
  const { adapter } = fixture();
  for (const read of [
    (a) => a.getAtlasOverview({ ontology: 'mondo' }),
    (a) => a.getChapter({ chapterId: 'MONDO:0005066', ontology: 'mondo' }),
    (a) => a.getMetricMap({ ...CARD, scope: 'atlas', ontology: 'icd10cm' }),
    (a) => a.getMetricSummary({ ...CARD, view: 'overall', ontology: 'icd10cm' }),
    (a) => a.getConceptMetrics({ ...CARD, conceptId: 'E11', ontology: 'icd10cm' }),
    (a) => a.searchConcepts({ q: 'diabetes', ontology: 'mondo' })
  ]) {
    await assert.rejects(read(adapter), { code: 'static_unavailable', detail: STATIC_REASONS.ontology });
  }
  // icd11 named explicitly is the default read.
  assert.ok(await adapter.getAtlasOverview({ ontology: 'icd11' }));
});

test('a condition card is rebuilt from its chapter bundle and the chapter file', async () => {
  const { adapter, requests } = fixture();
  const answer = await adapter.getConceptMetrics({ ...CARD, conceptId: '5A11.0' });
  assert.deepEqual(
    answer.path.map((entry) => entry.concept_id),
    ['CH-05', 'BLK-05-A', '5A11.0']
  );
  assert.equal(answer.concept.pt, 'Type 2 diabetes mellitus with complications');
  assert.deepEqual(answer.metrics, metrics('5A11.0'));
  assert.equal(answer.dataset_version, '19');
  assert.ok(requests.includes(`static-data/${DIR}/all/concepts-CH-05.json`));
  const chapter = await adapter.getConceptMetrics({ ...CARD, conceptId: 'CH-05' });
  assert.deepEqual(chapter.path.map((entry) => entry.concept_id), ['CH-05']);
  await assert.rejects(adapter.getConceptMetrics({ ...CARD, conceptId: 'ZZZZ' }), { code: 'unknown_concept' });
});

test('conceptPath and conceptMetricsAnswer are pure structure', () => {
  const byId = chapterConceptsById(CHAPTER);
  assert.deepEqual(conceptPath('BLK-05-A', byId).map((entry) => entry.concept_id), ['CH-05', 'BLK-05-A']);
  assert.equal(conceptMetricsAnswer(BUNDLE, CHAPTER, 'missing'), null);
});

test('multimorbidity: a recorded selection keeps the reader’s order, others get the empty answer', async () => {
  const { adapter, requests } = fixture();
  const pair = await adapter.getMultimorbidityCandidates({ ...CARD, selected: ['GB61', '5A11'], scope: 'atlas' });
  assert.deepEqual(pair.selected, ['GB61', '5A11']);
  assert.deepEqual(pair.candidate_ids, ['BD10']);
  assert.ok(requests.includes(`static-data/${DIR}/all/mm/candidates-5A11_GB61.json`));
  const inChapter = await adapter.getMultimorbidityCandidates({ ...CARD, selected: ['5A11', 'GB61'], scope: 'chapter', chapterId: 'CH-05' });
  assert.deepEqual(inChapter.candidate_ids, []);

  const other = await adapter.getMultimorbidityCandidates({ ...CARD, selected: ['1A00', '5A11'], scope: 'atlas' });
  assert.deepEqual(other.selected, ['1A00', '5A11']);
  assert.equal(other.combination_key, '1A00+5A11');
  assert.deepEqual(other.candidate_ids, []);
  assert.deepEqual(other.display.rows, []);

  const combination = await adapter.getMultimorbidityCombination({ ...CARD, selected: ['GB61', '5A11'] });
  assert.deepEqual(combination.selected, ['GB61', '5A11']);
  assert.equal(combination.metrics.concept_id, '5A11+GB61');
  const none = await adapter.getMultimorbidityCombination({ ...CARD, selected: ['1A00', '5A11'] });
  assert.equal(none.metrics, null);
  assert.equal(none.combination_label, null);
  assert.equal(none.combination_key, '1A00+5A11');
  await assert.rejects(adapter.getMultimorbidityCombination({ ...CARD, selected: ['5A11'] }), { code: 'invalid_selection' });
});

test('empty answers: combination keys need two conditions', () => {
  assert.equal(combinationKey(['5A11']), null);
  assert.equal(combinationKey(['GB61', '5A11', 'GB61']), '5A11+GB61');
  const single = emptySelectionAnswer(CANDIDATES_TEMPLATE, ['1A00']);
  assert.equal(single.combination_key, null);
  assert.deepEqual(single.selected, ['1A00']);
});

test('search ranks like CONTRACT.md §9 over the chapter files', async () => {
  const index = createSearchIndex([
    concept('5A10', { pt: 'Type 1 diabetes mellitus' }),
    concept('5A11', { pt: 'Type 2 diabetes mellitus' }),
    concept('5A11.0', { pt: 'Type 2 diabetes mellitus with complications' }),
    concept('JA63', { pt: 'Diabetes mellitus in pregnancy' }),
    concept('5A2', { pt: 'Hypoglycaemia in the context of diabetes mellitus' }),
    concept('5B00', { pt: 'Prediabetes' }),
    concept('BLK-1', { icd11_code: 'Diabetes', pt: '- Diabetes', level: 1 })
  ]);
  assert.equal(matchRank('5a11', '5a11', 'type 2 diabetes mellitus'), 0);
  assert.equal(matchRank('5a1', '5a11', 'x'), 1);
  assert.equal(matchRank('diab', 'x', 'type 2 diabetes mellitus'), 4);
  assert.equal(matchRank('iabet', 'x', 'prediabetes'), 5);
  const diabetes = index.search(' diabetes ', 80);
  assert.equal(diabetes.query, 'diabetes');
  assert.equal(diabetes.total, 7);
  // The code "diabetes" first, then whole-word matches by term length, then "prediabetes".
  assert.deepEqual(
    diabetes.results.map((entry) => entry.concept_id),
    ['BLK-1', '5A10', '5A11', 'JA63', '5A11.0', '5A2', '5B00']
  );
  assert.deepEqual(index.search('5A1', 2).results.map((entry) => entry.concept_id), ['5A10', '5A11']);
  assert.equal(index.search('   '), null);

  const { adapter } = fixture();
  const answer = await adapter.searchConcepts({ q: 'type 2', limit: 5 });
  assert.deepEqual(answer.results.map((entry) => entry.concept_id), ['5A11', '5A11.0']);
  await assert.rejects(adapter.searchConcepts({ q: ' ' }), { code: 'invalid_query' });
});

test('reads the snapshot does not hold say so in words', async () => {
  const { adapter } = fixture();
  await rejectsUnavailable(adapter.getMetricMap({ ...CARD, scope: 'atlas', age: 'Age 65+', sex: 'Sex Male' }), STATIC_REASONS.combinedLens);
  await rejectsUnavailable(adapter.getConceptMetrics({ ...CARD, conceptId: '5A11', sex: 'Sex Female' }), STATIC_REASONS.detailsLens);
  await rejectsUnavailable(
    adapter.getMultimorbidityCandidates({ ...CARD, selected: [], scope: 'atlas', age: 'Age 65+' }),
    STATIC_REASONS.multimorbidityLens
  );
  await rejectsUnavailable(adapter.getMetricMap({ ...CARD, scope: 'atlas', population: 'northbridge-region' }), STATIC_REASONS.population);
  await rejectsUnavailable(adapter.getCatalogue({}, { version: 'staged:abc' }), STATIC_REASONS.version);
  await rejectsUnavailable(adapter.getMetricMap({ ...CARD, scope: 'atlas', sex: 'Sex Male' }), STATIC_REASONS.missing);
  await rejectsUnavailable(adapter.exportConcept({ ...CARD, conceptId: '5A11' }), STATIC_REASONS.exports);
  await rejectsUnavailable(adapter.exportDataset(CARD), STATIC_REASONS.exports);
  await rejectsUnavailable(adapter.lookup({}), STATIC_REASONS.lookup);
  // R7: comparisons with two groups, or in a classification at a group, are not recorded.
  await rejectsUnavailable(adapter.getComparison({ cards: ['SynGPT-2.0|CDSS', 'ICU_GPT-1.0|CDSS'], age: 'Age 65+', sex: 'Sex Male' }), STATIC_REASONS.combinedLens);
  await rejectsUnavailable(adapter.getConceptSubgroups({ ...CARD, conceptId: '5A11', population: 'northbridge-region' }), STATIC_REASONS.population);
  await rejectsUnavailable(adapter.createUpload({}), STATIC_REASONS.writes);
  await rejectsUnavailable(adapter.publishUpload({}), STATIC_REASONS.writes);
  await rejectsUnavailable(adapter.rollbackVersion({}), STATIC_REASONS.writes);
  assert.equal(adapter.getTemplateUrl({ kind: 'models' }), '#');
  // A staged version given to the adapter as the default is refused too.
  const staged = createStaticAdapter({ fetch: async () => ({ ok: true, json: async () => ({}) }), defaultVersion: 'staged:abc' });
  await rejectsUnavailable(staged.getAtlasOverview(), STATIC_REASONS.version);
});

test('the static build keeps one population group: the axis just chosen wins', () => {
  const all = { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
  assert.equal(withOneGroup(all), all);
  assert.deepEqual(withOneGroup({ ...all, age: 'Age 65+', sex: 'Sex Male' }, 'sex'), { ...all, sex: 'Sex Male' });
  assert.deepEqual(withOneGroup({ ...all, age: 'Age 65+', sex: 'Sex Male' }), { ...all, age: 'Age 65+' });
  assert.deepEqual(withOneGroup({ ...all, age: 'Age 65+', sex: 'All sexes' }, 'sex'), { ...all, age: 'Age 65+' });
});

test('the static build links to the catalogue and the comparison and names itself', () => {
  assert.deepEqual(siteNavItems('atlas', { isStatic: true }).map((page) => page.id), ['catalogue', 'compare']);
  assert.deepEqual(siteNavItems('atlas', { isStatic: false }).map((page) => page.id), ['catalogue', 'compare', 'admin', 'plugin']);
  const { title, detail } = staticNoticeText({ dataset_version: '19', recorded_at: '2026-10-19T08:00:00Z' });
  assert.equal(title, 'Static synthetic demo');
  assert.match(detail, /dataset version 19, recorded 19 October 2026/);
  assert.match(detail, /Not for clinical use\./);
  assert.match(staticNoticeText(null).detail, /^A read-only snapshot:/);
  const release = staticNoticeText({ release_version: '0.4.0', dataset_version: '25', recorded_at: '2026-10-20T08:00:00Z', ontologies: ['ICD-11', 'MONDO'] });
  assert.match(release.detail, /^A read-only snapshot of release 0\.4\.0, dataset version 25, recorded 20 October 2026:/);
  assert.match(release.detail, /MONDO for all patients/);
});

test('the recorder records the default lens and each group alone, and every subset of the stored conditions', () => {
  const axes = { age: ['All ages', 'Age 65+'], sex: ['All sexes', 'Sex Female', 'Sex Male'], ethnicity: ['All ethnicities'] };
  assert.deepEqual(recordedLenses(axes).map(lensKey), ['all', 'age-65plus', 'sex-female', 'sex-male']);
  assert.deepEqual(recordedLenses(axes, 'default').map(lensKey), ['all']);
  assert.deepEqual(subsets(['a', 'b', 'c'], 2), [['a'], ['b'], ['c'], ['a', 'b'], ['a', 'c'], ['b', 'c']]);
});
