// Overview and cards without an intended-use statement (D8):
// the order of marks per condition and subchapter, the counts and Summary that
// agree with what is drawn, and the disabled Intended use view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NO_STATEMENT_TEXT,
  countStatuses,
  hasIntendedUseStatement,
  keysForView,
  mapRowStatus,
  normalizeCounts,
  normalizeStatus,
  overviewStatus,
  ringKeyEntries,
  ringStatus,
  viewLabel
} from '../frontend/src/design/status.js';
import { metricSections } from '../frontend/src/features/details/metricSections.js';
import { deriveHighlights, groupStatusCounts } from '../frontend/src/features/summary/summaryHighlights.js';
import { systemDetails } from '../frontend/src/features/summary/systemDetails.js';

const read = (relative) => readFileSync(new URL(`../frontend/src/${relative}`, import.meta.url), 'utf8');

test('the view is called Overview; its URL and contract value stay "overall"', () => {
  assert.equal(viewLabel('overall'), 'Overview');
  assert.match(read('app/startupParams.js'), /'overall'/);
});

test('Overview, first match wins: open incident, out of scope (with a statement), the grade, else No data', () => {
  const strong = { overall_status: 'strong', safety: null };
  assert.equal(mapRowStatus({ ...strong, safety: 'serious' }, 'overall'), 'serious');
  assert.equal(mapRowStatus({ ...strong, safety: 'caution' }, 'overall'), 'caution');
  // (a) beats (b): an incident on an out-of-scope condition still shows.
  assert.equal(mapRowStatus({ overall_status: 'out_of_scope', safety: 'caution' }, 'overall'), 'caution');
  assert.equal(mapRowStatus({ overall_status: 'out_of_scope', safety: null }, 'overall'), 'out_of_scope');
  assert.equal(mapRowStatus(strong, 'overall'), 'strong');
  assert.equal(mapRowStatus({ overall_status: 'not_validated', safety: null }, 'overall'), 'no_data');
  assert.equal(mapRowStatus(null, 'overall'), 'no_data');
  // Without an intended-use statement nothing is out of scope on Overview.
  assert.equal(mapRowStatus({ overall_status: 'out_of_scope', safety: null }, 'overall', { hasIntendedUse: false }), 'no_data');
  assert.equal(mapRowStatus({ overall_status: 'out_of_scope', safety: 'serious' }, 'overall', { hasIntendedUse: false }), 'serious');
  // A subchapter row carries its worst condition's mark (CONTRACT.md §18), so it reads the same way.
  assert.equal(ringStatus({ overall_status: 'moderate', safety: 'serious', child_count: 12 }, 'overall'), 'serious');
  assert.equal(ringStatus({ overall_status: 'moderate', safety: null, child_count: 12 }, 'overall'), 'moderate');
  // Combinations have no incidents of their own: their grade shows.
  assert.equal(ringStatus({ overall_status: 'weak', safety: 'serious' }, 'overall', { isCombinationMode: true }), 'weak');
  // Safety never changes a grade on Performance or Evidence.
  assert.equal(mapRowStatus({ performance_status: 'strong', safety: 'serious' }, 'performance'), 'strong');
});

test('the detail card header reads the same order from a concept read and its incidents', () => {
  const row = { status: { overall: 'strong' } };
  assert.equal(overviewStatus(row, 'serious'), 'serious');
  assert.equal(overviewStatus(row, 'caution'), 'caution');
  assert.equal(overviewStatus(row, 'no_incidents'), 'strong');
  assert.equal(overviewStatus({ status: { overall: 'out_of_scope' } }, 'no_incidents', { hasIntendedUse: false }), 'no_data');
  assert.equal(overviewStatus(null, 'no_incidents'), 'no_data');
  const card = read('features/details/DetailCard.jsx');
  assert.match(card, /overviewStatus\(metrics, incidentsMark\(incidents\), \{ hasIntendedUse \}\)/);
});

test('counts, key, and Summary agree with the marks drawn on Overview', () => {
  const rows = [
    { overall_status: 'strong', safety: 'serious' },
    { overall_status: 'strong', safety: null },
    { overall_status: 'weak', safety: 'caution' },
    { overall_status: 'out_of_scope', safety: null },
    null
  ];
  assert.deepEqual(countStatuses(rows, 'overall'), { strong: 1, moderate: 0, weak: 0, out_of_scope: 1, no_data: 1, serious: 1, caution: 1 });
  const tiles = rows.map((_, index) => ({ concept_id: `C${index}` }));
  const rowsById = new Map(rows.map((row, index) => [`C${index}`, row]));
  assert.deepEqual(ringKeyEntries({ tiles, rowsById, viewId: 'overall' }), { absences: ['out_of_scope', 'no_data'], safety: ['serious', 'caution'], hasCores: false });
  // Off Overview the key lists no incident marks.
  assert.deepEqual(ringKeyEntries({ tiles, rowsById, viewId: 'performance' }).safety, []);

  const concepts = rows.map((_, index) => ({ concept_id: `C${index}`, chapter_id: index < 3 ? 'CH-1' : 'CH-2' }));
  const groups = groupStatusCounts(concepts, rowsById, 'overall', (concept) => concept.chapter_id, { 'CH-1': 'One', 'CH-2': 'Two' });
  assert.deepEqual(groups[0].counts, { serious: 1, strong: 1, caution: 1 });
  const counts = { strong: 1, moderate: 0, weak: 0, out_of_scope: 1, no_data: 1, serious: 1, caution: 1 };
  const highlights = deriveHighlights({ viewId: 'overall', total: 5, counts, groups });
  const [overview] = highlights;
  assert.deepEqual(overview.strip.keys, ['serious', 'caution', 'strong', 'moderate', 'weak', 'out_of_scope', 'no_data']);
  assert.match(overview.text, /2 with an incident\./);
  const incidents = highlights.find((item) => item.id === 'incidents');
  assert.equal(incidents.title, '2 conditions with a safety incident');
  assert.equal(incidents.targetId, 'CH-1');
  assert.doesNotMatch(incidents.text, /never change/, 'the legend says it once');
  // The legend lists the incident rows first on Overview, kept (dimmed) at zero so the list never jumps.
  const legend = read('features/atlas/legendEntries.js');
  assert.match(legend, /\.\.\.\(viewId === 'overall' \? ALERT_ORDER : \[\]\)/);
  // Overview counts the map rows on screen, never a summary that does not know the incidents.
  // Another classification (contract v1.13) counts the map rows on every view, so No mapping is told from No data.
  assert.match(read('features/summary/useRingSummary.js'), /const fromMap = isOverview \|\| withMapping;/);
  assert.match(read('features/summary/useRingSummary.js'), /const key = filters && !fromMap \?/);
});

test('a card without an intended-use statement: no Out of scope key, no scope wording, the D3 weights', () => {
  assert.equal(hasIntendedUseStatement({ use_case: 'X' }), true, 'absent means a statement');
  assert.equal(hasIntendedUseStatement({ use_case: 'X', intended_use_defined: false }), false);
  assert.deepEqual(keysForView('overall', { hasIntendedUse: false }), ['strong', 'moderate', 'weak', 'no_data']);

  const row = {
    status: { overall: 'strong', performance: 'strong', evidence: 'strong' },
    overall: { tier: 'graded', score: 0.81, grade: 'B' },
    perf: 0.86,
    evidence_grade: 'A',
    evidence_signal: 0.9,
    intended_use_level: null
  };
  const weights = { performance_grade: 0.35 / 0.85, perf: 0.2 / 0.85, evidence_grade: 0.3 / 0.85 };
  const sections = Object.fromEntries(
    metricSections(row, { depth: 'expert', hasIntendedUse: false, overallScoreWeights: weights }).map((section) => [section.viewId, section])
  );
  // A neutral "No statement", never the No data mark (audit A3).
  assert.equal(sections.intended_use.status, null);
  assert.equal(sections.intended_use.statusWord, 'No statement');
  assert.equal(sections.intended_use.meaning, null, 'the header says No statement; no sentence repeats it');
  assert.equal(sections.intended_use.isAbsent, true);
  assert.equal(sections.overall.meaning, 'Score 0.810.');
  assert.equal(sections.overall.help, 'Weights: performance grade 41%, performance 24%, evidence grade 35%.');
  const plain = metricSections(row, { depth: 'plain', hasIntendedUse: false }).find((section) => section.viewId === 'overall');
  assert.doesNotMatch(plain.help, /intended-use fit/);

  const details = systemDetails({ model_version: 'M', developer: 'Dev' }, { use_case: 'Chat', intended_use_defined: false });
  assert.deepEqual(details.facts.find((fact) => fact.id === 'intended_use'), { id: 'intended_use', label: 'Intended use', value: 'No intended-use statement' });
  assert.equal(systemDetails({ model_version: 'M', developer: 'Dev' }, { use_case: 'Chat' }).facts.some((fact) => fact.id === 'intended_use'), false);
});

test('the Intended use view is disabled with its reason, and a link to it opens Overview', () => {
  const toolbar = read('features/toolbar/Toolbar.jsx');
  assert.match(toolbar, /option\.value === 'intended_use' \? \{ \.\.\.option, disabled: true, reason: NO_STATEMENT_TEXT \}/);
  assert.equal(NO_STATEMENT_TEXT, 'This card has no intended-use statement.');
  const control = read('design/SegmentedControl.jsx');
  assert.match(control, /aria-disabled=\{option\.disabled \? true : undefined\}/);
  assert.match(control, /aria-describedby=\{reasonId\}/);
  assert.match(control, /title=\{option\.disabled \? option\.reason \?\? option\.title : option\.title\}/);
  // Arrow keys skip a disabled segment, and a click on it changes nothing.
  assert.match(control, /if \(!options\[next\]\.disabled\)/);
  assert.match(control, /if \(!option\.disabled\) \{\s*onChange\(option\.value\);/);
  const app = read('app/AtlasApp.jsx');
  assert.match(app, /requestedViewId === 'intended_use' && shownFunction && !hasIntendedUse \? 'overall' : requestedViewId/);
});

test('a served not_validated is No data in one place', () => {
  assert.equal(normalizeStatus('not_validated'), 'no_data');
  assert.equal(normalizeStatus('weak'), 'weak');
  assert.deepEqual(normalizeCounts({ strong: 1, not_validated: 2, no_data: 3 }), { strong: 1, no_data: 5 });
  assert.deepEqual(normalizeCounts({ strong: 1 }), { strong: 1 });
  assert.equal(normalizeCounts(null), null);
});
