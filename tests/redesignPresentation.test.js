// Presentation logic of the redesigned atlas (Track B4): the status
// vocabulary and its visual forms, range-chart scaling, Summary highlights,
// ring keyboard movement, Esc, list sorting, and the card copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapRangeValues, rangeModel, rangePosition, rangeZones, DEFAULT_STATUS_BANDS } from '../frontend/src/design/rangeScale.js';
import { DISPLAY, absenceCore, coreRadius, countStatuses, subchapterCore, displayFor, gradeFor, keysForView, mapRowStatus, metricRowStatus } from '../frontend/src/design/status.js';
import { coreNoDataText, coreText } from '../frontend/src/features/atlas/coreText.js';
import { buildRingIndex, nextRingTile } from '../frontend/src/features/atlas/ringKeyboard.js';
import { SYNTHETIC_NOTE, aboutResult, emptyRollupSentence } from '../frontend/src/features/details/copy/aboutResult.js';
import { presentedSafeguards, presentedWarnings } from '../frontend/src/features/details/copy/emptyRollup.js';
import { buildConceptCardFile } from '../frontend/src/features/details/conceptCardExport.js';
import { metricSections } from '../frontend/src/features/details/metricSections.js';
import { conceptName, displayTerm } from '../frontend/src/shared/conceptName.js';
import { prevalenceTierLabel, prevalenceTierWeight } from '../frontend/src/shared/prevalenceTiers.js';
import { escapeAction, initialNavigationState, navigationReducer, UI_MODES } from '../frontend/src/features/navigation/navigationReducer.js';
import { defaultMinGroupSize, deriveHighlights, groupStatusCounts } from '../frontend/src/features/summary/summaryHighlights.js';

const mapRow = (overrides = {}) => ({
  concept_id: 'X',
  overall_status: 'strong',
  overall_grade: 'B',
  overall_score: 0.81,
  performance_status: 'moderate',
  performance_grade: 'C',
  perf: 0.74,
  evidence_status: 'not_validated',
  evidence_grade: null,
  intended_use_level: 'partially_in_scope',
  ...overrides
});

test('status → visual form: three fills for performance, a shape for each kind of absence', () => {
  assert.deepEqual(
    ['strong', 'moderate', 'weak', 'out_of_scope', 'no_data', 'no_combination', 'loading'].map((key) => DISPLAY[key].form),
    ['fill', 'fill', 'fill', 'barred', 'outline', 'dot', 'pale']
  );
  const forms = new Set(['out_of_scope', 'no_data', 'no_combination', 'loading'].map((key) => DISPLAY[key].form));
  assert.equal(forms.size, 4, 'each absence has its own shape');
  assert.equal(displayFor('nonsense'), DISPLAY.no_data);
  // D5: Not validated is not a state; a served `not_validated` reads No data.
  assert.equal(DISPLAY.not_validated, undefined);
  assert.equal(displayFor('not_validated'), DISPLAY.no_data);
  assert.deepEqual(keysForView('overall'), ['strong', 'moderate', 'weak', 'out_of_scope', 'no_data']);
  assert.deepEqual(keysForView('overall', { hasIntendedUse: false }), ['strong', 'moderate', 'weak', 'no_data']);
  assert.deepEqual(keysForView('performance'), ['strong', 'moderate', 'weak', 'no_data']);
  assert.deepEqual(keysForView('evidence'), ['strong', 'moderate', 'weak', 'no_data']);
  assert.deepEqual(keysForView('intended_use'), ['in_scope', 'partially_in_scope', 'out_of_scope', 'no_data']);
});

test('map rows resolve to display keys per view, with contract fallbacks', () => {
  const row = mapRow();
  assert.equal(mapRowStatus(row, 'overall'), 'strong');
  assert.equal(mapRowStatus(row, 'performance'), 'moderate');
  assert.equal(mapRowStatus(row, 'evidence'), 'no_data');
  assert.equal(mapRowStatus(row, 'intended_use'), 'partially_in_scope');
  assert.equal(mapRowStatus(null, 'overall'), 'no_data');
  // One rule for "no row": No data on every view, including Intended use.
  assert.equal(mapRowStatus(null, 'intended_use'), 'no_data');
  assert.equal(metricRowStatus({ status: { overall: 'weak' }, intended_use_level: 'in_scope' }, 'overall'), 'weak');
  assert.equal(metricRowStatus({ status: {}, intended_use_level: 'in_scope' }, 'intended_use'), 'in_scope');
  assert.equal(gradeFor(row, 'overall'), 'B');
  assert.equal(gradeFor({ overall: { grade: 'A' } }, 'overall'), 'A');
  assert.equal(gradeFor(row, 'intended_use'), null);
});

test('status counts follow the view vocabulary', () => {
  const rows = [mapRow(), mapRow({ overall_status: 'weak' }), null];
  assert.deepEqual(countStatuses(rows, 'overall'), { strong: 1, moderate: 0, weak: 1, out_of_scope: 0, no_data: 1 });
  assert.deepEqual(countStatuses(rows, 'evidence'), { strong: 0, moderate: 0, weak: 0, no_data: 3 });
  assert.deepEqual(countStatuses(rows, 'intended_use'), { in_scope: 0, partially_in_scope: 2, out_of_scope: 0, no_data: 1 });
});

test('range charts scale values onto a fixed domain and clamp at the edges', () => {
  const middle = rangePosition(0.7, [0.4, 1]);
  assert.ok(Math.abs(middle.pct - 50) < 1e-9 && middle.clamped === null);
  assert.deepEqual(rangePosition(0.2, [0.4, 1]), { pct: 0, clamped: 'low' });
  assert.deepEqual(rangePosition(1.2, [0.4, 1]), { pct: 100, clamped: 'high' });
  assert.equal(rangePosition(null, [0.4, 1]), null);

  const zones = rangeZones(DEFAULT_STATUS_BANDS.performance, [0.4, 1]);
  assert.deepEqual(zones.map((zone) => zone.status), ['weak', 'moderate', 'strong']);
  assert.ok(Math.abs(zones[0].endPct - 50) < 1e-9 && Math.abs(zones[1].endPct - 66.6667) < 1e-3 && zones[2].endPct === 100);

  const model = rangeModel({ view: 'performance', value: 0.84, ciLow: 0.79, ciHigh: 0.88, status: 'strong' });
  assert.equal(model.zones.find((zone) => zone.isActive).status, 'strong');
  assert.ok(model.ci.startPct < model.value.pct && model.value.pct < model.ci.endPct);
  assert.deepEqual(model.ticks.map((tick) => tick.label), ['0.70', '0.80']);

  // The contract status decides the zone, even at a rounding edge.
  assert.equal(rangeModel({ view: 'overall', value: 0.7599, status: 'strong' }).zones.find((zone) => zone.isActive).status, 'strong');
  // Without a value (evidence without a signal) the status zone is highlighted and no dot is drawn.
  const evidence = rangeModel({ view: 'evidence', value: null, status: 'moderate' });
  assert.equal(evidence.value, null);
  assert.equal(evidence.zones.find((zone) => zone.isActive).status, 'moderate');
  assert.throws(() => rangeModel({ view: 'intended_use', value: 1 }));
});

test('map rows give the CI whisker on the performance view only (MetricMap v1.1 columns, by name)', () => {
  const row = mapRow({ ci_low: 0.7, ci_high: 0.79 });
  assert.deepEqual(mapRangeValues(row, 'performance'), { value: 0.74, ciLow: 0.7, ciHigh: 0.79 });
  assert.deepEqual(mapRangeValues(row, 'overall'), { value: 0.81, ciLow: null, ciHigh: null });
  assert.deepEqual(mapRangeValues(row, 'evidence'), { value: null, ciLow: null, ciHigh: null });
  assert.deepEqual(mapRangeValues(mapRow({ ci_low: null, ci_high: 0.8 }), 'performance'), { value: 0.74, ciLow: null, ciHigh: null });
  assert.deepEqual(mapRangeValues(null, 'performance'), { value: null, ciLow: null, ciHigh: null });

  const chart = rangeModel({ view: 'performance', ...mapRangeValues(row, 'performance'), status: 'moderate' });
  assert.ok(chart.ci && chart.ci.startPct < chart.value.pct && chart.value.pct < chart.ci.endPct);
});

test('summary highlights name the overview, extreme areas, and where absence concentrates', () => {
  const groups = [
    { id: 'CH-A', label: 'Alpha', total: 20, counts: { strong: 18, weak: 2 } },
    { id: 'CH-B', label: 'Beta', total: 10, counts: { strong: 2, weak: 6, no_data: 2 } },
    { id: 'CH-C', label: 'Gamma', total: 3, counts: { weak: 3 } },
    { id: 'CH-D', label: 'Delta', total: 7, counts: { no_data: 5, out_of_scope: 2 } }
  ];
  const counts = { strong: 20, moderate: 0, weak: 11, out_of_scope: 2, no_data: 7 };
  const highlights = deriveHighlights({ viewId: 'overall', total: 40, counts, groups, minGroupSize: 5 });
  assert.deepEqual(highlights.map((item) => item.id), [
    'overview', 'weakest', 'strongest', 'concentration-out_of_scope', 'concentration-no_data'
  ]);
  assert.equal(highlights[0].title, 'Strong for 50% of conditions');
  // Gamma has 100% weak but only 3 conditions, below the comparison size.
  assert.equal(highlights[1].targetId, 'CH-B');
  assert.equal(highlights[1].text, '60% of 10 weak.');
  assert.equal(highlights[2].targetId, 'CH-A');
  assert.equal(highlights[4].title, 'No data for 7 conditions');
  assert.equal(highlights[4].text, 'Mostly in Delta (5) and Beta (2).');
  assert.equal(highlights[3].text, 'All in Delta.');

  // "Most" only when the named groups hold more than half (S8 critique: 164 of 722 read "Most").
  const spread = deriveHighlights({
    viewId: 'overall',
    total: 100,
    counts: { strong: 50, moderate: 20, weak: 10, out_of_scope: 0, no_data: 20 },
    groups: [
      { id: 'CH-1', label: 'One', total: 30, counts: { strong: 26, no_data: 4 } },
      { id: 'CH-2', label: 'Two', total: 25, counts: { strong: 20, no_data: 4 } },
      { id: 'CH-3', label: 'Three', total: 15, counts: { moderate: 11, no_data: 4 } },
      { id: 'CH-4', label: 'Four', total: 15, counts: { moderate: 9, weak: 2, no_data: 4 } },
      { id: 'CH-5', label: 'Five', total: 15, counts: { strong: 4, weak: 8, no_data: 3 } }
    ]
  });
  const spreadText = spread.find((item) => item.id === 'concentration-no_data').text;
  assert.equal(spreadText, 'Spread over 5 chapters; largest: Four (4), One (4).');
  assert.doesNotMatch(spreadText, /Most/);

  const scope = deriveHighlights({
    viewId: 'intended_use',
    total: 10,
    counts: { in_scope: 6, partially_in_scope: 1, out_of_scope: 3, no_data: 0 },
    groups: [{ id: 'CH-D', label: 'Delta', total: 4, counts: { out_of_scope: 3 } }]
  });
  assert.equal(scope[0].title, 'In scope for 60% of conditions');
  assert.equal(scope[1].targetId, 'CH-D');
  assert.equal(deriveHighlights({ viewId: 'overall', total: 0, counts: {} })[0].id, 'empty');
});

test('group counts come from map rows by group', () => {
  const concepts = [
    { concept_id: 'a', parent_id: 'B1' },
    { concept_id: 'b', parent_id: 'B1' },
    { concept_id: 'c', parent_id: 'B2' }
  ];
  const rows = new Map([['a', mapRow()], ['b', mapRow({ overall_status: 'weak' })]]);
  const groups = groupStatusCounts(concepts, rows, 'overall', (concept) => concept.parent_id, { B1: 'Block one' });
  assert.deepEqual(groups, [
    { id: 'B1', label: 'Block one', total: 2, counts: { strong: 1, weak: 1 } },
    { id: 'B2', label: 'B2', total: 1, counts: { no_data: 1 } }
  ]);
});

test('arrow keys move around the ring and outward or inward', () => {
  const polar = (id, angle, radius) => ({ id, concept_id: id, x: 500 + Math.sin(angle) * radius, y: 500 - Math.cos(angle) * radius });
  const tiles = [
    polar('top-inner', 0.05, 200),
    polar('top-outer', 0.06, 300),
    polar('right', Math.PI / 2, 200),
    polar('bottom', Math.PI, 250),
    polar('left', (3 * Math.PI) / 2, 200),
    { id: 'empty', isEmpty: true, x: 0, y: 0 }
  ];
  const index = buildRingIndex(tiles);
  assert.deepEqual(index.entries.map((entry) => entry.id), ['top-inner', 'top-outer', 'right', 'bottom', 'left']);
  assert.equal(nextRingTile(index, null, 'ArrowRight'), 'top-inner');
  assert.equal(nextRingTile(index, 'top-outer', 'ArrowRight'), 'right');
  assert.equal(nextRingTile(index, 'top-inner', 'ArrowLeft'), 'left', 'wraps counter-clockwise');
  assert.equal(nextRingTile(index, 'top-inner', 'ArrowUp'), 'top-outer');
  assert.equal(nextRingTile(index, 'top-outer', 'ArrowDown'), 'top-inner');
  assert.equal(nextRingTile(index, 'top-outer', 'ArrowUp'), 'top-outer', 'stays at the edge');
  assert.equal(nextRingTile(index, 'right', 'End'), 'left');
  assert.equal(nextRingTile(index, 'right', 'Home'), 'top-inner');
  assert.equal(nextRingTile(index, 'right', 'Enter'), null);
});

test('Esc closes the card first, then steps back', () => {
  const inChapter = navigationReducer(initialNavigationState, { type: 'openChapter', chapterId: 'CH-01' });
  assert.equal(inChapter.level, 1);
  assert.equal(inChapter.selectedConceptId, null);
  assert.equal(escapeAction(inChapter).type, 'back');
  const selected = navigationReducer(inChapter, { type: 'selectConcept', conceptId: 'BL-1' });
  assert.equal(selected.selectedConceptId, 'BL-1');
  assert.equal(escapeAction(selected).type, 'clearSelection');
  assert.equal(escapeAction(initialNavigationState), null);
  const combination = { ...initialNavigationState, uiMode: UI_MODES.multimorbidity, multimorbidityIds: ['A'] };
  assert.equal(escapeAction(combination).type, 'back');
  assert.equal(escapeAction({ ...combination, multimorbidityIds: [] }), null);
});

test('"About this result" explains provenance in plain or expert words and always ends synthetic', () => {
  const rollup = { provenance: { source: 'rollup', rollup: { child_count: 1, aggregation: 'p20' }, lens_fallback: true }, ci_low: 0.7, ci_high: 0.8 };
  const plain = aboutResult({ concept: { pt: 'Block', level: 1 }, row: rollup, depth: 'plain' });
  assert.equal(plain[0], 'Summary of 1 condition, cautious: 80% score at least this well.');
  assert.match(plain[1], /population/);
  assert.equal(plain.at(-1), SYNTHETIC_NOTE);
  const expert = aboutResult({ concept: { pt: 'Block', level: 1 }, row: rollup, depth: 'expert' });
  assert.match(expert[0], /p20/);
  assert.ok(expert.some((sentence) => sentence.startsWith('Confidence interval 0.700–0.800')));
  assert.match(aboutResult({ concept: { pt: 'X' }, row: null, depth: 'plain' })[0], /No result for X/);
  assert.match(aboutResult({ concept: { pt: 'X.1' }, row: { provenance: { source: 'anchor', anchor_concept_id: 'X' } }, depth: 'expert' })[0], /anchor X;/);
});

test('metric sections give a figure, a chart, and a meaning per view', () => {
  const row = {
    perf: 0.842, ci_low: 0.79, ci_high: 0.88, performance_grade: 'B',
    evidence_grade: 'C', evidence_signal: null, validation_type: 'benchmark', n_studies: 3, peer_reviewed_studies: 2, n_samples: 1200, n_sites: 1,
    intended_use_level: 'in_scope', intended_use_coverage: 1,
    overall: { tier: 'graded', score: 0.77, grade: 'B' },
    status: { overall: 'strong', performance: 'strong', evidence: 'moderate' }
  };
  const [overall, performance, evidence, scope] = metricSections(row, { depth: 'plain' });
  assert.deepEqual(overall.figure, { value: '0.77', unit: 'of 1.00' }, 'one unit pattern for the 0–1 values (audit A27)');
  assert.equal(overall.grade, null, 'no letters at plain depth');
  assert.deepEqual(performance.figure, { value: '0.84', unit: 'of 1.00' });
  assert.ok(performance.chart.ci);
  assert.deepEqual(evidence.figure, { word: 'Moderate' });
  assert.equal(evidence.facts.length, 4);
  assert.deepEqual(scope.figure, { value: '100%', unit: 'coverage' });
  assert.deepEqual(scope.chart, { kind: 'scope', level: 'in_scope' });
  const expert = metricSections(row, { depth: 'expert' });
  assert.deepEqual(expert.map((section) => section.grade), ['B', 'B', 'C', null]);
  assert.equal(expert[1].figure.value, '0.842');
  assert.equal(expert[1].meaning, 'Performance 0.842, confidence interval 0.790–0.880.', 'no raw "perf" at expert depth');
  // The value stays in view; what it is made of is the section's help.
  assert.equal(expert[0].meaning, 'Score 0.770.');
  assert.equal(expert[0].help, 'Combines performance grade, performance, evidence grade, and intended-use fit.');
  assert.equal(overall.meaning, null);
  assert.equal(overall.help, 'Performance, evidence, and intended-use fit, combined.');
  const weights = { performance_grade: 0.35, perf: 0.2, evidence_grade: 0.3, intended_use: 0.15 };
  assert.equal(
    metricSections(row, { depth: 'expert', overallScoreWeights: weights })[0].help,
    'Weights: performance grade 35%, performance 20%, evidence grade 30%, intended-use fit 15%.'
  );
  const ungraded = metricSections({ ...row, overall: { tier: 'out_of_scope', score: null, grade: null }, status: { overall: 'out_of_scope' } }, {});
  assert.deepEqual(ungraded[0].figure, { word: 'No score' });
  assert.match(ungraded[0].meaning, /not meant/);
});

test('rarity words and bubble weights come from the API tier, never from the score', () => {
  assert.equal(prevalenceTierLabel({ prevalence_tier: 'very_common', prevalence_score: 0.7 }), 'Very common');
  assert.equal(prevalenceTierWeight({ prevalence_tier: 'very_common' }), 5);
  // The score is not bucketed: a tier wins over any score, and no tier means no label and the smallest weight.
  assert.equal(prevalenceTierWeight({ prevalence_tier: 'rare', prevalence_score: 0.7 }), 2);
  assert.equal(prevalenceTierLabel({ prevalence_tier: null, prevalence_score: 0.7 }), null);
  assert.equal(prevalenceTierWeight({ prevalence_score: 0.7 }), 1);
  assert.equal(prevalenceTierWeight(null), 1);
});

test('display names drop the chapter number and the hyphen bullet, nothing else', () => {
  assert.equal(conceptName({ level: 0, pt: '02 Neoplasms' }), 'Neoplasms');
  assert.equal(conceptName({ level: 2, pt: '- Obesity' }), 'Obesity');
  assert.equal(conceptName({ level: 2, pt: '21-hydroxylase deficiency' }), '21-hydroxylase deficiency');
  assert.equal(conceptName({ level: 1, pt: 'Endocrine diseases' }), 'Endocrine diseases');
  assert.equal(displayTerm('– Hypoglycaemia'), 'Hypoglycaemia');
  assert.equal(conceptName(null), '');
});

test('a subchapter core is the share of its conditions without a result, in the commonest absence', () => {
  const rows = [mapRow(), mapRow({ overall_status: 'out_of_scope' }), mapRow({ overall_status: 'out_of_scope' }), null];
  assert.deepEqual(absenceCore(rows, 'overall'), { share: 0.75, status: 'out_of_scope', count: 3, total: 4 });
  // Incidents are not results: an open incident over a result does not count as missing (D10).
  assert.equal(absenceCore([mapRow({ safety: 'serious' })], 'overall'), null);
  assert.equal(absenceCore([mapRow(), mapRow()], 'overall'), null);
  assert.deepEqual(absenceCore([mapRow({ intended_use_level: 'out_of_scope' }), mapRow()], 'intended_use'), { share: 0.5, status: 'out_of_scope', count: 1, total: 2 });
  assert.equal(absenceCore([], 'overall'), null);
});

test('a subchapter centre is its weak share on the graded views, its scope gap on Intended use, and none on Safety', () => {
  const weak = { overall_status: 'weak', performance_status: 'weak', evidence_status: 'weak' };
  const rows = [mapRow(), mapRow(weak), mapRow({ ...weak, safety: 'serious' }), null];
  // Overview counts the results underneath incidents; No data is counted for the hover card.
  assert.deepEqual(subchapterCore(rows, 'overall'), { share: 0.5, status: 'weak', count: 2, total: 4, noData: 1 });
  assert.deepEqual(subchapterCore(rows, 'performance'), { share: 0.5, status: 'weak', count: 2, total: 4, noData: 1 });
  assert.equal(subchapterCore([mapRow(), null], 'evidence'), null, 'no weak condition, no centre');
  assert.deepEqual(subchapterCore([mapRow({ intended_use_level: 'out_of_scope' }), mapRow()], 'intended_use'), absenceCore([mapRow({ intended_use_level: 'out_of_scope' }), mapRow()], 'intended_use'));
  assert.equal(subchapterCore(rows, 'safety'), null);
  // Drawn only where it reads: no centre on a bubble under 5 px; at least 2 px, at most 72% of the bubble.
  assert.equal(coreRadius(6, 0.5, 0.8), null);
  assert.equal(coreRadius(10, 0.01, 0.5), 4);
  assert.ok(Math.abs(coreRadius(10, 1, 1) - 7.2) < 1e-9);
  assert.ok(Math.abs(coreRadius(10, 0.25, 1) - 5) < 1e-9);
  assert.equal(coreRadius(10, 0.25, null), null);
  assert.equal(coreText({ share: 0.25, status: 'weak', count: 3, total: 12 }), '3 of its 12 conditions are weak (25%)');
  assert.equal(coreNoDataText({ status: 'weak', noData: 1 }), '1 condition has no data');
});

test('the incident highlight counts Serious and Caution per chapter, not the worst mark alone (audit A1)', () => {
  // As SynGPT-2.0, Clinician Facing CDSS on the demo store: 2 serious in
  // Circulatory, 119 caution in Mental, 1 caution in Endocrine.
  const groups = [
    { id: 'CH-11', label: 'Circulatory', total: 120, counts: { serious: 2, strong: 60, moderate: 58 } },
    { id: 'CH-06', label: 'Mental', total: 160, counts: { caution: 119, moderate: 41 } },
    { id: 'CH-05', label: 'Endocrine', total: 90, counts: { caution: 1, strong: 89 } }
  ];
  const counts = { serious: 2, caution: 120, strong: 149, moderate: 99, weak: 0, no_data: 0 };
  const highlights = deriveHighlights({ viewId: 'overall', total: 370, counts, groups, hasIntendedUse: false });
  const incidents = highlights.find((item) => item.id === 'incidents');
  assert.equal(incidents.title, '122 conditions with a safety incident');
  assert.equal(incidents.tone, 'serious');
  assert.equal(incidents.targetId, 'CH-06');
  assert.match(incidents.text, /^2 serious, 120 caution\. Mostly in Mental \(119\)/);
  assert.doesNotMatch(incidents.text, /All in Circulatory/);
  assert.doesNotMatch(incidents.title, /open/);
});

test('highlights skip trivial groups and say a leading absence once (audit A17)', () => {
  // A chapter of 8 conditions no longer leads as "strongest" on a 2,400-condition card.
  const groups = [
    { id: 'CH-A', label: 'Small', total: 8, counts: { strong: 6, moderate: 2 } },
    { id: 'CH-B', label: 'Large', total: 400, counts: { strong: 80, moderate: 300, weak: 20 } },
    { id: 'CH-C', label: 'Weak one', total: 300, counts: { moderate: 200, weak: 100 } }
  ];
  const counts = { strong: 86, moderate: 502, weak: 120, out_of_scope: 0, no_data: 0 };
  const highlights = deriveHighlights({ viewId: 'performance', total: 708, counts, groups });
  assert.equal(highlights.find((item) => item.id === 'weakest').targetId, 'CH-C');
  // Large is 20% strong: below 25%, no "strongest" at all.
  assert.equal(highlights.find((item) => item.id === 'strongest'), undefined);
  assert.equal(defaultMinGroupSize(2400), 48);
  assert.equal(defaultMinGroupSize(300), 20);

  // No data leads: its "where" joins the lead instead of a second card.
  const missing = deriveHighlights({
    viewId: 'evidence',
    total: 100,
    counts: { strong: 10, moderate: 10, weak: 0, no_data: 80 },
    groups: [{ id: 'CH-1', label: 'One', total: 100, counts: { strong: 10, moderate: 10, no_data: 80 } }]
  });
  assert.equal(missing[0].title, 'No data for 80% of conditions');
  assert.match(missing[0].text, /All in One\.$/);
  assert.equal(missing[0].targetId, 'CH-1');
  assert.equal(missing.filter((item) => item.id === 'concentration-no_data').length, 0);
});

test('a narrow card leads with what is in scope and opens where it applies (audit A17, A18)', () => {
  // As SkinAI-1.0: 14 conditions in scope, all in Skin; 2,386 out of scope.
  const groups = [
    { id: 'CH-14', label: 'Skin', total: 182, counts: { strong: 11, moderate: 2, serious: 1, out_of_scope: 168 } },
    { id: 'CH-01', label: 'Infectious', total: 278, counts: { out_of_scope: 278 } },
    { id: 'CH-02', label: 'Neoplasms', total: 1940, counts: { out_of_scope: 1940 } }
  ];
  const counts = { serious: 1, caution: 0, strong: 11, moderate: 2, weak: 0, out_of_scope: 2386, no_data: 0 };
  const highlights = deriveHighlights({ viewId: 'overall', total: 2400, counts, groups, hasIntendedUse: true });
  const [lead] = highlights;
  assert.equal(lead.title, 'In scope for 14 conditions, all in Skin');
  assert.match(lead.text, /^11 strong, 2 moderate, and 0 weak; 1 serious incident\. 2,386 out of scope \(99%\)/);
  assert.equal(lead.targetId, 'CH-14');
  assert.equal(lead.tone, 'strong');
  // Out of scope is said once, in the lead.
  assert.equal(highlights.filter((item) => /Out of scope for/.test(item.title)).length, 0);
  // Skin is 6% strong: no "strongest chapter" for it.
  assert.equal(highlights.find((item) => item.id === 'strongest'), undefined);

  const scope = deriveHighlights({
    viewId: 'intended_use',
    total: 2400,
    counts: { in_scope: 14, partially_in_scope: 0, out_of_scope: 2386, no_data: 0 },
    groups: [
      { id: 'CH-14', label: 'Skin', total: 182, counts: { out_of_scope: 168, no_data: 0 } },
      { id: 'CH-02', label: 'Neoplasms', total: 2218, counts: { out_of_scope: 2218, no_data: 0 } }
    ],
    hasIntendedUse: true
  });
  assert.equal(scope[0].title, 'In scope for 14 conditions, all in Skin');
  assert.equal(scope[0].targetId, 'CH-14');
  assert.equal(scope.length, 1);
});

test('overview and extreme-area highlights carry a status strip', () => {
  const groups = [
    { id: 'A', label: 'Alpha', total: 10, counts: { strong: 9, weak: 1 } },
    { id: 'B', label: 'Beta', total: 10, counts: { strong: 2, weak: 8 } }
  ];
  const highlights = deriveHighlights({ viewId: 'overall', total: 20, counts: { strong: 11, moderate: 0, weak: 9, out_of_scope: 0, no_data: 0 }, groups });
  assert.equal(highlights[0].strip.total, 20);
  assert.equal(highlights.find((item) => item.id === 'weakest').strip.counts.weak, 8);
});

test('a subchapter or chapter without children reads No data, without scope warning or scope-stop (CONTRACT.md §6, V1)', () => {
  // As served for a Vantrel-Triage-2.1 block at Age 65+ (CDSS adds the p20 caution).
  const row = {
    status: { overall: 'out_of_scope', performance: 'no_data', evidence: 'no_data' },
    intended_use_level: 'out_of_scope',
    overall: { tier: 'out_of_scope', score: null, grade: null },
    warnings: [{ code: 'out_of_scope_group', relevance: 'High' }, { code: 'conservative_rollup_p20', relevance: 'Medium' }],
    safeguards: [{ id: 'scope-stop', priority: 'Critical' }, { id: 'perf-missing', priority: 'Critical' }],
    provenance: { source: 'rollup', anchor_concept_id: null, rollup: { child_count: 0, aggregation: 'weighted_mean' }, lens_fallback: false, data_source: null }
  };
  const subchapter = { concept_id: 'B', name: 'Some block', level: 1 };
  assert.equal(emptyRollupSentence(subchapter), 'No condition in this subchapter has results for this population.');
  assert.equal(emptyRollupSentence({ ...subchapter, level: 0 }), 'No condition in this chapter has results for this population.');
  assert.deepEqual(presentedWarnings(row, row.warnings), []);
  assert.deepEqual(presentedSafeguards(row, row.safeguards).map((item) => item.id), ['perf-missing']);
  // About this result never calls it a summary of 0 conditions.
  for (const depth of ['plain', 'expert']) {
    const about = aboutResult({ concept: subchapter, row, depth });
    assert.doesNotMatch(about.join(' '), /summary of 0|over 0/, depth);
    assert.match(about[0], depth === 'plain' ? /None of its conditions has a result for this population/ : /Rollup without children/);
    assert.equal(about.at(-1), SYNTHETIC_NOTE);
  }
  // Exports drop the same warning and safeguard and say No data.
  const file = buildConceptCardFile({
    exported_at: '2026-10-13T00:00:00Z',
    audience_view: 'patient',
    concept: { code: 'B', name: 'Some block' },
    context: { model: 'Vantrel-Triage-2.1', use_case: 'Emergency department triage', population: { age: 'Age 65+' } },
    model_card: row,
    warnings: row.warnings,
    safeguards: row.safeguards,
    synthetic_data_notice: 'Synthetic'
  });
  assert.equal(file.model_card.intended_use, 'No data');
  assert.deepEqual(Object.values(file.model_card.statuses), ['No data', 'No data', 'No data']);
  assert.deepEqual(file.warnings, []);
  assert.deepEqual(file.recommended_safeguards.map((item) => item.title), ['Collect local performance evidence']);
  // A genuinely out-of-scope rollup keeps its scope warning and safeguard.
  const genuine = { ...row, provenance: { ...row.provenance, rollup: { child_count: 27, aggregation: 'weighted_mean' } } };
  assert.equal(presentedWarnings(genuine, genuine.warnings).length, 2);
  assert.deepEqual(presentedSafeguards(genuine, genuine.safeguards).map((item) => item.id), ['scope-stop', 'perf-missing']);

  // The ring reads it as No data.
  const childlessMapRow = mapRow({ concept_id: 'B', overall_status: 'out_of_scope', evidence_status: 'no_data', intended_use_level: 'out_of_scope', overall_score: null, perf: null, child_count: 0 });
  for (const view of ['overall', 'evidence', 'intended_use']) {
    assert.equal(mapRowStatus(childlessMapRow, view), 'no_data', view);
  }

  // The card and the hover card draw it that way (source checks; JSX is not run here).
  const src = (file) => readFileSync(new URL(`../frontend/src/${file}`, import.meta.url), 'utf8');
  const card = src('features/details/DetailCard.jsx');
  assert.match(card, /const isEmptyRollup = isRollupWithoutChildren\(metrics\)/);
  assert.match(card, /metrics && !isEmptyRollup \? metricSections/);
  assert.match(card, /emptyRollupSentence\(concept\)/);
  assert.match(card, /presentedWarnings\(metrics, metrics\?\.warnings\)/);
  assert.match(card, /presentedSafeguards\(metrics, metrics\.safeguards\)/);
  assert.match(card, /rollupCount > 0 \? \(\s*<span>\s*Summary of/);
  const hover = src('features/atlas/HoverCard.jsx');
  assert.match(hover, /isRollupWithoutChildren\(row\)/);
  assert.match(hover, /emptyRollupSentence\(concept\)/);
});

test('the hover card counts one condition in the singular', () => {
  const hover = readFileSync(new URL('../frontend/src/features/atlas/HoverCard.jsx', import.meta.url), 'utf8');
  assert.match(hover, /tile\.disease_count === 1 \? 'condition' : 'conditions'/);
});
