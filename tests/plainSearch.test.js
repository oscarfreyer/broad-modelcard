// Plain-language search (contract v1.14, CONTRACT.md §31):
// the static port of the interpreter (frontend/src/api/staticInterpret.js) and
// the synonym matches of the static search (frontend/src/api/staticSearch.js).
// The shared rule cases (backend/tests/fixtures/interpret_rule_cases.json) also
// run in backend/tests/test_interpret.py, so both answer alike; the quality set
// (backend/tests/fixtures/interpret_queries.json) runs here on the queries
// that need no synonym, over the seed's ICD-11 concepts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSearchIndex } from '../frontend/src/api/staticSearch.js';
import { interpretQuery, vocabularyOf } from '../frontend/src/api/staticInterpret.js';
import { parseStartupParams } from '../frontend/src/app/startupParams.js';
import {
  applyPlan,
  atlasHrefOfPlan,
  canCombine,
  cardOfChips,
  chipLabel,
  interpretationSummary,
  showsInterpretation
} from '../frontend/src/features/search/interpretation.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const RULES = readJson('../backend/tests/fixtures/interpret_rule_cases.json');
const QUALITY = readJson('../backend/tests/fixtures/interpret_queries.json');

function setup(concepts, synonyms, vocabulary) {
  const index = createSearchIndex(concepts, { synonyms });
  const byId = new Map(concepts.map((concept) => [concept.concept_id, concept]));
  return {
    index,
    vocabulary: vocabularyOf({ models: vocabulary.models, default_model_version: vocabulary.default_model_version }, vocabulary.axes),
    byId: (id) => byId.get(id) ?? null
  };
}

const ruleSetups = {
  true: setup(RULES.concepts, RULES.synonyms, RULES.vocabulary),
  false: setup(RULES.concepts, null, RULES.vocabulary)
};

for (const testCase of RULES.cases) {
  test(`shared rule case: ${testCase.name}`, () => {
    const { index, vocabulary, byId } = ruleSetups[testCase.synonyms ?? true];
    const answer = interpretQuery(testCase.query, vocabulary, index, byId);
    assert.deepEqual(answer.chips.map((chip) => [chip.kind, chip.value, chip.matched_text]), testCase.chips);
    assert.deepEqual(answer.unrecognized, testCase.unrecognized);
  });
}

test('condition chips carry the concept, how it was found, and a label without "- "', () => {
  const { index, vocabulary, byId } = ruleSetups.true;
  const [attack, melanoma] = interpretQuery('heart attack and 2C30', vocabulary, index, byId).chips;
  assert.equal(attack.value, 'BA41');
  assert.equal(attack.label, 'Acute myocardial infarction');
  assert.equal(attack.match, 'synonym');
  assert.equal(attack.matched_term, 'heart attack');
  assert.equal(attack.concept.concept_id, 'BA41');
  assert.equal(melanoma.label, 'Melanoma of skin');
  assert.equal(melanoma.match, 'code');
  assert.ok(!('matched_term' in melanoma));
});

test('without care settings on the Context axis, setting words give no chip', () => {
  const { index, byId } = ruleSetups.true;
  const vocabulary = vocabularyOf({ models: RULES.vocabulary.models }, { ...RULES.vocabulary.axes, context: ['Clinical'] });
  const answer = interpretQuery('asthma in the ICU', vocabulary, index, byId);
  assert.deepEqual(answer.chips.map((chip) => chip.kind), ['condition']);
  assert.deepEqual(answer.unrecognized, ['ICU']);
});

test('the static search lists synonym matches after every other match, as the API does', () => {
  const { index } = ruleSetups.true;
  const answer = index.search('heart');
  const synonymAt = answer.results.findIndex((result) => result.match === 'synonym');
  assert.ok(synonymAt > 0);
  assert.ok(answer.results.slice(synonymAt).every((result) => result.match === 'synonym'));
  assert.deepEqual(
    answer.results.slice(synonymAt).map((result) => [result.concept_id, result.matched_term]),
    [['BA41.Z', 'heart attack']]
  );
  assert.equal(answer.total, answer.results.length);
  // Without synonyms the answer is the v1.13 search: no synonym fields at all.
  assert.ok(ruleSetups.false.index.search('heart').results.every((result) => !('match' in result)));
  assert.equal(ruleSetups.false.index.search('heart attack').total, 0);
});

test('the quality set: the port reads the queries that need no synonym exactly as expected', () => {
  const concepts = readJson('../backend/seed/atlas-base.json').concepts;
  const { index, vocabulary, byId } = setup(concepts, null, QUALITY.vocabulary);
  const cases = QUALITY.queries.filter((entry) => !entry.synonyms);
  assert.equal(cases.length, 18);
  const wrong = cases.filter((entry) => {
    const answer = interpretQuery(entry.query, vocabulary, index, byId);
    return JSON.stringify([answer.chips.map((chip) => [chip.kind, chip.value]), answer.unrecognized]) !== JSON.stringify([entry.chips, entry.unrecognized]);
  });
  assert.deepEqual(wrong.map((entry) => entry.query), []);
});

// ------------------------------------------------------------ the row and Apply

const ENTRIES = [
  { model_version: 'Alpha-2.0', display_name: 'Alpha 2.0', use_cases: [{ use_case: 'Clinician Facing CDSS', has_multimorbidity: true }, { use_case: 'Discharge letter generation' }] },
  { model_version: 'Beta-1', display_name: 'Beta 1', use_cases: [{ use_case: 'Emergency department triage' }] }
];
const chip = (kind, value, extra = {}) => ({ kind, value, label: value, matched_text: value, ...extra });
const CONDITION = (id, level = 2) => chip('condition', id, { concept: { concept_id: id, level, chapter_id: 'CH-11', metric_anchor_id: id } });

test('the row shows for three or more words, or for any chip other than a condition', () => {
  assert.equal(showsInterpretation('heart failure', [CONDITION('BD10')]), false);
  assert.equal(showsInterpretation('heart failure women', [CONDITION('BD10')]), true);
  assert.equal(showsInterpretation('icu', [chip('setting', 'Intensive care')]), true);
  assert.equal(showsInterpretation('a b c', []), false);
});

test('chips read in the UI words', () => {
  assert.equal(chipLabel(chip('system', 'Alpha-2.0'), ENTRIES), 'Alpha 2.0');
  assert.equal(chipLabel(chip('function', 'Clinician Facing CDSS')), 'Clinician-Facing CDSS');
  assert.equal(chipLabel(chip('sex', 'Sex Female')), 'Women');
  assert.equal(chipLabel(chip('age', 'Age 65+')), 'Age 65+');
  assert.equal(chipLabel(chip('age', 'Age 0-17')), 'Age 0–17');
  assert.equal(chipLabel(chip('ethnicity', 'Ethnicity Asian')), 'Asian');
  assert.equal(interpretationSummary([chip('sex', 'Sex Male'), chip('setting', 'Primary care')]), 'Read as: Men, Primary care');
});

test('the card of the chips: a system keeps the function on screen when it has it; a function keeps the system', () => {
  const current = { model: 'Alpha-2.0', useCase: 'Discharge letter generation' };
  assert.deepEqual(cardOfChips([chip('system', 'Alpha-2.0')], ENTRIES, current), current);
  assert.deepEqual(cardOfChips([chip('system', 'Beta-1')], ENTRIES, current), { model: 'Beta-1', useCase: 'Emergency department triage' });
  assert.deepEqual(cardOfChips([chip('function', 'Clinician Facing CDSS')], ENTRIES, current), { model: 'Alpha-2.0', useCase: 'Clinician Facing CDSS' });
  assert.deepEqual(cardOfChips([chip('function', 'Emergency department triage')], ENTRIES, current), { model: 'Beta-1', useCase: 'Emergency department triage' });
  assert.equal(cardOfChips([CONDITION('BD10')], ENTRIES, current), null);
  assert.equal(cardOfChips([chip('system', 'Gone-9')], ENTRIES, current), null);
});

test('Apply sets the whole lens from the chips, the setting, and the conditions', () => {
  const plan = applyPlan([chip('sex', 'Sex Female'), chip('setting', 'Emergency department'), CONDITION('BD10'), CONDITION('5A11')], ENTRIES, null);
  assert.deepEqual(plan.lens, { age: 'All ages', sex: 'Sex Female', ethnicity: 'All ethnicities' });
  assert.equal(plan.setting, 'Emergency department');
  assert.equal(plan.card, null);
  assert.deepEqual(plan.conditions.map((concept) => concept.concept_id), ['BD10', '5A11']);
  assert.equal(applyPlan([], ENTRIES, null).setting, null);
  // A combination needs a card with stored combinations and conditions only.
  assert.equal(canCombine(plan, ENTRIES, { model: 'Alpha-2.0', useCase: 'Clinician Facing CDSS' }), true);
  assert.equal(canCombine(plan, ENTRIES, { model: 'Beta-1', useCase: 'Emergency department triage' }), false);
  assert.equal(canCombine({ ...plan, conditions: [plan.conditions[0], { concept_id: 'BLK-1', level: 1 }] }, ENTRIES, { model: 'Alpha-2.0', useCase: 'Clinician Facing CDSS' }), false);
});

test('the catalogue opens the atlas with the chips in its URL', () => {
  const plan = applyPlan([chip('system', 'Beta-1'), chip('age', 'Age 65+'), chip('setting', 'Intensive care'), CONDITION('BD10')], ENTRIES, null);
  const href = atlasHrefOfPlan(plan);
  assert.ok(href.startsWith('./atlas.html?'));
  const params = parseStartupParams(href.slice(href.indexOf('?')));
  assert.equal(params.model, 'Beta-1');
  assert.equal(params.useCase, 'Emergency department triage');
  assert.equal(params.lens.age, 'Age 65+');
  assert.equal(params.lens.sex, null);
  assert.equal(params.setting, 'Intensive care');
  assert.equal(params.conceptId, 'BD10');
  // A condition opens in its chapter, so a subcategory the overview lacks is found too.
  assert.equal(params.chapterId, 'CH-11');
  assert.match(href, /setting=intensive_care/);
  const combined = parseStartupParams(atlasHrefOfPlan(applyPlan([CONDITION('BD10'), CONDITION('5A11')], ENTRIES, null), { combine: true }).split('?')[1]);
  assert.equal(combined.mode, 'multimorbidity');
  assert.deepEqual(combined.selectedIds, ['BD10', '5A11']);
});

test('a combination holds each condition once: subcategories join as their condition', () => {
  const sub = (id, anchor) => chip('condition', id, { concept: { concept_id: id, level: 2, chapter_id: 'CH-01', metric_anchor_id: anchor } });
  const current = { model: 'Alpha-2.0', useCase: 'Clinician Facing CDSS' };
  const same = applyPlan([sub('1A03.0', '1A03'), sub('1A03.1', '1A03')], ENTRIES, null);
  assert.equal(canCombine(same, ENTRIES, current), false);
  const mixed = applyPlan([sub('1A03.0', '1A03'), sub('1A03.1', '1A03'), CONDITION('BD10')], ENTRIES, null);
  assert.equal(canCombine(mixed, ENTRIES, current), true);
  const params = parseStartupParams(atlasHrefOfPlan(mixed, { combine: true }).split('?')[1]);
  assert.deepEqual(params.selectedIds, ['1A03', 'BD10']);
});
