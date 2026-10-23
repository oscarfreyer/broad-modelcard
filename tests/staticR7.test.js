// The static demo's new recordings (release 0.4):
// other classifications, condition cards with appraisal, mapping, and effects,
// Across groups, study and effect lists, and the comparison, which the static
// adapter computes from per-card inputs with a port of the backend's rule
// (CONTRACT.md §25). The recorder checks every rebuild against the API; these
// tests pin the request-to-file mapping, the rebuilds, and the port's rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATIC_REASONS, createStaticAdapter } from '../frontend/src/api/staticAdapter.js';
import { ontologyRoot, staticPaths } from '../frontend/src/api/staticPaths.js';
import {
  conceptMetricsAnswer,
  conceptSubgroupsAnswer,
  createConceptBundle,
  createSubgroupBundle,
  effectsAnswer,
  studiesAnswer,
  studyAnswer
} from '../frontend/src/api/staticRebuild.js';
import {
  CELL_FIELDS,
  cardReasons,
  comparisonAnswer,
  decodeCell,
  encodeCell,
  parseCardIds,
  perfSpread,
  referenceGroup,
  rowReasons
} from '../frontend/src/api/staticComparison.js';
import { createSearchIndex, searchCode } from '../frontend/src/api/staticSearch.js';
import { ALL_LENS } from '../frontend/src/app/startupParams.js';
import { staticLens } from '../frontend/src/app/lensSelection.js';
import { parseArgs, parseOntologies, seededRandom } from '../scripts/static/record.mjs';

const CARD = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' };
const DIR = 'cards/SynGPT-2.0__Clinician-Facing-CDSS';
const MONDO_DIR = `ontologies/mondo/${DIR}`;
const MONDO = { id: 'mondo', name: 'MONDO' };

const icdConcept = (id, fields = {}) => ({ concept_id: id, icd11_code: id, pt: id, fsn: null, level: 2, parent_id: 'BLK-05-A', chapter_id: 'CH-05', depth_in_kind: 1, ...fields });
const ICD_CHAPTER = {
  dataset_version: '25',
  chapter: icdConcept('CH-05', { icd11_code: '05', pt: 'Endocrine diseases', level: 0, parent_id: null, depth_in_kind: null }),
  blocks: [icdConcept('BLK-05-A', { icd11_code: null, pt: 'Diabetes', level: 1, parent_id: 'CH-05', depth_in_kind: null })],
  concepts: [icdConcept('5A11', { pt: 'Type 2 diabetes mellitus' }), icdConcept('5A11.0', { pt: 'Type 2 diabetes with complications', depth_in_kind: 2, parent_id: '5A11' })]
};
const mondoConcept = (id, fields = {}) => ({
  concept_id: id,
  icd11_code: null,
  code: id,
  pt: id,
  fsn: null,
  level: 2,
  parent_id: 'MONDO:B',
  chapter_id: 'MONDO:C',
  chapter_no: '01',
  depth_in_kind: 1,
  ...fields
});
const MONDO_CHAPTER = {
  dataset_version: '25',
  chapter: mondoConcept('MONDO:C', { pt: 'Metabolic disease', level: 0, parent_id: null, depth_in_kind: null }),
  blocks: [mondoConcept('MONDO:B', { pt: 'Diabetes mellitus', level: 1, parent_id: 'MONDO:C', depth_in_kind: null })],
  concepts: [mondoConcept('MONDO:0005148', { pt: 'type 2 diabetes mellitus' }), mondoConcept('MONDO:0000001', { pt: 'unmapped disease' })],
  ontology: MONDO
};

const row = (perf, extra = {}) => ({ model_version: 'SynGPT-2.0', perf, status: { overall: 'strong' }, ...extra });

/** A static adapter over an in-memory snapshot; `requests` lists every file it fetched. */
function fixture(files) {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    const path = url.replace(/^static-data\//, '');
    if (!(path in files)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(files[path]) };
  };
  return { adapter: createStaticAdapter({ fetch }), requests };
}

const unavailable = (detail) => (error) => error.code === 'static_unavailable' && (!detail || error.detail === detail);

// ------------------------------------------------------------ names and the recorder's options

test('another classification puts its files under ontologies/<id>/; ICD-11 keeps its paths', () => {
  assert.equal(ontologyRoot(null), '');
  assert.equal(ontologyRoot('icd11'), '');
  assert.equal(ontologyRoot('mondo'), 'ontologies/mondo/');
  assert.equal(staticPaths.atlasOverview('mondo'), 'ontologies/mondo/atlas/overview.json');
  assert.equal(staticPaths.chapter('MONDO:0005066', 'mondo'), 'ontologies/mondo/atlas/chapters/MONDO-0005066.json');
  assert.equal(staticPaths.conceptMappings('MONDO:C', 'mondo'), 'ontologies/mondo/atlas/mappings-MONDO-C.json');
  assert.equal(staticPaths.metricMap({ ...CARD, ontology: 'mondo', chapterId: 'MONDO:C' }), `${MONDO_DIR}/all/map-MONDO-C.json`);
  assert.equal(staticPaths.metricMap({ ...CARD, ontology: 'icd11' }), `${DIR}/all/map-atlas.json`);
  assert.equal(staticPaths.comparisonCard({ ...CARD, age: 'Age 65+' }), `${DIR}/age-65plus/compare.json`);
  assert.equal(staticPaths.comparisonRows('mondo'), 'ontologies/mondo/compare/rows.json');
  assert.equal(staticPaths.subgroupBundle({ ...CARD, chapterId: 'CH-05' }), `${DIR}/all/subgroups-CH-05.json`);
  assert.equal(staticPaths.studies(), 'studies.json');
  assert.equal(staticPaths.effects(), 'effects.json');
});

test('the recorder records all three classifications by default (2026-10-20); fewer by flag or environment', () => {
  assert.deepEqual(parseOntologies(''), ['icd11', 'mondo', 'icd10cm']);
  assert.deepEqual(parseOntologies('mondo, icd11,icd10cm,mondo'), ['icd11', 'mondo', 'icd10cm']);
  assert.throws(() => parseOntologies('mondo'), /must include icd11/);
  assert.throws(() => parseOntologies('icd11,MON DO'), /not an ontology id/);
  assert.deepEqual(parseArgs([], {}).ontologies, ['icd11', 'mondo', 'icd10cm']);
  assert.deepEqual(parseArgs([], { BMC_STATIC_ONTOLOGIES: 'icd11,mondo' }).ontologies, ['icd11', 'mondo']);
  assert.deepEqual(parseArgs(['--ontologies', 'icd11'], { BMC_STATIC_ONTOLOGIES: 'icd11,mondo,icd10cm' }).ontologies, ['icd11']);
  const a = seededRandom(7);
  const b = seededRandom(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()], 'the comparison sample is the same at every recording');
});

test('the static lens: one group in ICD-11, all patients in another classification', () => {
  assert.equal(staticLens(ALL_LENS, { isOtherOntology: true }), ALL_LENS);
  assert.equal(staticLens({ ...ALL_LENS, age: 'Age 65+' }, { isOtherOntology: true }), ALL_LENS);
  assert.deepEqual(staticLens({ ...ALL_LENS, age: 'Age 65+', sex: 'Sex Male' }, { axis: 'sex' }), { ...ALL_LENS, sex: 'Sex Male' });
});

// ------------------------------------------------------------ condition cards

test('a condition card keeps its appraisal and effects; rows are stored once per chapter', () => {
  const appraisal = { study: { study_id: 'NBR-2026-01' }, study_adjustment: 0.05, applied: true, terms: null };
  const effects = [{ effect_id: 'EFF-1', outcome: 'Time to treatment', study: null }];
  const answers = [
    { dataset_version: '25', concept: ICD_CHAPTER.concepts[0], path: [], metrics: { concept_id: '5A11', ...row(0.79, { appraisal }) }, incidents: [], effects },
    // A deeper category serves its anchor's row with the anchor's id.
    { dataset_version: '25', concept: ICD_CHAPTER.concepts[1], path: [], metrics: { concept_id: '5A11', ...row(0.79, { appraisal }) }, incidents: [] },
    { dataset_version: '25', concept: ICD_CHAPTER.blocks[0], path: [], metrics: null, incidents: [{ id: 'INC-1' }] }
  ];
  const collector = createConceptBundle('25');
  answers.forEach((answer) => collector.add(answer));
  assert.equal(collector.bundle.rows.length, 1, 'the same row is stored once');
  assert.deepEqual(collector.mappings, {}, 'ICD-11 has no mappings');
  const card = conceptMetricsAnswer(collector.bundle, ICD_CHAPTER, '5A11');
  assert.deepEqual(card.metrics.appraisal, appraisal);
  assert.deepEqual(card.effects, effects);
  assert.deepEqual(card.path.map((entry) => entry.concept_id), ['CH-05', 'BLK-05-A', '5A11']);
  const deeper = conceptMetricsAnswer(collector.bundle, ICD_CHAPTER, '5A11.0');
  assert.equal(deeper.metrics.concept_id, '5A11');
  assert.equal('effects' in deeper, false, 'no effects key without effects (byte-identical reads)');
  const block = conceptMetricsAnswer(collector.bundle, ICD_CHAPTER, 'BLK-05-A');
  assert.equal(block.metrics, null);
  assert.deepEqual(block.incidents, [{ id: 'INC-1' }]);
});

const MAPPING = { kind: 'exact', icd11: { concept_id: '5A11', code: '5A11', pt: 'Type 2 diabetes mellitus', level: 2 }, via: null, steps: 0, source: 'mondo-icd11-foundation', source_code: 'x', icd11_code: '5A11' };

function mondoFiles() {
  const collector = createConceptBundle('25', MONDO);
  collector.add({ dataset_version: '25', concept: MONDO_CHAPTER.concepts[0], path: [], metrics: { concept_id: 'MONDO:0005148', ...row(0.79) }, incidents: [], mapping: MAPPING, other_parents: [], ontology: MONDO });
  collector.add({ dataset_version: '25', concept: MONDO_CHAPTER.concepts[1], path: [], metrics: null, incidents: [], mapping: { kind: 'none' }, other_parents: [], ontology: MONDO });
  collector.add({ dataset_version: '25', concept: MONDO_CHAPTER.blocks[0], path: [], metrics: { concept_id: 'MONDO:B', ...row(0.7) }, incidents: [], mapping: null, ontology: MONDO });
  collector.add({ dataset_version: '25', concept: MONDO_CHAPTER.chapter, path: [], metrics: { concept_id: 'MONDO:C', ...row(0.7) }, incidents: [], mapping: null, ontology: MONDO });
  const ids = ['MONDO:C', 'MONDO:B', 'MONDO:0005148', 'MONDO:0000001'];
  return {
    'manifest.json': { ontologies: ['icd11', 'mondo'] },
    'meta.json': {
      dataset_version: '25',
      chapters: [ICD_CHAPTER.chapter],
      populations: [{ id: 'northbridge-region' }],
      ontologies: [{ id: 'icd11', name: 'ICD-11' }, { id: 'icd10cm', name: 'ICD-10-CM' }, MONDO]
    },
    'ontologies/mondo/atlas/overview.json': { dataset_version: '25', chapters: [MONDO_CHAPTER.chapter], ontology: MONDO },
    'ontologies/mondo/atlas/chapters/MONDO-C.json': MONDO_CHAPTER,
    'ontologies/mondo/atlas/concept-chapters.json': { 'MONDO:C': ids },
    'ontologies/mondo/atlas/mappings-MONDO-C.json': collector.mappings,
    [`${MONDO_DIR}/all/concepts-MONDO-C.json`]: collector.bundle,
    [`${MONDO_DIR}/all/map-atlas.json`]: { file: 'map' },
    [`${MONDO_DIR}/all/summary-overall.json`]: { file: 'summary' }
  };
}

test('a recorded classification: /meta lists it, its reads map to its files, a group says all patients only', async () => {
  const { adapter, requests } = fixture(mondoFiles());
  const meta = await adapter.getMeta();
  assert.deepEqual(meta.ontologies.map((entry) => entry.id), ['icd11', 'mondo'], 'ICD-10-CM was not recorded');
  assert.deepEqual(meta.populations, []);
  assert.deepEqual(await adapter.getMetricMap({ ...CARD, scope: 'atlas', ontology: 'mondo' }), { file: 'map' });
  assert.deepEqual(await adapter.getMetricSummary({ ...CARD, view: 'overall', ontology: 'mondo' }), { file: 'summary' });
  assert.ok(requests.includes(`static-data/${MONDO_DIR}/all/map-atlas.json`));
  await assert.rejects(adapter.getMetricMap({ ...CARD, scope: 'atlas', ontology: 'mondo', age: 'Age 65+' }), unavailable(STATIC_REASONS.ontologyLens));
  await assert.rejects(adapter.getMetricMap({ ...CARD, scope: 'atlas', ontology: 'icd10cm' }), unavailable(STATIC_REASONS.ontology));
  await assert.rejects(adapter.getConceptMetrics({ ...CARD, conceptId: 'MONDO:0005148', ontology: 'mondo', sex: 'Sex Male' }), unavailable(STATIC_REASONS.detailsLens));

  const card = await adapter.getConceptMetrics({ ...CARD, conceptId: 'MONDO:0005148', ontology: 'mondo' });
  assert.deepEqual(card.mapping, MAPPING);
  assert.deepEqual(card.other_parents, []);
  assert.deepEqual(card.ontology, MONDO);
  assert.equal(card.metrics.concept_id, 'MONDO:0005148');
  assert.deepEqual(card.path.map((entry) => entry.concept_id), ['MONDO:C', 'MONDO:B', 'MONDO:0005148']);
  const unmapped = await adapter.getConceptMetrics({ ...CARD, conceptId: 'MONDO:0000001', ontology: 'mondo' });
  assert.equal(unmapped.metrics, null);
  assert.equal(unmapped.mapping.kind, 'none');
  const chapter = await adapter.getConceptMetrics({ ...CARD, conceptId: 'MONDO:C', ontology: 'mondo' });
  assert.equal(chapter.mapping, null);
  assert.equal('other_parents' in chapter, false);
  await assert.rejects(adapter.getConceptMetrics({ ...CARD, conceptId: '5A11', ontology: 'mondo' }), { code: 'unknown_concept' });
});

test('search in another classification uses its own codes and names it', async () => {
  assert.equal(searchCode({ concept_id: 'X', icd11_code: '5A11' }), '5A11');
  assert.equal(searchCode({ concept_id: 'BLK-1', icd11_code: null }), 'BLK-1');
  assert.equal(searchCode({ concept_id: 'MONDO:1', code: 'MONDO:1', icd11_code: null }, true), 'MONDO:1');
  assert.equal(searchCode({ concept_id: 'ICD10CM:CH-04', code: null, level: 0, chapter_no: '04' }, true), '04');
  const index = createSearchIndex([...MONDO_CHAPTER.concepts, MONDO_CHAPTER.chapter], { isOtherOntology: true, ontology: MONDO });
  const answer = index.search('MONDO:0005148');
  assert.deepEqual(answer.results.map((entry) => entry.concept_id), ['MONDO:0005148']);
  assert.deepEqual(answer.ontology, MONDO);
  const { adapter } = fixture(mondoFiles());
  const found = await adapter.searchConcepts({ q: 'diabetes', ontology: 'mondo' });
  assert.deepEqual(found.results.map((entry) => entry.concept_id), ['MONDO:B', 'MONDO:0005148'], 'the shorter name first (§9)');
  assert.deepEqual(found.ontology, MONDO);
});

// ------------------------------------------------------------ Across groups

const subgroupResult = (axis, group, perf, extra = {}) => ({
  axis,
  group,
  lens: { ...ALL_LENS, ...(axis === 'all' ? {} : { [axis]: group }) },
  has_result: perf !== null,
  perf,
  ci_low: perf === null ? null : perf - 0.02,
  ci_high: perf === null ? null : perf + 0.02,
  performance_grade: perf === null ? null : 'C',
  evidence_grade: perf === null ? null : 'B',
  overall: { tier: perf === null ? 'no_data' : 'graded', score: perf, grade: perf === null ? null : 'C' },
  status: { overall: perf === null ? 'no_data' : 'moderate', performance: 'moderate', evidence: 'moderate' },
  intended_use_level: null,
  safety: null,
  provenance: perf === null ? null : { source: 'condition', anchor_concept_id: null, rollup: null, lens_fallback: false, data_source: { source: 'Seed', study: null, date: null } },
  ...extra
});

test('Across groups is rebuilt from its chapter bundle; other concepts say so in words', async () => {
  const difference = (delta, flagged, reason) => ({ difference: { delta, direction: delta > 0 ? 'higher' : delta < 0 ? 'lower' : null, flagged, reason } });
  const answer = {
    dataset_version: '25',
    concept: ICD_CHAPTER.concepts[0],
    filters: { model: CARD.model, use_case: CARD.useCase, context: 'Clinical' },
    all_patients: subgroupResult('all', null, 0.79),
    groups: [subgroupResult('age', 'Age 65+', 0.66, difference(-0.13, true, 'separated')), subgroupResult('sex', 'Sex Male', null, difference(null, false, 'no_result'))]
  };
  const collector = createSubgroupBundle('25');
  collector.add(answer);
  assert.deepEqual(conceptSubgroupsAnswer(collector.bundle, ICD_CHAPTER, '5A11'), answer);
  assert.equal(conceptSubgroupsAnswer(collector.bundle, ICD_CHAPTER, '5A11.0'), null);
  assert.equal('difference' in conceptSubgroupsAnswer(collector.bundle, ICD_CHAPTER, '5A11').all_patients, false);

  const { adapter } = fixture({
    'meta.json': { dataset_version: '25', chapters: [ICD_CHAPTER.chapter] },
    'atlas/chapters/CH-05.json': ICD_CHAPTER,
    'atlas/concept-chapters.json': { 'CH-05': ['CH-05', 'BLK-05-A', '5A11', '5A11.0'] },
    [`${DIR}/all/subgroups-CH-05.json`]: collector.bundle
  });
  assert.deepEqual(await adapter.getConceptSubgroups({ ...CARD, conceptId: '5A11' }), answer);
  // No lens parameters: the same answer at every lens.
  assert.deepEqual(await adapter.getConceptSubgroups({ ...CARD, conceptId: '5A11', age: 'Age 65+' }), answer);
  await assert.rejects(adapter.getConceptSubgroups({ ...CARD, conceptId: '5A11.0' }), unavailable(STATIC_REASONS.subgroups));
  await assert.rejects(adapter.getConceptSubgroups({ ...CARD, conceptId: 'BLK-05-A' }), unavailable(STATIC_REASONS.subgroups));
  await assert.rejects(adapter.getConceptSubgroups({ ...CARD, conceptId: 'NOPE' }), { code: 'unknown_concept' });
});

// ------------------------------------------------------------ studies and effects

const STUDIES = {
  dataset_version: '25',
  studies: [
    { study_id: 'NBR-2026-01', model_version: 'SynGPT-2.0', design: 'prospective' },
    { study_id: 'RAD-RCT-2026', model_version: 'radAIology-1', design: 'randomized_trial' }
  ]
};
const EFFECTS = {
  dataset_version: '25',
  effects: [
    { effect_id: 'EFF-VT-01', model_version: 'Vantrel-Triage-2.1', use_case: 'Emergency department triage' },
    { effect_id: 'EFF-Q-01', model_version: 'Quillary-Scribe-1.0', use_case: 'Discharge letter generation' }
  ]
};

test('studies and effects are served from their recorded lists, with the API’s filters', async () => {
  assert.deepEqual(studiesAnswer(STUDIES, {}), STUDIES);
  assert.deepEqual(studiesAnswer(STUDIES, { model: 'radAIology-1' }).studies.map((study) => study.study_id), ['RAD-RCT-2026']);
  assert.deepEqual(studiesAnswer(STUDIES, { model: 'nobody' }).studies, []);
  assert.deepEqual(studyAnswer(STUDIES, 'NBR-2026-01'), { dataset_version: '25', study: STUDIES.studies[0] });
  assert.equal(studyAnswer(STUDIES, 'NOPE'), null);
  assert.deepEqual(effectsAnswer(EFFECTS, { model: 'Vantrel-Triage-2.1', useCase: 'Emergency department triage' }).effects.length, 1);
  assert.deepEqual(effectsAnswer(EFFECTS, { model: 'Vantrel-Triage-2.1', useCase: 'Other' }).effects, []);
  const { adapter, requests } = fixture({ 'studies.json': STUDIES, 'effects.json': EFFECTS });
  assert.equal((await adapter.listStudies({ model: 'SynGPT-2.0' })).studies.length, 1);
  assert.equal((await adapter.getStudy({ studyId: 'RAD-RCT-2026' })).study.design, 'randomized_trial');
  await assert.rejects(adapter.getStudy({ studyId: 'NOPE' }), { code: 'unknown_study' });
  assert.equal((await adapter.listEffects({})).effects.length, 2);
  await assert.rejects(adapter.listStudies({}, { version: 'staged:abc' }), unavailable(STATIC_REASONS.version));
  assert.deepEqual(requests, ['static-data/studies.json', 'static-data/effects.json']);
});

// ------------------------------------------------------------ the comparison port

const cell = (status, fields = {}) => ({
  status,
  performance_status: status,
  evidence_status: status,
  perf: ['strong', 'moderate', 'weak'].includes(status) ? 0.8 : null,
  ci_low: null,
  ci_high: null,
  evidence_grade: null,
  validation_type: null,
  study_design: null,
  design_group: null,
  lens_fallback: false,
  safety: null,
  ...fields
});
const facts = (cardId, fields = {}) => ({ card_id: cardId, function_category: 'decision_support', lenses: { requested: 'stored' }, ...fields });
const A = facts('A|f');
const B = facts('B|f');
const C = facts('C|f');
const codes = (reasons) => reasons.map((reason) => `${reason.code}:${reason.cards.join('+')}`);

test('card ids: 2 to 4, distinct, <model>|<function>, as the API refuses them', () => {
  assert.deepEqual(parseCardIds(['A|f', 'B|g']).pairs.map((pair) => pair.model), ['A', 'B']);
  assert.match(parseCardIds(['A|f']).error, /2 to 4 cards; got 1/);
  assert.match(parseCardIds([]).error, /got 0/);
  assert.match(parseCardIds(['A|f', 'B|g', 'C|h', 'D|i', 'E|j']).error, /got 5/);
  assert.match(parseCardIds(['A|f', 'A|f']).error, /named twice/);
  assert.match(parseCardIds(['A|f', 'Bf']).error, /Invalid card id/);
  assert.match(parseCardIds(['A|f', 'B|g|h']).error, /Invalid card id/);
  assert.match(parseCardIds('A|f,,B|g').error, /Invalid card id ''/);
});

test('card-level reasons: function categories and the population (CONTRACT.md §25)', () => {
  assert.deepEqual(cardReasons([A, B], ALL_LENS), []);
  const triage = facts('T|t', { function_category: 'triage' });
  assert.deepEqual(codes(cardReasons([A, triage, B], ALL_LENS)), ['function_category_differs:T|t']);
  // A tie goes to the first card's category.
  assert.deepEqual(codes(cardReasons([triage, A], ALL_LENS)), ['function_category_differs:A|f']);
  const unknown = facts('U|u', { function_category: null });
  assert.deepEqual(codes(cardReasons([A, unknown], ALL_LENS)), ['function_category_unknown:U|u']);
  const none = facts('P|p', { lenses: { requested: 'none' } });
  assert.deepEqual(codes(cardReasons([A, none], ALL_LENS)), [], 'all patients: no population reason');
  assert.deepEqual(codes(cardReasons([A, none], { ...ALL_LENS, age: 'Age 65+' })), ['population_differs:P|p']);
  assert.deepEqual(codes(cardReasons([none, facts('Q|q', { lenses: { requested: 'none' } })], { ...ALL_LENS, age: 'Age 65+' })), [], 'every card lacks it');
});

test('row-level reasons, in the published order, each naming its cards', () => {
  assert.deepEqual(codes(rowReasons([A, B], [cell('strong'), cell('weak')], null, 2)), []);
  assert.deepEqual(codes(rowReasons([A, B], [cell('strong'), cell('strong')], 'none', 2)), ['no_mapping:A|f+B|f'], 'no mapping stands alone');
  assert.deepEqual(codes(rowReasons([A, B], [cell('strong'), cell('strong')], 'block', 2)), ['mapped_broader:A|f+B|f']);
  assert.deepEqual(codes(rowReasons([A, B], [cell('strong'), cell('strong')], 'parent', 1)), [], 'only conditions are mapped broader');
  assert.deepEqual(codes(rowReasons([A, B, C], [cell('no_data'), cell('out_of_scope'), cell('strong')], null, 2)), ['no_result:A|f', 'out_of_scope:B|f']);
  assert.deepEqual(codes(rowReasons([A, B], [cell('strong', { lens_fallback: true }), cell('strong')], null, 2)), ['lens_fallback:A|f']);
  assert.deepEqual(codes(rowReasons([A, B], [cell('strong', { lens_fallback: true }), cell('strong', { lens_fallback: true })], null, 2)), [], 'all fell back alike');
  const clinical = cell('strong', { design_group: 'clinical_study' });
  const tests = cell('moderate', { design_group: 'test_cases' });
  assert.deepEqual(codes(rowReasons([A, B, C], [clinical, tests, { ...tests }], null, 2)), ['design_differs:A|f']);
  assert.deepEqual(codes(rowReasons([A, B], [clinical, tests], null, 2)), ['design_differs:B|f'], 'a tie goes to the first card');
  assert.deepEqual(codes(rowReasons([A, B], [clinical, cell('strong')], null, 2)), [], 'a result without a group is not compared');
  assert.equal(referenceGroup(['x', 'y', 'y']), 'y');
});

test('the largest difference counts results only, rounded to 3 decimals', () => {
  assert.equal(perfSpread([cell('strong', { perf: 0.792 }), cell('weak', { perf: 0.666 })]), 0.126);
  assert.equal(perfSpread([cell('strong', { perf: 0.792 }), cell('out_of_scope', { perf: 0.1 })]), null);
  assert.equal(perfSpread([cell('strong', { perf: 0.5 }), cell('moderate', { perf: 0.7 }), cell('weak', { perf: 0.6 })]), 0.2);
});

function comparisonFiles() {
  const rows = {
    dataset_version: '25',
    context: 'Clinical',
    atlas: [{ concept_id: 'CH-05', code: '05', pt: 'Endocrine diseases', level: 0, parent_id: null, chapter_no: '05', mapping: null }],
    chapters: {
      'CH-05': {
        chapter_pt: 'Endocrine diseases',
        rows: [
          { concept_id: 'BLK-05-A', code: null, pt: 'Diabetes', level: 1, parent_id: 'CH-05', chapter_no: '05', mapping: null },
          { concept_id: '5A11', code: '5A11', pt: 'Type 2 diabetes mellitus', level: 2, parent_id: 'BLK-05-A', chapter_no: '05', mapping: null }
        ]
      }
    }
  };
  const column = (card, perfs) => ({
    dataset_version: '25',
    card,
    cells: { atlas: [encodeCell(cell('strong', { perf: perfs[0] }))], 'CH-05': [encodeCell(cell('moderate', { perf: perfs[1] })), encodeCell(cell(perfs[2] === null ? 'no_data' : 'weak', { perf: perfs[2] }))] }
  });
  const registry = { models: [{ model_version: 'A', use_cases: [{ use_case: 'f' }] }, { model_version: 'B', use_cases: [{ use_case: 'f' }] }] };
  return {
    rows,
    files: {
      'models.json': registry,
      'compare/rows.json': rows,
      'cards/A__f/all/compare.json': column(A, [0.8, 0.7, 0.6]),
      'cards/B__f/all/compare.json': column(B, [0.75, 0.72, null]),
      'cards/A__f/age-65plus/compare.json': column({ ...A, lenses: { requested: 'stored' } }, [0.8, 0.7, 0.6]),
      'cards/B__f/age-65plus/compare.json': column({ ...B, lenses: { requested: 'none' } }, [null, null, null])
    }
  };
}

test('the comparison is put together from each card’s recorded facts and cells, in request order', async () => {
  const { files } = comparisonFiles();
  const { adapter, requests } = fixture(files);
  const atlas = await adapter.getComparison({ cards: ['B|f', 'A|f'] });
  assert.deepEqual(atlas.cards.map((card) => card.card_id), ['B|f', 'A|f']);
  assert.deepEqual(atlas.filters, { context: 'Clinical', lens: ALL_LENS, scope: 'atlas', chapter_id: null, chapter_pt: null });
  assert.equal(atlas.rows.length, 1);
  assert.deepEqual(atlas.rows[0].cells.map((entry) => entry.perf), [0.75, 0.8]);
  assert.equal(atlas.rows[0].comparable, true);
  assert.equal(atlas.rows[0].perf_spread, 0.05);
  assert.equal('ontology' in atlas, false);
  assert.ok(requests.includes('static-data/compare/rows.json') && requests.includes('static-data/cards/B__f/all/compare.json'));

  const chapter = await adapter.getComparison({ cards: ['A|f', 'B|f'], scope: 'chapter', chapterId: 'CH-05' });
  assert.equal(chapter.filters.chapter_pt, 'Endocrine diseases');
  assert.deepEqual(chapter.rows.map((entry) => entry.concept_id), ['BLK-05-A', '5A11']);
  assert.deepEqual(codes(chapter.rows[1].reasons), ['no_result:B|f']);
  assert.equal(chapter.rows[1].comparable, false);
  assert.equal(chapter.rows[1].perf_spread, null);
  Object.keys(chapter.rows[1].cells[0]).forEach((field) => assert.ok(CELL_FIELDS.includes(field)));

  const group = await adapter.getComparison({ cards: ['A|f', 'B|f'], age: 'Age 65+' });
  assert.deepEqual(codes(group.card_reasons), ['population_differs:B|f']);
  assert.deepEqual(group.filters.lens, { ...ALL_LENS, age: 'Age 65+' });

  await assert.rejects(adapter.getComparison({ cards: ['A|f'] }), { code: 'invalid_cards' });
  await assert.rejects(adapter.getComparison({ cards: ['A|f', 'Z|f'] }), { code: 'unknown_model' });
  await assert.rejects(adapter.getComparison({ cards: ['A|f', 'B|nope'] }), { code: 'unknown_use_case' });
  await assert.rejects(adapter.getComparison({ cards: ['A|f', 'B|f'], scope: 'chapter' }), { code: 'missing_chapter_id' });
  await assert.rejects(adapter.getComparison({ cards: ['A|f', 'B|f'], scope: 'chapter', chapterId: 'CH-99' }), { code: 'unknown_concept' });
  await assert.rejects(adapter.getComparison({ cards: ['A|f', 'B|f'], age: 'Age 65+', sex: 'Sex Male' }), unavailable(STATIC_REASONS.combinedLens));
  await assert.rejects(adapter.getComparison({ cards: ['A|f', 'B|f'], ontology: 'mondo' }), unavailable(STATIC_REASONS.ontology));
  await assert.rejects(adapter.getComparison({ cards: ['A|f', 'B|f'], sex: 'Sex Female' }), unavailable(STATIC_REASONS.missing));
});

test('a cell round-trips through its recorded array, and another classification is named', () => {
  const original = cell('weak', { perf: 0.61, ci_low: 0.5, ci_high: 0.7, evidence_grade: 'D', validation_type: 'benchmark', design_group: 'test_cases', safety: 'caution' });
  assert.deepEqual(decodeCell(encodeCell(original)), original);
  const { rows } = comparisonFiles();
  const named = comparisonAnswer({
    rows: { ...rows, ontology: MONDO },
    cards: [
      { card: A, cells: { atlas: [encodeCell(cell('strong'))] } },
      { card: B, cells: { atlas: [encodeCell(cell('strong'))] } }
    ],
    scope: 'atlas',
    lens: {}
  });
  assert.deepEqual(named.ontology, MONDO);
  assert.equal(comparisonAnswer({ rows, cards: [], scope: 'chapter', chapterId: 'CH-99', lens: {} }), null);
});
