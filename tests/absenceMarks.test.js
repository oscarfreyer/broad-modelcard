// V1: one mark per absence state, everywhere. The render sites are enumerated below; each must draw status
// through the shared mark (design/StatusMark.js) or a design component built
// on it, and nothing else may style a status mark. A condition without a row
// is No data on every view, including Intended use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import StatusMark, { StatusMarkShape, markShapes } from '../frontend/src/design/StatusMark.js';
import { rangeAbsence, rangeModel } from '../frontend/src/design/rangeScale.js';
import {
  ABSENCE_MEANING,
  ABSENCE_ORDER,
  DISPLAY,
  absenceCore,
  countStatuses,
  isRollupWithoutChildren,
  keysForView,
  mapRowStatus,
  metricRowStatus,
  ringKeyEntries,
  ringStatus
} from '../frontend/src/design/status.js';
import { metricSections } from '../frontend/src/features/details/metricSections.js';
import { summarizeMetricRow } from '../frontend/src/features/details/modelCardSummary.js';
import { deriveHighlights, groupStatusCounts } from '../frontend/src/features/summary/summaryHighlights.js';

const SRC = fileURLToPath(new URL('../frontend/src/', import.meta.url));
const read = (relative) => readFileSync(path.join(SRC, relative), 'utf8');

// Every V1 render site, the module that draws it,
// and the shared pieces it must draw with. StatusLabel, StatusStrip, and
// RangeChart are themselves built on StatusMark (checked below). The live
// plugin panel (S4) has no React, so it draws the same shapes from
// design/markShapes.js, the geometry StatusMark renders.
const RENDER_SITES = [
  { site: 'live plugin panel (statuses, safety, incidents, combination)', module: 'embed/panelView.js', uses: ['markShapes'], pattern: /markShapes\(status, \{ cx: half, cy: half, r: half - 1 \}\)/ },
  { site: 'catalogue tile (Overview counts and safety line)', module: 'features/catalogue/CatalogueTile.jsx', uses: ['StatusMark'] },
  { site: 'catalogue tile snapshot (miniature atlas ring)', module: 'features/label/CardSnapshot.js', uses: ['StatusMarkShape'] },
  { site: 'model card (distribution rows and incidents)', module: 'features/label/DeveloperLabel.js', uses: ['StatusMarkShape'] },
  { site: 'overview ring, both layouts, and chapter level (bubbles)', module: 'features/atlas/RingView.jsx', uses: [], pattern: /<RingBubbles[\s\S]*<RingCores/ },
  { site: 'subchapter centres (weak share; Intended use: no scope fit)', module: 'features/atlas/RingBubbles.jsx', uses: ['StatusMarkShape'], pattern: /className="bubble-core"/ },
  { site: 'ring bubbles (memoized layer)', module: 'features/atlas/RingBubbles.jsx', uses: ['StatusMarkShape', 'ringStatus'] },
  { site: 'legend entries (the ring key and the counts by mark)', module: 'features/atlas/RingLegend.jsx', uses: ['StatusMark', 'StatusMarkShape'] },
  { site: 'legend entries in view', module: 'features/atlas/RingPane.jsx', uses: ['ringKeyEntries'] },
  { site: 'hover card', module: 'features/atlas/HoverCard.jsx', uses: ['StatusLabel', 'StatusMark', 'ringStatus'] },
  { site: 'summary highlights', module: 'features/summary/SummaryPanel.jsx', uses: ['StatusMark', 'StatusStrip'] },
  { site: 'summary strip', module: 'design/StatusStrip.jsx', uses: ['DISPLAY'], pattern: /strip-\$\{DISPLAY\[key\]\.form\}/ },
  { site: 'detail card header', module: 'features/details/DetailCard.jsx', uses: ['StatusLabel'] },
  { site: 'detail card metric sections', module: 'features/details/ResultSections.jsx', uses: ['StatusLabel', 'RangeChart'] },
  { site: 'range charts', module: 'design/RangeChart.jsx', uses: ['StatusMark', 'rangeAbsence'] },
  { site: 'multimorbidity panel and candidate list', module: 'features/multimorbidity/CombinationPanel.jsx', uses: ['StatusLabel', 'StatusMark'] },
  { site: 'Data Library change summary', module: 'features/admin/ChangesStep.jsx', uses: ['StatusMark'] },
  // R4: the comparison table's cells (Overview mark, safety mark, compact range chart).
  { site: 'comparison cells', module: 'features/compare/ComparisonTable.jsx', uses: ['StatusMark', 'RangeChart'], pattern: /<StatusMark status=\{mark\}/ },
  { site: 'status label (word plus mark)', module: 'design/StatusLabel.jsx', uses: ['StatusMark'] },
  // S3 Safety view: every Safety mark is drawn by the same component.
  { site: 'Safety view legend', module: 'features/atlas/RingLegend.jsx', uses: ['StatusMark'], pattern: /DISPLAY\[key\]\.label, legendMeaning\(key\)\]/ },
  { site: 'Safety view hover card (incident mark and tally)', module: 'features/atlas/HoverCard.jsx', uses: ['StatusLabel', 'ringStatus'], pattern: /tallyText\(tally\)/ },
  { site: 'Safety view legend counts', module: 'features/atlas/RingLegend.jsx', uses: ['StatusMark'], pattern: /legendKeys\(\{ viewId, hasIntendedUse, absences(?:, withMapping: [^}]+)? \}\)/ },
  { site: 'card Safety incidents section', module: 'features/details/IncidentList.js', uses: ['StatusMark'] },
  { site: 'card header open-incidents chip', module: 'features/details/DetailCard.jsx', uses: ['StatusMark', 'StatusLabel'], pattern: /<StatusMark status=\{incidentChip\.tone\}/ },
  { site: 'catalogue Safety tab lead', module: 'features/catalogue/CatalogueTile.jsx', uses: ['StatusMark'], pattern: /<StatusMark status="no_incidents" \/>/ }
];

const SHARED_IMPORTS = {
  StatusMark: /import StatusMark(?:, \{[^}]*\})? from '[./]+design\/StatusMark\.js'|import StatusMark(?:, \{[^}]*\})? from '\.\/StatusMark\.js'/,
  StatusMarkShape: /import (?:StatusMark, )?\{ StatusMarkShape \} from '[./]*(?:design\/)?StatusMark\.js'/,
  StatusLabel: /import StatusLabel from '[./]+design\/StatusLabel\.jsx'/,
  StatusStrip: /import StatusStrip from '[./]+design\/StatusStrip\.jsx'/,
  RangeChart: /import RangeChart from '[./]+design\/RangeChart\.jsx'/,
  ringStatus: /\bringStatus\b/,
  ringKeyEntries: /\bringKeyEntries\b/,
  rangeAbsence: /\brangeAbsence\b/,
  DISPLAY: /\bDISPLAY\b/,
  markShapes: /import \{ markShapes \} from '[./]+design\/markShapes\.js'/
};

function listSourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return listSourceFiles(full);
    }
    return /\.(js|jsx|css)$/.test(name) ? [full] : [];
  });
}
const SOURCES = listSourceFiles(SRC).map((file) => ({ file: path.relative(SRC, file).split(path.sep).join('/'), text: readFileSync(file, 'utf8') }));

test('every V1 render site draws status through the shared mark', () => {
  for (const { site, module, uses, pattern } of RENDER_SITES) {
    const source = read(module);
    for (const name of uses) {
      assert.match(source, SHARED_IMPORTS[name], `${site} (${module}) uses ${name}`);
    }
    if (pattern) {
      assert.match(source, pattern, `${site} (${module})`);
    }
    // No hand-drawn status circles or legacy form classes at a render site.
    assert.doesNotMatch(source, /form-(?:fill|hollow|faint|empty|muted|loading)/, `${site} (${module}) has no legacy form class`);
    assert.doesNotMatch(source, /\bStatusDot\b/, `${site} (${module}) does not use the retired StatusDot`);
  }
});

test('only StatusMark.js and marks.css draw marks; the old absence greys are gone', () => {
  for (const { file, text } of SOURCES) {
    if (file === 'design/StatusMark.js' || file === 'design/markShapes.js' || file === 'styles/marks.css' || file === 'styles/tokens.css') {
      continue;
    }
    assert.doesNotMatch(text, /\bmark-(?:fill|outline|ring|barred|dashed|dot|pale|quiet|alert|glyph)/, `${file} does not style or emit mark classes`);
    assert.doesNotMatch(text, /--mark-/, `${file} does not read mark tokens`);
    assert.doesNotMatch(text, /\.strip-(?:fill|outline|ring|barred|dashed)/, `${file} does not style strip bands`);
    assert.doesNotMatch(text, /--absent-(?:hollow|empty|muted)|--loading\b/, `${file} uses no retired absence token`);
  }
  const marks = read('styles/marks.css');
  // D9: No data is an opaque light grey disc with a solid dark grey outline;
  // the retired ring (Not validated) and dashed forms and their tokens are gone.
  assert.match(marks, /\.mark-outline \{[^}]*fill: var\(--mark-outline-fill\)/);
  assert.match(marks, /\.mark-outline \{[^}]*stroke-width: var\(--mark-stroke-width\)/);
  assert.match(read('styles/tokens.css'), /--mark-outline-fill: #ededf1;/i);
  assert.match(read('styles/tokens.css'), /--mark-outline: #[0-9a-f]{6};/i);
  for (const { file, text } of SOURCES) {
    assert.doesNotMatch(text, /mark-ring|mark-dashed|strip-ring|strip-dashed|--mark-dash\b|--mark-ring/, `${file} has no ring or dashed mark`);
  }
  // No dimmed marks (the centre used to fade zero-count dots to 45 %).
  for (const { file, text } of SOURCES.filter((entry) => entry.file.endsWith('.css'))) {
    assert.doesNotMatch(text, /\.status-mark[^{]*\{[^}]*opacity/, `${file} does not fade marks`);
  }
});

test('each absence state has exactly one mark, distinct from every other', () => {
  const signature = (status) => markShapes(status, { cx: 6, cy: 6, r: 5 }).map((shape) => `${shape.type}.${shape.props.className}`).join('+');
  const absence = ABSENCE_ORDER.map(signature);
  assert.equal(new Set(absence).size, ABSENCE_ORDER.length, absence.join(' | '));
  // Also distinct from the result fills and the Safety marks.
  const all = [...ABSENCE_ORDER, 'strong', 'no_incidents', 'caution', 'serious'].map(signature);
  assert.equal(new Set(all).size, all.length);
  // The same classes at every size: a bubble, a key sample, and a status dot draw the same mark.
  for (const status of [...ABSENCE_ORDER, 'no_incidents', 'caution', 'serious']) {
    const classes = (r) => markShapes(status, { cx: 0, cy: 0, r }).map((shape) => shape.props.className).join('|');
    assert.equal(classes(2.88), classes(16.8), status);
    assert.equal(classes(2.88), classes(5), status);
  }
  for (const key of ABSENCE_ORDER) {
    assert.ok(ABSENCE_MEANING[key], `${key} has a key meaning`);
  }
});

test('the HTML and SVG variants render the same mark', () => {
  for (const status of [...ABSENCE_ORDER, 'strong', 'caution', 'serious', 'no_incidents']) {
    const html = renderToStaticMarkup(createElement(StatusMark, { status }));
    const svg = renderToStaticMarkup(createElement('svg', null, createElement(StatusMarkShape, { status, cx: 6, cy: 6, r: 5 })));
    const body = (markup) => markup.match(/<circle class="(mark [^"]+)"/)[1];
    assert.equal(body(html), body(svg), status);
    assert.match(html, new RegExp(`data-status="${status}"`));
    assert.equal((html.match(/mark-glyph/g) || []).length, (svg.match(/mark-glyph/g) || []).length, status);
  }
  // The ring passes its interaction props onto the body only.
  const bubble = renderToStaticMarkup(
    createElement('svg', null, createElement(StatusMarkShape, { status: 'out_of_scope', cx: 1, cy: 1, r: 4, className: 'bubble', bodyProps: { role: 'button', 'data-tile-id': 'T1' } }))
  );
  assert.match(bubble, /<circle role="button" data-tile-id="T1" class="mark mark-barred tone-absent bubble"/);
  assert.match(bubble, /<rect class="mark-glyph mark-glyph-bar"[^>]*aria-hidden="true"/);
});

test('Safety marks are prepared: neutral when nothing is reported, a warning glyph and word otherwise', () => {
  assert.equal(DISPLAY.no_incidents.label, 'No reported incidents');
  assert.notEqual(DISPLAY.no_incidents.tone, 'strong', 'never green');
  assert.deepEqual([DISPLAY.caution.tone, DISPLAY.serious.tone], ['moderate', 'weak'], 'amber and coral');
  for (const status of ['caution', 'serious']) {
    const glyphs = markShapes(status, { cx: 0, cy: 0, r: 6 }).filter((shape) => shape.role === 'glyph');
    assert.equal(glyphs.length, 2, `${status} carries a "!" (stem and dot)`);
  }
});

test('one rule for "no row": No data on every view, including Intended use', () => {
  for (const view of ['overall', 'performance', 'evidence', 'intended_use']) {
    assert.equal(mapRowStatus(null, view), 'no_data', view);
    assert.equal(metricRowStatus(null, view), 'no_data', view);
    assert.equal(ringStatus(null, view), 'no_data', view);
  }
  // A row without an intended-use level is not "out of scope" either; only the data says that.
  assert.equal(metricRowStatus({ status: {}, intended_use_level: null }, 'intended_use'), 'no_data');
  assert.equal(mapRowStatus({ intended_use_level: 'out_of_scope' }, 'intended_use'), 'out_of_scope');
  // Multimorbidity keeps its own state for a missing display row; loading wins over all.
  assert.equal(ringStatus(null, 'intended_use', { isCombinationMode: true }), 'no_combination');
  assert.equal(ringStatus({ overall_status: 'strong' }, 'overall', { isLoading: true }), 'loading');

  // Counts, chapter groups, and the Summary strip.
  const rows = [{ intended_use_level: 'in_scope' }, null, { intended_use_level: 'out_of_scope' }];
  assert.deepEqual(countStatuses(rows, 'intended_use'), { in_scope: 1, partially_in_scope: 0, out_of_scope: 1, no_data: 1 });
  const concepts = [{ concept_id: 'A', parent_id: 'G' }, { concept_id: 'B', parent_id: 'G' }];
  const groups = groupStatusCounts(concepts, new Map([['A', { intended_use_level: 'in_scope' }]]), 'intended_use', (c) => c.parent_id, {});
  assert.deepEqual(groups[0].counts, { in_scope: 1, no_data: 1 });
  const [overview] = deriveHighlights({ viewId: 'intended_use', total: 3, counts: { in_scope: 1, partially_in_scope: 0, out_of_scope: 1, no_data: 1 }, groups: [] });
  assert.deepEqual(overview.strip.keys, keysForView('intended_use'));
  assert.ok(overview.strip.keys.includes('no_data'));

  // Detail card sections and the export summary.
  const row = { status: { overall: 'strong', performance: 'strong', evidence: 'strong' }, intended_use_level: null, overall: { tier: 'graded', score: 0.8 }, perf: 0.85, evidence_signal: 0.9, evidence_grade: 'A' };
  const scope = metricSections(row, {}).find((section) => section.viewId === 'intended_use');
  assert.equal(scope.status, 'no_data');
  assert.equal(scope.chart.level, 'no_data');
  assert.equal(rangeAbsence(scope.chart), 'no_data');
  assert.equal(summarizeMetricRow(row).intendedUse, 'No data');
});

test('a rollup without children is No data on every view, never Out of scope (CONTRACT.md §6, V1)', () => {
  // As served for Vantrel-Triage-2.1 at Age 65+ (all 225 blocks), and a genuinely
  // out-of-scope block as served for ICU_GPT-1.0, CDSS at All ages.
  const childless = { concept_id: 'B0', overall_status: 'out_of_scope', performance_status: 'no_data', evidence_status: 'no_data', intended_use_level: 'out_of_scope', safety: null, child_count: 0 };
  const outOfScope = { ...childless, concept_id: 'B1', child_count: 27 };
  assert.ok(isRollupWithoutChildren(childless));
  assert.ok(!isRollupWithoutChildren(outOfScope));
  assert.ok(!isRollupWithoutChildren({ concept_id: 'C', child_count: null }), 'a condition row is not a rollup');
  for (const view of ['overall', 'performance', 'evidence', 'intended_use']) {
    assert.equal(mapRowStatus(childless, view), 'no_data', view);
    assert.equal(ringStatus(childless, view), 'no_data', view);
  }
  assert.equal(mapRowStatus(outOfScope, 'overall'), 'out_of_scope');
  assert.equal(mapRowStatus(outOfScope, 'evidence'), 'no_data');
  // A served `not_validated` (before contract v1.11) reads No data too (D5).
  assert.equal(mapRowStatus({ ...outOfScope, evidence_status: 'not_validated' }, 'evidence'), 'no_data');
  assert.equal(mapRowStatus(outOfScope, 'intended_use'), 'out_of_scope');
  assert.equal(mapRowStatus(childless, 'safety'), 'no_incidents');
  assert.equal(ringStatus(childless, 'overall', { isLoading: true }), 'loading');

  // The key: a No data entry and no Out of scope entry when none is drawn.
  const tiles = [{ concept_id: 'B0' }, { concept_id: 'B2' }];
  const rows = new Map([['B0', childless], ['B2', { ...childless, concept_id: 'B2' }]]);
  for (const view of ['overall', 'evidence', 'intended_use']) {
    assert.deepEqual(ringKeyEntries({ tiles, rowsById: rows, viewId: view }).absences, ['no_data'], view);
  }
  rows.set('B1', outOfScope);
  assert.deepEqual(ringKeyEntries({ tiles: [...tiles, { concept_id: 'B1' }], rowsById: rows, viewId: 'overall' }).absences, ['out_of_scope', 'no_data']);
  // No centre on a No data bubble: centres sit only in a coloured rim.
  const cores = new Map([['B0', absenceCore([null, null], 'overall')]]);
  assert.deepEqual(ringKeyEntries({ tiles, rowsById: rows, viewId: 'overall', coresById: cores }), { absences: ['no_data'], safety: [], hasCores: false });

  // The concept read (detail card, exports) follows the same rule.
  const metricRow = { status: { overall: 'out_of_scope', performance: 'no_data', evidence: 'not_validated' }, intended_use_level: 'out_of_scope', overall: { tier: 'out_of_scope', score: null, grade: null }, provenance: { source: 'rollup', rollup: { child_count: 0, aggregation: 'p20' } } };
  for (const view of ['overall', 'performance', 'evidence', 'intended_use']) {
    assert.equal(metricRowStatus(metricRow, view), 'no_data', view);
  }
  assert.deepEqual(Object.values(summarizeMetricRow(metricRow).statuses), ['No data', 'No data', 'No data']);
  assert.equal(summarizeMetricRow(metricRow).intendedUse, 'No data');
  const genuine = { ...metricRow, provenance: { source: 'rollup', rollup: { child_count: 4, aggregation: 'p20' } } };
  assert.equal(metricRowStatus(genuine, 'overall'), 'out_of_scope');
  assert.equal(summarizeMetricRow(genuine).intendedUse, 'Out of scope');
});

test('range charts draw the absence mark instead of an empty track', () => {
  assert.equal(rangeAbsence(rangeModel({ view: 'evidence', value: null, status: 'no_data' })), 'no_data');
  assert.equal(rangeAbsence(rangeModel({ view: 'overall', value: null, status: 'out_of_scope' })), 'out_of_scope');
  assert.equal(rangeAbsence(rangeModel({ view: 'performance', value: null, status: 'no_data' })), 'no_data');
  // A value, or a result status without a value (its zone fills), keeps the track.
  assert.equal(rangeAbsence(rangeModel({ view: 'performance', value: 0.8, status: 'strong' })), null);
  assert.equal(rangeAbsence(rangeModel({ view: 'evidence', value: null, status: 'moderate' })), null);
  // The scope track keeps Out of scope as its own step (in the barred band), and has no step for No data.
  assert.equal(rangeAbsence({ kind: 'scope', level: 'out_of_scope' }), null);
  assert.equal(rangeAbsence({ kind: 'scope', level: null }), 'no_data');
  assert.match(read('design/RangeChart.jsx'), /isActive \? `strip-\$\{form\}`/);
});

test('the key explains every absence mark in view, at overview, chapter level, and in Multimorbidity', () => {
  const tiles = [{ concept_id: 'A' }, { concept_id: 'B' }, { concept_id: 'C' }, { concept_id: 'D' }, { isEmpty: true }];
  const rows = new Map([
    ['A', { overall_status: 'strong' }],
    ['B', { overall_status: 'not_validated' }], // served before v1.11: reads No data (D5)
    ['C', { overall_status: 'out_of_scope' }]
  ]);
  assert.deepEqual(ringKeyEntries({ tiles, rowsById: rows, viewId: 'overall' }), { absences: ['out_of_scope', 'no_data'], safety: [], hasCores: false });
  // Subchapter centres add their own state.
  const cores = new Map([['A', { share: 0.4, status: 'out_of_scope' }]]);
  assert.deepEqual(ringKeyEntries({ tiles: tiles.slice(0, 1), rowsById: rows, viewId: 'overall', coresById: cores }), { absences: ['out_of_scope'], safety: [], hasCores: true });
  // Intended use: a condition without a row is No data, never Out of scope.
  assert.deepEqual(ringKeyEntries({ tiles: [{ concept_id: 'D' }], rowsById: rows, viewId: 'intended_use' }).absences, ['no_data']);
  // Multimorbidity: a missing display row is No stored combination.
  assert.deepEqual(ringKeyEntries({ tiles, rowsById: rows, viewId: 'overall', isCombinationMode: true }).absences, ['out_of_scope', 'no_data', 'no_combination']);
  assert.deepEqual(ringKeyEntries({ tiles, rowsById: rows, viewId: 'overall', isLoading: true }).absences, ['loading']);
  // The legend renders one entry per mark with its mark; an absence's meaning is in its help and the row's tooltip.
  const legend = read('features/atlas/RingLegend.jsx');
  assert.match(legend, /<StatusMark status=\{status\} size=\{12\} \/>/);
  assert.match(legend, /DISPLAY\[key\]\.label, legendMeaning\(key\)\]/);
  assert.match(legend, /<HelpTip label="About the legend">[\s\S]*meanings\.map/);
  assert.match(read('features/atlas/legendEntries.js'), /SAFETY_MEANING\[key\] \?\? ABSENCE_MEANING\[key\]/);
  assert.match(read('features/atlas/RingPane.jsx'), /absences=\{absences\}/);
});

test('the live panel draws the same mark as StatusMark, for every state', async () => {
  const { markNode } = await import('../frontend/src/embed/panelView.js');
  const classesOf = (node) => node.children.map((child) => `${child.tag}.${child.attrs.class}`).join('+');
  for (const status of [...ABSENCE_ORDER, 'strong', 'moderate', 'weak', 'in_scope', 'partially_in_scope', 'no_incidents', 'caution', 'serious']) {
    const html = renderToStaticMarkup(createElement(StatusMark, { status, size: 14 }));
    const shapes = [...html.matchAll(/<(circle|rect|path) class="([^"]+)"/g)].map((match) => `${match[1]}.${match[2]}`).join('+');
    const node = markNode(status, 14);
    assert.equal(node.attrs.class, 'status-mark');
    assert.equal(node.attrs['data-status'], status);
    assert.equal(classesOf(node), shapes, status);
  }
});
