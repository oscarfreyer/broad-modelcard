// Critique round 1, phases 4–6: the atlas centre names the
// unit it counts and how it is drawn (R1); chapter labels read at no less
// than 13 px at 1280 and 1440 widths, never end in an ellipsis, and open
// their chapter by mouse and keyboard (R2); a staged update can be discarded
// from the Check step at any stage (M1); and the polish items (one absence
// name per metric section, the shared function wording).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAtlasStructure } from '../frontend/src/features/atlas/atlasStructure.js';
import {
  ATLAS_LABEL_PAD,
  ATLAS_LABEL_RADIUS,
  LABEL_MIN_PX,
  isReversedArc,
  labelEm,
  planChapterLabel,
  planChapterLabels,
  quantizeScale
} from '../frontend/src/features/atlas/arcLabels.js';
import { ATLAS_LAYOUT_MODES, buildLevelOneModel } from '../frontend/src/features/atlas/layout/atlasLayout.js';
import { MODELCARD_INNER_RADIUS } from '../frontend/src/features/atlas/layout/atlasGeometry.js';
import { chapterShortLabel } from '../frontend/src/features/atlas/layout/chapterLabels.js';
import { nextChapterId } from '../frontend/src/features/atlas/ringKeyboard.js';
import { drawnBubbles } from '../frontend/src/features/atlas/ringUnits.js';
import { metricSections } from '../frontend/src/features/details/metricSections.js';
import { readPanelInputs } from '../frontend/src/embed/panelInputs.js';
import { renderPanel, textOf } from '../frontend/src/embed/panelView.js';
import { apiClient, startTestBackend } from './support/backend.js';

const read = (relative) => readFileSync(new URL(`../frontend/src/${relative}`, import.meta.url), 'utf8');

// CSS px per SVG unit of the atlas ring, measured in Chrome on the atlas at
// these viewports (ring width / 960; re-measured 2026-10-14 with the legend
// tile beside the ring), as the frame quantizes them. The legend's width is
// fixed, so every view (Overview to Safety), both modes, and a chapter have
// the same ring size. 1280×700 is a 1280×800 screen with the browser's own
// toolbars.
const MEASURED_SCALE = { '1280×700': 0.5708, '1280×800': 0.6083, '1366×768': 0.6417, '1440×900': 0.7333, '1536×864': 0.7417 };
const RING_SCALE = Object.fromEntries(Object.entries(MEASURED_SCALE).map(([viewport, scale]) => [viewport, quantizeScale(scale)]));
// Below the floor: a 1280×680 viewport (0.55) and a phone (0.36).
const SMALL_SCALE = { '1280×680': quantizeScale(0.55), '375×812': quantizeScale(0.3656) };

// Widths in em of the chapter short names as Chrome renders them at 13 px
// (SF Pro Text, weight 600, letter-spacing 0.01em), measured with
// getComputedTextLength on the atlas.
const MEASURED_EM = {
  Infectious: 4.648,
  Neoplasms: 5.238,
  Blood: 2.693,
  Immune: 3.782,
  Metabolic: 4.617,
  Mental: 3.203,
  Sleep: 2.636,
  Nervous: 3.918,
  Vision: 2.879,
  Ear: 1.529,
  Circulatory: 5.184,
  Respiratory: 5.423,
  Digestive: 4.372,
  Skin: 2.031,
  'Bone & joint': 5.62,
  Urogenital: 4.873,
  'Sexual health': 6.288,
  Sexual: 3.121,
  health: 2.931,
  Pregnancy: 5.015,
  Perinatal: 4.139,
  Anomalies: 4.897,
  Injuries: 3.431
};

let backend;
let structure;
before(async () => {
  backend = await startTestBackend();
  structure = buildAtlasStructure(await apiClient(backend.origin).getAtlasOverview());
});
after(() => backend?.stop());

const levelOne = (layoutMode) =>
  buildLevelOneModel({
    chapterConcepts: structure.chapterConcepts,
    blocksByChapterId: structure.blocksByChapterId,
    conditionsByBlockId: structure.topLevelConditionsByBlockId,
    conceptPrevalenceById: structure.conceptPrevalenceById,
    layoutMode
  });

// ---------------------------------------------------------------------------
// The inner radius (2026-10-15)

test('every chapter sector starts at the inner rim with its largest subchapter bubbles, sizes stepping down outward', () => {
  const model = levelOne('Chapter modelcard');
  const sectors = new Map();
  for (const tile of model.tiles) {
    const angle = (Math.atan2(tile.x - 500, 500 - tile.y) + Math.PI * 2) % (Math.PI * 2);
    const index = Math.floor(angle / ((Math.PI * 2) / structure.chapterConcepts.length));
    sectors.set(index, [...(sectors.get(index) || []), tile]);
  }
  assert.equal(sectors.size, structure.chapterConcepts.length);
  for (const [index, tiles] of sectors) {
    const largest = Math.max(...tiles.map((tile) => tile.r));
    const innermost = tiles.reduce((best, tile) => (tile.packed_radius - tile.r < best.packed_radius - best.r ? tile : best));
    // The innermost bubble is one of the sector's largest and touches the rim.
    assert.equal(innermost.r, largest, `sector ${index}: innermost r ${innermost.r.toFixed(1)}, largest ${largest.toFixed(1)}`);
    assert.ok(innermost.packed_radius - innermost.r - MODELCARD_INNER_RADIUS < 1.5, `sector ${index} starts at the rim`);
    // No smaller bubble sits closer to the centre than a larger one's centre.
    const largestCentre = Math.min(...tiles.filter((tile) => tile.r === largest).map((tile) => tile.packed_radius));
    for (const tile of tiles.filter((t) => t.r < largest)) {
      assert.ok(tile.packed_radius >= largestCentre - 0.01, `sector ${index}: a smaller bubble at ${tile.packed_radius.toFixed(1)} inside ${largestCentre.toFixed(1)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// R2: chapter labels

test('every chapter has a deliberate short name: plain words, no ellipsis, and its full name kept for hover, focus, and screen readers', () => {
  const regions = levelOne(ATLAS_LAYOUT_MODES[0]).regions;
  assert.equal(regions.length, 21);
  for (const region of regions) {
    assert.ok(region.short_label, `chapter ${region.chapter_no} has a short name`);
    assert.doesNotMatch(region.short_label, /…|\.\.\./, `${region.short_label} is not shortened with an ellipsis`);
    assert.ok(region.short_label.split(' ').length <= 3, `${region.short_label} is one to three words`);
    assert.ok(region.label_full.length > region.short_label.length || region.label_full === region.short_label);
    assert.doesNotMatch(region.label_full, /^\d/, 'the full name drops its leading chapter number');
  }
  assert.equal(chapterShortLabel({ chapter_no: '15' }), 'Bone & joint');
  assert.equal(chapterShortLabel({ chapter_no: '16' }), 'Urogenital');
  assert.equal(chapterShortLabel({ chapter_no: '17' }), 'Sexual health');
});

test('the label width estimate never underestimates a chapter name as Chrome draws it at 13 px', () => {
  for (const [text, measured] of Object.entries(MEASURED_EM)) {
    const estimate = labelEm(text);
    assert.ok(estimate >= measured, `${text}: estimate ${estimate.toFixed(3)} em ≥ measured ${measured} em`);
    assert.ok(estimate <= measured * 1.09, `${text}: estimate within 9% of the measured width`);
  }
});

for (const [viewport, scale] of Object.entries(RING_SCALE)) {
  test(`at ${viewport} every chapter label renders at ≥ 13 px, fits its arc, and overlaps neither a neighbour nor a badge`, () => {
    for (const layoutMode of ATLAS_LAYOUT_MODES) {
      const regions = levelOne(layoutMode).regions;
      const plans = regions.map((region) => ({ region, plan: planChapterLabel(region, scale) }));
      for (const { region, plan } of plans) {
        assert.ok(plan.px >= LABEL_MIN_PX, `${region.short_label} renders at ${plan.px.toFixed(2)} px`);
        assert.ok(plan.fitsFloor);
        assert.equal(plan.lines.map((line) => line.text).join(' '), region.short_label, 'the whole name is drawn');
        for (const line of plan.lines) {
          assert.doesNotMatch(line.text, /…/);
          // Inside its own sector, clear of the padding at both ends.
          assert.ok(line.start >= region.startAngle + ATLAS_LABEL_PAD - 1e-9, `${line.text} starts inside its sector`);
          assert.ok(line.end <= region.endAngle - ATLAS_LABEL_PAD + 1e-9, `${line.text} ends inside its sector`);
          // Radially: outside the chapter badges (radius ≤ 427), inside the viewBox (480).
          assert.ok(line.radius - plan.font / 2 >= 428, `${line.text} clears the badges`);
          assert.ok(line.radius + plan.font / 2 <= 480, `${line.text} stays inside the ring's frame`);
        }
      }
      // Neighbours (and the last and first chapter) never overlap.
      for (let index = 0; index < plans.length; index += 1) {
        const current = plans[index].plan.lines;
        const next = plans[(index + 1) % plans.length].plan.lines;
        const end = Math.max(...current.map((line) => line.end));
        const start = Math.min(...next.map((line) => line.start)) + (index === plans.length - 1 ? Math.PI * 2 : 0);
        assert.ok(end < start, `${plans[index].region.short_label} and ${plans[(index + 1) % plans.length].region.short_label} do not overlap`);
      }
      // Two lines of one label do not touch each other.
      for (const { plan } of plans.filter(({ plan }) => plan.lines.length === 2)) {
        const [a, b] = plan.lines;
        assert.ok(Math.abs(a.radius - b.radius) >= plan.font, 'two lines are a line apart');
      }
    }
  });
}

test('a label reads in order on both halves of the ring, with its first line on top', () => {
  const upper = planChapterLabel({ short_label: 'Sexual health', startAngle: 4.79, endAngle: 5.09 }, 0.6458);
  assert.equal(upper.reversed, false);
  assert.deepEqual(upper.lines.map((line) => line.text), ['Sexual', 'health']);
  assert.ok(upper.lines[0].radius > upper.lines[1].radius, 'on the upper half the first line is the outer one');
  assert.ok(upper.lines[0].baseline < upper.lines[0].radius, 'its ink sits outward of its baseline');
  const lower = planChapterLabel({ short_label: 'Sexual health', startAngle: Math.PI - 0.15, endAngle: Math.PI + 0.15 }, 0.6458);
  assert.equal(lower.reversed, true);
  assert.ok(lower.lines[0].radius < lower.lines[1].radius, 'on the reversed lower half the first line is the inner one');
  assert.ok(lower.lines[0].baseline > lower.lines[0].radius);
  assert.equal(isReversedArc(0, 0.3), false);
});

test('a large ring keeps the design size; a phone-size ring shrinks a label to its arc instead of cutting it', () => {
  const region = { short_label: 'Respiratory', startAngle: 0, endAngle: (Math.PI * 2) / 21 };
  const large = planChapterLabel(region, 1);
  assert.equal(large.font, 17);
  assert.equal(large.lines.length, 1);
  const before = planChapterLabel(region, null);
  assert.equal(before.font, 17, 'before the ring is measured, the design size');
  const phone = planChapterLabel(region, 0.35);
  assert.equal(phone.lines[0].text, 'Respiratory');
  assert.ok(phone.px < LABEL_MIN_PX && !phone.fitsFloor, 'below the floor only where nothing else fits');
  assert.ok(labelEm('Respiratory') * phone.font <= ((Math.PI * 2) / 21 - 2 * ATLAS_LABEL_PAD) * ATLAS_LABEL_RADIUS + 1e-9);
});

test('on a ring too small for the floor all chapter labels share one size, so the rim never mixes sizes', () => {
  const regions = levelOne(ATLAS_LAYOUT_MODES[0]).regions;
  for (const [viewport, scale] of Object.entries(SMALL_SCALE)) {
    const plans = [...planChapterLabels(regions, scale).values()];
    assert.equal(new Set(plans.map((plan) => plan.font)).size, 1, `${viewport}: one size`);
    assert.ok(plans[0].px < LABEL_MIN_PX, `${viewport} is below the floor`);
  }
  // At 1280×680 the shared size stays close to the floor (two-line names keep their size).
  assert.ok([...planChapterLabels(regions, SMALL_SCALE['1280×680']).values()][0].px >= 12.5);
  const small = [...planChapterLabels(regions, 0.23).values()];
  assert.equal(new Set(small.map((plan) => plan.font)).size, 1, 'one size');
  for (const plan of small) {
    for (const line of plan.lines) {
      assert.ok(labelEm(line.text) * plan.font <= (line.end - line.start) * line.radius + 1e-6);
    }
  }
  const desktop = [...planChapterLabels(regions, RING_SCALE['1280×800']).values()];
  assert.ok(desktop.every((plan) => plan.fitsFloor));
});

test('the scale is quantized down in 0.005 steps, so a resize re-plans labels rarely and never below the floor', () => {
  assert.equal(quantizeScale(0.6458), 0.645);
  assert.equal(quantizeScale(0.7708), 0.77);
  assert.equal(quantizeScale(0), null);
  assert.equal(quantizeScale(Number.NaN), null);
  // The frame measures its own svg; the bubbles' view no longer re-renders on resize.
  assert.match(read('features/atlas/RingFrame.jsx'), /quantizeScale\(\(svg\.clientWidth \|\| svg\.getBoundingClientRect\(\)\.width\)/);
  assert.doesNotMatch(read('features/atlas/RingView.jsx'), /ResizeObserver|setPxPerUnit/);
});

test('only the rim opens a chapter: the wedge with the bubbles takes no clicks, so clicks between bubbles clear the selection', () => {
  const css = read('styles/ring.css');
  assert.match(css, /\.ring-chapters\.is-interactive \.ring-sector \{\s*pointer-events: none;/);
  assert.match(css, /\.ring-chapter-hit \{[^}]*pointer-events: all;/);
  assert.doesNotMatch(css, /\.ring-chapters\.is-interactive \.ring-chapter \{\s*cursor: pointer/, 'no pointer cursor over the whole wedge');
  const frame = read('features/atlas/RingFrame.jsx');
  assert.match(frame, /className="ring-chapter-hit"\s+d=\{sectorPath\(\{ \.\.\.region, innerRadius: region\.outerRadius, outerRadius: LABEL_HIT_OUTER \}/);
});

test('a keyboard open focuses only the chapter it asked for, and the request does not outlive a return to the atlas', () => {
  const pane = read('features/atlas/RingPane.jsx');
  assert.match(pane, /focusChapter\.current = how === 'keyboard' \? chapterId : null;/);
  assert.match(pane, /if \(ringChapterId === requested\)/);
  assert.match(pane, /if \(isAtlasLevel\) \{\s*focusChapter\.current = null;/);
});

test('chapter keys rove like the bubbles: arrows step around the ring and wrap, Home and End jump', () => {
  const ids = ['CH-01', 'CH-02', 'CH-03'];
  assert.equal(nextChapterId(ids, 'CH-01', 'ArrowRight'), 'CH-02');
  assert.equal(nextChapterId(ids, 'CH-01', 'ArrowDown'), 'CH-02');
  assert.equal(nextChapterId(ids, 'CH-01', 'ArrowLeft'), 'CH-03');
  assert.equal(nextChapterId(ids, 'CH-03', 'ArrowRight'), 'CH-01');
  assert.equal(nextChapterId(ids, 'CH-02', 'ArrowUp'), 'CH-01');
  assert.equal(nextChapterId(ids, 'CH-02', 'Home'), 'CH-01');
  assert.equal(nextChapterId(ids, 'CH-02', 'End'), 'CH-03');
  assert.equal(nextChapterId(ids, 'CH-02', 'Enter'), null);
  assert.equal(nextChapterId(ids, null, 'ArrowRight'), 'CH-01');
  assert.equal(nextChapterId([], 'CH-01', 'ArrowRight'), null);
});

test('each chapter is one target with one roving tab stop, named by its full name; the label text is hidden from screen readers', () => {
  const frame = read('features/atlas/RingFrame.jsx');
  assert.match(frame, /role=\{isInteractive \? 'button' : undefined\}/);
  assert.match(frame, /tabIndex=\{isInteractive \? \(region\.concept_id === tabStopId \? 0 : -1\) : undefined\}/);
  assert.match(frame, /aria-label=\{isInteractive \? region\.label_full : undefined\}/);
  assert.match(frame, /className="ring-chapter-label"\s+aria-hidden="true"/);
  assert.match(frame, /onOpenChapter\(currentId, 'keyboard'\)/);
  const view = read('features/atlas/RingView.jsx');
  assert.match(view, /closest\?\.\('\[data-chapter-id\]'\)/, 'a click on a sector or label opens its chapter');
  assert.match(view, /onOpenChapter\(chapterId, 'pointer'\)/);
  const app = read('app/AtlasApp.jsx');
  assert.match(app, /onOpenChapter: isMultimorbidityMode \? null : openChapter/, 'Multimorbidity stays on the atlas');
});

// ---------------------------------------------------------------------------
// The legend tile: the counts by mark left the ring's centre for their own
// tile; the centre holds no text and no data, so nothing in it can overflow.

test('the counts by mark live in the legend tile, and the small centre holds no text and no data', () => {
  const legend = read('features/atlas/RingLegend.jsx');
  assert.match(legend, /<section className="legend-tile" aria-labelledby="legend-title">/);
  assert.match(legend, /<h2 id="legend-title" className="legend-title">\s*Legend\s*<\/h2>\s*\{help\}/);
  assert.match(legend, /<ul className="legend-list" aria-label=/);
  assert.match(legend, /is-zero/, 'zero rows stay, dimmed');
  const css = read('styles/ring.css');
  assert.match(css, /\.legend-count \{[^}]*font-variant-numeric: tabular-nums;[^}]*text-align: right;/);
  // Nothing is drawn in the ring's centre: no centre box, no centre styles.
  assert.doesNotMatch(read('features/atlas/RingView.jsx'), /ring-centre|props\.centre|\bcentre\b,/);
  assert.doesNotMatch(css, /\.ring-centre|\.centre-message/);
  const app = read('app/AtlasApp.jsx');
  assert.doesNotMatch(app, /CentreMessage|RingCentre|2,400 conditions|CentreCounts/);
  // Loading, Opening, and Updating show as the ring tile's status chip instead.
  assert.match(app, /\? 'Loading'/);
  assert.match(app, /\? 'Opening'/);
  assert.match(app, /\? 'Updating'/);
  assert.match(read('features/atlas/RingPane.jsx'), /<span className="ring-updating" role="status">[\s\S]*\{header\.status\}/);
});

test('in a chapter the key says subtypes are drawn with their condition’s result', () => {
  const conceptsById = {
    A: { level: 2, depth_in_kind: 1 },
    B: { level: 2, depth_in_kind: 1 },
    A1: { level: 2, depth_in_kind: 2 },
    A2: { level: 2, depth_in_kind: 3 }
  };
  const tiles = ['A', 'B', 'A1', 'A2'].map((id) => ({ id: `t-${id}`, concept_id: id })).concat([{ id: 'empty', isEmpty: true }]);
  assert.deepEqual(drawnBubbles(tiles, conceptsById), { total: 4, subchapters: 0, conditions: 2, subtypes: 2 });
  const subchapters = levelOne(ATLAS_LAYOUT_MODES[0]);
  const blockCount = Object.values(structure.blocksByChapterId).flat().length;
  assert.deepEqual(drawnBubbles(subchapters.tiles, structure.conceptsById), { total: blockCount, subchapters: blockCount, conditions: 0, subtypes: 0 });
  // The chapter legend counts conditions, like the atlas legend.
  assert.match(read('features/summary/useRingSummary.js'), /centre: \{ counts, total, caption: 'conditions' \}/);
  assert.match(read('features/atlas/RingLegend.jsx'), /Subtypes share their condition’s result\./);
});

test('after a search jump the selected bubble wears a thin white gap and a 2 px blue ring, and a ring pings out from it', () => {
  const css = read('styles/ring.css');
  assert.match(css, /\.bubble-halo \{[^}]*stroke: var\(--accent\);[^}]*stroke-width: 2;/);
  assert.match(css, /\.bubble-halo-gap \{[^}]*stroke: var\(--card\);/);
  assert.match(css, /\.bubble-halo-ping \{[^}]*animation: halo-ping/);
  assert.match(read('features/atlas/RingView.jsx'), /className="bubble-halo-ping"/);
});

// ---------------------------------------------------------------------------
// M1: discard from the Check step

test('an update being checked or needing a fix can be discarded from the Check step', () => {
  const check = read('features/admin/CheckStep.jsx');
  assert.match(check, /import \{ DiscardUpdate \} from '\.\/PublishSteps\.jsx'/);
  // One control at a fixed place, kept per upload, so a check finishing does not remount it.
  assert.equal((check.match(/<CheckDiscard /g) ?? []).length, 1);
  assert.match(check, /<CheckDiscard key=\{upload\.upload_id\}/);
  assert.match(check, /checking: 'Wrong file\?/);
  assert.match(check, /form: 'Not fixing it now\? Discard what you entered/);
  assert.match(check, /invalid: 'Not fixing it now\? Discard this file/);
  assert.match(check, /if \(upload\.status !== 'valid'\) \{\s*return null;/, 'an unknown status never reads as a clean check');
  const publish = read('features/admin/PublishSteps.jsx');
  assert.match(publish, /<DiscardUpdate upload=\{upload\} session=\{session\} \/>/, 'a clean update is discarded in Publish, the same way');
  // The confirm button stays focusable while the request runs, so a failure keeps the focus on it.
  const control = publish.slice(publish.indexOf('export function DiscardUpdate'), publish.indexOf('export function PublishStep'));
  assert.match(control, /aria-disabled=\{isBusy \|\| undefined\}/);
  assert.doesNotMatch(control, /\sdisabled=/);
  assert.match(control, /const isBusy = Boolean\(session\.busy\);/, 'held while a fixed file uploads too');
  assert.match(control, /\{attempted && session\.problem && !isBusy \?/, 'the failure line only follows a discard tried here');
});

test('after a discard a status line says the live data did not change, and the focus moves to step 2', () => {
  const page = read('features/admin/DatasetPage.jsx');
  assert.match(page, /<div className="discard-status" role="status">/);
  assert.match(page, /The live data did not change/);
  assert.match(page, /listRef\.current\?\.children\[1\]\?\.querySelector\('\.step-header'\)\?\.focus/);
  const hook = read('features/admin/useStagedUpload.js');
  const discard = hook.slice(hook.indexOf('const discard = useCallback'), hook.indexOf('const publish = useCallback'));
  assert.match(discard, /setDiscarded\(\{ token: Date\.now\(\), upload: gone \}\);\s+library\.current\?\.\(\);/, 'the library reloads, so the waiting badge clears');
  assert.match(discard, /await client\.discardUpload\(\{ uploadId \}\);\s+removed\(\);\s+return true;/);
  assert.match(discard, /return false;/, 'any other failure keeps the update and its problem');
  assert.match(discard, /if \(!uploadId \|\| busy\) return false;/);
  assert.match(discard, /setUpload\(\(current\) => \(current\?\.upload_id === uploadId \? null : current\)\);/, 'an upload staged meanwhile stays');
  const poll = hook.slice(hook.indexOf('// Follow the check while it runs.'), hook.indexOf('// The change summary'));
  assert.match(poll, /discardingId\.current === uploadId/, 'a poll during a discard is ignored');
  assert.match(poll, /GONE_STATUSES\.has\(next\.status\)/);
  assert.match(hook, /const GONE_STATUSES = new Set\(\['published', 'discarded', 'superseded'\]\);/);
  const rollback = hook.slice(hook.indexOf('const rollback = useCallback'));
  assert.match(rollback, /setDiscarded\(null\);/);
});

// ---------------------------------------------------------------------------
// Polish

test('a metric without a value names its absence once: the header, then its meaning, without a figure word or absence row', () => {
  const row = {
    perf: 0.91,
    ci_low: 0.85,
    ci_high: 0.97,
    evidence_grade: null,
    evidence_signal: null,
    overall: { tier: 'no_evidence_data', score: null, grade: null },
    status: { overall: 'not_validated', performance: 'strong', evidence: 'no_data' }, // a served not_validated reads No data (D5)
    intended_use_level: 'in_scope',
    intended_use_coverage: 1
  };
  const sections = Object.fromEntries(metricSections(row, { depth: 'plain' }).map((section) => [section.viewId, section]));
  assert.equal(sections.performance.isAbsent, false);
  assert.equal(sections.intended_use.isAbsent, false);
  for (const id of ['overall', 'evidence']) {
    assert.equal(sections[id].status, 'no_data');
    assert.equal(sections[id].isAbsent, true, `${id} is absent`);
  }
  const outOfScope = metricSections({ ...row, intended_use_level: 'out_of_scope', intended_use_coverage: null }, {}).find((section) => section.viewId === 'intended_use');
  assert.equal(outOfScope.status, 'out_of_scope');
  assert.equal(outOfScope.isAbsent, true, 'Intended use Out of scope without coverage is named once too');
  const weakNoSignal = metricSections({ ...row, evidence_grade: 'D', status: { ...row.status, evidence: 'weak' } }, {}).find((section) => section.viewId === 'evidence');
  assert.equal(weakNoSignal.isAbsent, false, 'a result status without a value keeps its filled zone');
  const markup = read('features/details/ResultSections.jsx');
  assert.match(markup, /\{isAbsent \? null : \(/);
});

test('the function reads in its display wording in the multimorbidity fallback list and the live panel header', () => {
  assert.match(read('features/multimorbidity/CombinationPanel.jsx'), /\{displayUseCase\(alternative\.useCase\)\}/);
  const inputs = readPanelInputs((name) => ({ model: 'SynGPT-2.0', 'use-case': 'Clinician Facing CDSS', codes: '5A11' })[name] ?? null);
  const text = textOf(renderPanel({ phase: 'loading', inputs }));
  assert.match(text, /Clinician-Facing CDSS/);
  assert.doesNotMatch(text, /Clinician Facing CDSS/);
});
