// Audit batch 3 (2026-10-14): source-level checks for the fixes that have no
// pure function of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deriveHighlights, groupStatusCounts } from '../frontend/src/features/summary/summaryHighlights.js';

const SRC = fileURLToPath(new URL('../frontend/src/', import.meta.url));
const read = (relative) => readFileSync(`${SRC}${relative}`, 'utf8');

test('safeguards carry no priority word on the live panel or in the PDF, as on the condition card (A28)', () => {
  const panel = read('embed/panelView.js');
  assert.doesNotMatch(panel, /PRIORITY_TONE|safeguard\.priority/);
  const pdf = read('features/details/conceptCardExport.js');
  assert.doesNotMatch(pdf, /writeParagraph\(`\$\{safeguard\.priority\}/);
  assert.match(pdf, /writeParagraph\(safeguard\.title,/);
});

test('on a phone the AI system name has the toolbar\'s first row; the function and card actions the second (audit batch 3)', () => {
  const responsive = read('styles/responsive.css');
  const phone = responsive.slice(responsive.indexOf('@media (max-width: 767px)'));
  assert.match(phone, /'system system search'\s*'function actions actions'\s*'metric metric metric'/);
  assert.match(phone, /\.toolbar \.toolbar-title,\s*\.toolbar-actions \{\s*display: contents;/);
  const toolbar = read('styles/toolbar.css');
  assert.match(toolbar.slice(toolbar.lastIndexOf('@media (max-width: 767px)')), /\.toolbar \.toolbar-card-actions \{\s*grid-area: actions;/);
});

test('from 1100 to 1279px the toolbar keeps one row: no local name on the Population button (audit batch 3)', () => {
  const responsive = read('styles/responsive.css');
  assert.match(responsive, /@media \(min-width: 1100px\) and \(max-width: 1279px\) \{[\s\S]*?\.toolbar-button-local \{\s*display: none;/);
  const toolbar = read('styles/toolbar.css');
  assert.match(toolbar, /grid-template-columns: minmax\(0, max-content\) minmax\(0, 1fr\);/);
});

test('below 1280px the local population chip takes its own line and the mode its own row, at every level (audit batch 3)', () => {
  const responsive = read('styles/responsive.css');
  const below1280 = responsive.slice(responsive.indexOf('@media (max-width: 1279px)'));
  assert.match(below1280, /\.ring-pane-path:has\(\.ring-pane-chips\) \{\s*grid-template-areas:\s*'heading status'\s*'chips chips';/);
  assert.match(below1280, /\.ring-pane-chips \{[^}]*contain: inline-size;/);
  // The chips are grouped apart from the way back and the title; from 1280px the groups do not show.
  const pane = read('features/atlas/RingPane.jsx');
  assert.match(pane, /<span className="ring-pane-heading">[\s\S]*?<h2 className="ring-pane-title">/);
  assert.match(pane, /<span className="ring-pane-chips">[\s\S]*?preview-chip[\s\S]*?population-chip/);
  assert.match(read('styles/ring.css'), /\.ring-pane-heading,\s*\.ring-pane-chips \{\s*display: contents;/);
  const band = responsive.slice(responsive.indexOf('@media (min-width: 1100px) and (max-width: 1279px)'));
  assert.match(band.slice(0, band.indexOf('\n}\n')), /\.ring-pane-path \{\s*flex-basis: 100%;/);
});

test('the preview band keeps one row below 1100px; it stacks only on a tablet in portrait and a phone (audit batch 3)', () => {
  const preview = read('styles/preview.css');
  const narrow = preview.slice(preview.indexOf('@media (max-width: 1099px)'));
  assert.match(narrow, /^@media \(max-width: 1099px\) \{\s*\.preview-banner-text \{\s*flex: 1 1 0;\s*\}\s*\}/);
  assert.match(narrow, /@media \(max-width: 959px\) \{\s*\.preview-banner \{\s*flex-wrap: wrap;/);
  assert.match(narrow, /@media \(max-width: 767px\) \{\s*\.preview-banner-actions \{\s*width: 100%;/);
});

test('a narrow card counts "in scope" by the intended use underneath an incident mark (audit batch 3)', () => {
  // Skin: 3 strong in scope, one in-scope condition with a caution incident,
  // one out-of-scope condition with a serious incident; 5 out of scope elsewhere.
  const row = (fields) => ({ overall_status: 'strong', intended_use_level: 'in_scope', safety: null, ...fields });
  const outOfScope = (fields = {}) => row({ overall_status: 'out_of_scope', intended_use_level: 'out_of_scope', ...fields });
  const rowsById = new Map([
    ['S1', row({})],
    ['S2', row({})],
    ['S3', row({})],
    ['S4', row({ safety: 'caution' })],
    ['S5', outOfScope({ safety: 'serious' })],
    ...['O1', 'O2', 'O3', 'O4', 'O5'].map((id) => [id, outOfScope()])
  ]);
  const conceptsOf = (rows) => [...rows.keys()].map((id) => ({ concept_id: id, chapter_id: id.startsWith('S') ? 'CH-14' : 'CH-02' }));
  const labels = { 'CH-14': 'Skin', 'CH-02': 'Neoplasms' };
  const groups = groupStatusCounts(conceptsOf(rowsById), rowsById, 'overall', (concept) => concept.chapter_id, labels);
  const skin = groups.find((group) => group.id === 'CH-14');
  assert.deepEqual(skin.counts, { strong: 3, caution: 1, serious: 1 }, 'the counts stay what the ring draws');
  assert.deepEqual(skin.marked, { serious: { out_of_scope: 1 } });
  const counts = { serious: 1, caution: 1, strong: 3, moderate: 0, weak: 0, out_of_scope: 5, no_data: 0 };
  const [lead] = deriveHighlights({ viewId: 'overall', total: 10, counts, groups, hasIntendedUse: true });
  assert.equal(lead.title, 'In scope for 4 conditions, all in Skin');
  assert.match(
    lead.text,
    /^3 strong, 0 moderate, and 0 weak; 1 caution incident\. 6 out of scope \(60%\), 1 with an incident\./
  );
  assert.doesNotMatch(lead.text, /serious incident/, 'the serious mark is over an out-of-scope condition');

  // Out of scope underneath counts toward a narrow card too: 5 of 9 here, only 3 drawn grey.
  const fewer = new Map([...rowsById].filter(([id]) => !['O4', 'O5'].includes(id)));
  fewer.set('S6', outOfScope({ safety: 'caution' }));
  fewer.set('S7', row({}));
  const fewerGroups = groupStatusCounts(conceptsOf(fewer), fewer, 'overall', (concept) => concept.chapter_id, labels);
  const fewerCounts = { serious: 1, caution: 2, strong: 4, moderate: 0, weak: 0, out_of_scope: 3, no_data: 0 };
  const [narrow] = deriveHighlights({ viewId: 'overall', total: 10, counts: fewerCounts, groups: fewerGroups, hasIntendedUse: true });
  assert.equal(narrow.title, 'In scope for 5 conditions, all in Skin');
});
