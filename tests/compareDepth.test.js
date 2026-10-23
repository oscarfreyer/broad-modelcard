// Comparison depth (contract v1.14, CONTRACT.md §25; release 0.5 phase Q4):
// the static port's new reasons on the cases the backend's rule is tested
// with (backend/tests/fixtures/comparison_rule_cases.json), the cells' optional
// fields, and the compare page's words for the new reasons and card facts.
// All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ComparisonFlag from '../frontend/src/features/compare/ComparisonFlag.js';
import {
  REASON_RULES,
  conductorWords,
  inSentence,
  localWords,
  narrowCardWords,
  reasonText,
  rowSettings,
  statedMeasures
} from '../frontend/src/features/compare/compareCopy.js';
import { CELL_FIELDS, cardReasons, decodeCell, encodeCell, rowReasons } from '../frontend/src/api/staticComparison.js';
import { ALL_LENS } from '../frontend/src/app/startupParams.js';

const CASES = JSON.parse(readFileSync(new URL('../backend/tests/fixtures/comparison_rule_cases.json', import.meta.url), 'utf8'));
const LENSES = { all: ALL_LENS, age: { ...ALL_LENS, age: 'Age 65+' } };

const facts = (card) => ({
  card_id: card.card_id,
  function_category: card.function_category,
  ...(card.performance_measure ? { performance_measure: card.performance_measure } : {}),
  lenses: { requested: card.lens_state ?? 'stored' }
});

const cell = (given) => {
  const result = ['strong', 'moderate', 'weak'].includes(given.status);
  return { perf: result ? 0.8 : null, design_group: result ? 'test_cases' : null, lens_fallback: false, ...given };
};

for (const testCase of CASES.card_reasons) {
  test(`static port, card reasons: ${testCase.name}`, () => {
    assert.deepEqual(cardReasons(testCase.cards.map(facts), LENSES[testCase.lens]), testCase.expected);
  });
}

for (const testCase of CASES.row_reasons) {
  test(`static port, row reasons: ${testCase.name}`, () => {
    const cards = ['A', 'B', 'C', 'D'].slice(0, testCase.cells.length).map((letter) => ({ card_id: `${letter}|f` }));
    assert.deepEqual(rowReasons(cards, testCase.cells.map(cell), null, 2), testCase.expected);
  });
}

test('recorded cells keep the v1.14 fields only where the API sends them', () => {
  assert.deepEqual(CELL_FIELDS.slice(-2), ['layer', 'setting_category']);
  const plain = { status: 'strong', performance_status: 'strong', evidence_status: 'moderate', perf: 0.8, ci_low: 0.7, ci_high: 0.9, evidence_grade: 'B', validation_type: 'benchmark', study_design: null, design_group: 'test_cases', lens_fallback: false, safety: null };
  // JSON turns the absent fields into null; decoding leaves them out again, as the API does.
  const recorded = JSON.parse(JSON.stringify(encodeCell(plain)));
  assert.deepEqual(decodeCell(recorded), plain);
  assert.equal('layer' in decodeCell(recorded), false);
  const local = { ...plain, layer: 'local', setting_category: 'intensive_care' };
  assert.deepEqual(decodeCell(JSON.parse(JSON.stringify(encodeCell(local)))), local);
  // Fields that are null in the API (study_design) stay null.
  assert.equal(decodeCell(recorded).study_design, null);
});


// ------------------------------------------------------------ the page's words

const NAMES = new Map([
  ['V20|t', 'Vantrel Triage 2.0'],
  ['V21|t', 'Vantrel Triage 2.1'],
  ['S|c', 'SynGPT-2.0']
]);

test('measure reasons name the measures (v1.14, §25)', () => {
  const cards = [
    { card_id: 'S|c', performance_measure: 'Top-3 diagnostic accuracy' },
    { card_id: 'V21|t', performance_measure: 'Sensitivity' },
    { card_id: 'V20|t', performance_measure: '  top-3 DIAGNOSTIC   accuracy' }
  ];
  assert.deepEqual(statedMeasures(cards), ['top-3 diagnostic accuracy', 'sensitivity']);
  assert.equal(reasonText({ code: 'measure_differs', cards: ['V21|t'] }, NAMES, 3, { cards }), 'measures differ: top-3 diagnostic accuracy vs sensitivity');
  // Without the facts the words still read (the R4 test renders every code without them).
  assert.equal(reasonText({ code: 'measure_differs', cards: ['V21|t'] }, NAMES, 3), 'different measure: Vantrel Triage 2.1 measures something else');
  assert.equal(reasonText({ code: 'measure_unknown', cards: ['V20|t'] }, NAMES, 3), 'measure unknown: Vantrel Triage 2.0 states no performance measure');
  assert.equal(inSentence('AUROC for sepsis'), 'AUROC for sepsis');
});

test('setting reasons name the settings of the row (v1.14, §25)', () => {
  const row = {
    cells: [
      { status: 'strong', setting_category: 'emergency_department' },
      { status: 'weak', setting_category: 'inpatient_ward' },
      { status: 'strong', setting_category: 'mixed' },
      { status: 'out_of_scope', setting_category: 'primary_care' }
    ]
  };
  assert.deepEqual(rowSettings(row), ['emergency department', 'inpatient ward']);
  assert.equal(reasonText({ code: 'setting_differs', cards: ['V21|t'] }, NAMES, 4, { row }), 'settings differ: emergency department vs inpatient ward');
  assert.equal(reasonText({ code: 'setting_differs', cards: ['V21|t'] }, NAMES, 4), 'different care setting: Vantrel Triage 2.1');
  const html = renderToStaticMarkup(
    h(ComparisonFlag, { row: { ...row, reasons: [{ code: 'setting_differs', cards: ['V21|t'] }] }, cardReasons: [], names: NAMES, cardCount: 4 })
  );
  assert.match(html, /settings differ: emergency department vs inpatient ward/);
});

test('the new card facts in words: conductors, narrow model card, local results', () => {
  assert.equal(conductorWords({ developer: 1, independent: 2, hospital: 1 }), '2 independent, 1 by a hospital, 1 by the developer');
  assert.equal(conductorWords({ developer: 0, independent: 0, hospital: 0 }), null);
  assert.equal(conductorWords(undefined), null);
  assert.equal(narrowCardWords({ present: true, submitted_at: '2026-10-20T09:00:00Z' }), 'Provided, 2026-10-20');
  assert.equal(narrowCardWords({ present: false, submitted_at: null }), 'None');
  assert.equal(localWords({ layer: 'local' }), 'Local');
  assert.equal(localWords({ layer: 'includes_local' }), 'Includes local');
  assert.equal(localWords({ layer: 'public' }), null);
  assert.equal(localWords({}), null);
  // Every new rule has its plain explanation, and none ranks the cards.
  for (const code of ['measure_differs', 'measure_unknown', 'setting_differs']) {
    assert.ok(REASON_RULES[code] && !/better|worse|winner|best/i.test(REASON_RULES[code]), code);
  }
});
