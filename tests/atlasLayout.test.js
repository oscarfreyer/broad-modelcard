// E9 and E13: the ring's size never depends on the view, and "Your defaults"
// lays out in one column at every width. Source checks of the CSS rules that
// carry them; the browser measurements are in the log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { legendKeys, legendMeaning } from '../frontend/src/features/atlas/legendEntries.js';
import { MODELCARD_INNER_RADIUS } from '../frontend/src/features/atlas/layout/atlasGeometry.js';

const read = (relative) => readFileSync(new URL(`../frontend/src/${relative}`, import.meta.url), 'utf8');
const block = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} exists`);
  return css.slice(start, css.indexOf('}', start));
};

test('the ring never shares its space with something whose height changes with the view (E9)', () => {
  const ring = read('styles/ring.css');
  const responsive = read('styles/responsive.css');
  // The legend is its own tile left of the ring tile in a fixed-width column
  //, placed by the window's width alone: no
  // container query on the pane's shape.
  assert.match(block(ring, '.ring-column'), /grid-template-columns: var\(--legend-width\) minmax\(0, 1fr\);[\s\S]*--legend-width: 13rem;/);
  assert.match(block(ring, '.ring-column > .legend-tile'), /grid-column: 1;/);
  assert.match(block(ring, '.ring-column > .ring-pane'), /grid-column: 2;/);
  assert.doesNotMatch(ring, /@container ring-pane|\.ring-key/);
  assert.doesNotMatch(responsive, /\.ring-key|centre-list/);
  // The legend tile: top-aligned at one height for every view, never taller than the ring tile.
  const tile = block(ring, '\n.legend-tile');
  assert.match(tile, /align-self: start;/);
  assert.match(tile, /height: auto;/);
  assert.match(tile, /max-height: 100%;/);
  // The results sheet under the ring (tablets in portrait) and on phones has a fixed height, not a content height.
  const portrait = responsive.slice(responsive.indexOf('@media (max-width: 959px)'), responsive.indexOf('@media (max-width: 767px)'));
  assert.match(block(portrait, '  .side-column'), /height: 34dvh;/);
  assert.doesNotMatch(block(portrait, '  .side-column'), /max-height/);
  const phone = responsive.slice(responsive.indexOf('@media (max-width: 767px)'));
  // A peek below the ring at 375×812 (audit B12).
  assert.match(block(phone, '  .side-column'), /height: max\(19dvh, 132px\);/);
  // On a phone the legend sits under the ring at its content's height and never scrolls inside the page.
  assert.match(block(phone, '  .ring-column'), /grid-template-columns: minmax\(0, 1fr\);\s*grid-template-rows: auto auto;/);
  assert.match(block(phone, '  .legend-tile'), /height: auto;\s*max-height: none;/);
  assert.match(block(phone, '  .legend-body'), /overflow: visible;/);
  // A legend that scrolls (a very short window) never clips silently: scroll shadows at its edges.
  const legendBody = block(ring, '.legend-body');
  assert.match(legendBody, /overflow-y: auto;/);
  assert.match(legendBody, /no-repeat local/);
  assert.match(legendBody, /farthest-side at 50% 100%[^;]*no-repeat scroll;/);
  // The legend is a sibling of the ring tile, never inside it; the ring comes first in reading order.
  const pane = read('features/atlas/RingPane.jsx');
  assert.ok(pane.indexOf('</main>') < pane.indexOf('<RingLegend'), 'the legend follows the ring tile');
  // On a phone it sits under the ring again.
  assert.match(block(phone, '  .ring-column > .ring-pane,\n  .ring-column > .legend-tile'), /grid-column: 1;\s*grid-row: auto;/);
  // No description line under the Summary title, which changed with the view.
  assert.doesNotMatch(read('features/summary/SummaryPanel.jsx'), /\{intro\}|props\.intro/);
});

test('one legend placement from 768px: below 1100px the results narrow instead of becoming a sheet, which would shrink the ring', () => {
  const responsive = read('styles/responsive.css');
  const compact = responsive.slice(responsive.indexOf('@media (max-width: 1099px)'), responsive.indexOf('@media (max-width: 959px)'));
  // 1024×768: ring 400 px beside the legend and a 320 px results column (314 px above a bottom sheet before).
  assert.match(compact, /--side-width: 320px;/);
  assert.doesNotMatch(compact, /\.side-column \{|\.sheet-grabber \{/, 'no bottom sheet from 960px');
  assert.doesNotMatch(compact, /\.ring-column \{|\.legend-tile \{/, 'the legend keeps its placement');
  const portrait = responsive.slice(responsive.indexOf('@media (max-width: 959px)'), responsive.indexOf('@media (max-width: 767px)'));
  assert.match(portrait, /\.sheet-grabber \{/);
  assert.doesNotMatch(portrait, /\.ring-column \{|\.legend-tile \{/, 'the legend keeps its placement');
  // The ring's centre is a small hole with nothing in it, the same in the atlas and a chapter.
  assert.equal(MODELCARD_INNER_RADIUS, 100);
  assert.doesNotMatch(read('features/atlas/RingView.jsx'), /ring-centre/);
});

test('the legend lists every mark a view can draw, in key order; what an absence or Safety mark means is in its help', () => {
  assert.deepEqual(legendKeys({ viewId: 'overall' }), ['serious', 'caution', 'strong', 'moderate', 'weak', 'out_of_scope', 'no_data']);
  assert.deepEqual(legendKeys({ viewId: 'overall', hasIntendedUse: false }), ['serious', 'caution', 'strong', 'moderate', 'weak', 'no_data']);
  assert.deepEqual(legendKeys({ viewId: 'performance' }), ['strong', 'moderate', 'weak', 'no_data']);
  assert.deepEqual(legendKeys({ viewId: 'evidence' }), ['strong', 'moderate', 'weak', 'no_data']);
  assert.deepEqual(legendKeys({ viewId: 'safety' }), ['serious', 'caution', 'no_incidents']);
  // The keys depend on the view only, never on what is drawn: zero rows stay, so the list never changes length.
  assert.deepEqual(legendKeys({ viewId: 'performance', absences: ['no_data'] }), legendKeys({ viewId: 'performance' }));
  // An absence drawn that the view does not list follows; Loading never gets a row.
  assert.deepEqual(legendKeys({ viewId: 'performance', absences: ['out_of_scope', 'loading'] }), ['strong', 'moderate', 'weak', 'no_data', 'out_of_scope']);
  for (const key of ['strong', 'moderate', 'weak', 'in_scope', 'partially_in_scope']) {
    assert.equal(legendMeaning(key), null, `${key} needs no meaning`);
  }
  // One short line each (16rem tile, Caption type: about 34 characters).
  for (const key of ['serious', 'caution', 'no_incidents', 'out_of_scope', 'no_data', 'no_combination']) {
    const meaning = legendMeaning(key);
    assert.ok(meaning && meaning.length <= 34, `${key}: "${meaning}"`);
  }
  // Its help says an incident shows instead of the result; the synthetic-data
  // notice is the header's badge, not a legend line.
  const legend = read('features/atlas/RingLegend.jsx');
  assert.doesNotMatch(legend, /All data is synthetic/);
  assert.match(legend, /Incidents show instead of the result\./);
  assert.doesNotMatch(legend, /Bubble: a subchapter/);
});

test('"Your defaults" has its own one-column sheet, not the model card dialog layout (E13)', () => {
  const sheet = read('features/profile/DefaultsSheet.jsx');
  assert.doesNotMatch(sheet, /label-dialog|styles\/label\.css/);
  assert.match(sheet, /className="defaults-sheet"/);
  const css = read('styles/profile.css');
  assert.match(block(css, '.defaults-body'), /grid-template-columns: minmax\(0, 1fr\);/);
  assert.doesNotMatch(css, /@media \(min-width: 1100px\)/, 'no desktop two-column layout');
});
