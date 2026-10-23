// Search results show their mark as the ring draws it (audit batch 3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { markConceptId, searchResultStatus } from '../frontend/src/features/search/searchMarks.js';

const SRC = fileURLToPath(new URL('../frontend/src/', import.meta.url));

const row = (fields) => ({
  overall_status: 'no_data',
  performance_status: 'no_data',
  evidence_status: 'no_data',
  intended_use_level: null,
  safety: null,
  child_count: null,
  ...fields
});

const atlasRows = new Map([
  ['5A11', row({ overall_status: 'strong', performance_status: 'strong', intended_use_level: 'in_scope', safety: 'caution' })],
  ['5A61', row({ overall_status: 'weak', performance_status: 'moderate', intended_use_level: 'partially_in_scope' })],
  ['1C11', row({ overall_status: 'out_of_scope', intended_use_level: 'out_of_scope' })],
  ['BlockL1-5A0', row({ overall_status: 'moderate' })],
  ['BlockL1-XX0', row({ overall_status: 'out_of_scope', child_count: 0 })]
]);

const condition = { concept_id: '5A11', level: 2, chapter_id: 'CH-05', depth_in_kind: 1, metric_anchor_id: '5A11' };
const subtype = { concept_id: '5A61.5', level: 2, chapter_id: 'CH-05', depth_in_kind: 2, metric_anchor_id: '5A61' };
const block = { concept_id: 'BlockL1-5A0', level: 1, chapter_id: 'CH-05' };
const chapter = { concept_id: 'CH-05', level: 0, chapter_id: 'CH-05' };

test('a subtype is marked by its top-level condition; a chapter has no mark', () => {
  assert.equal(markConceptId(subtype), '5A61');
  assert.equal(markConceptId(condition), '5A11');
  assert.equal(markConceptId(block), 'BlockL1-5A0');
  assert.equal(markConceptId(chapter), null);
  assert.equal(searchResultStatus(chapter, { atlasRows }, 'overall'), null);
});

test('marks follow the view on screen, Overview with incident marks first', () => {
  assert.equal(searchResultStatus(condition, { atlasRows }, 'overall'), 'caution');
  assert.equal(searchResultStatus(condition, { atlasRows }, 'performance'), 'strong');
  assert.equal(searchResultStatus(condition, { atlasRows }, 'safety'), 'caution');
  assert.equal(searchResultStatus(condition, { atlasRows }, 'intended_use'), 'in_scope');
  assert.equal(searchResultStatus(subtype, { atlasRows }, 'overall'), 'weak');
  assert.equal(searchResultStatus(subtype, { atlasRows }, 'safety'), 'no_incidents');
  assert.equal(searchResultStatus(subtype, { atlasRows }, 'intended_use'), 'partially_in_scope');
  assert.equal(searchResultStatus(block, { atlasRows }, 'overall'), 'moderate');
});

test('a card without an intended-use statement shows nothing out of scope; a rollup without children reads No data', () => {
  const oos = { concept_id: '1C11', level: 2, chapter_id: 'CH-01', metric_anchor_id: '1C11' };
  assert.equal(searchResultStatus(oos, { atlasRows }, 'overall'), 'out_of_scope');
  assert.equal(searchResultStatus(oos, { atlasRows }, 'overall', { hasIntendedUse: false }), 'no_data');
  assert.equal(searchResultStatus({ concept_id: 'BlockL1-XX0', level: 1, chapter_id: 'CH-09' }, { atlasRows }, 'overall'), 'no_data');
  // A condition the atlas map does not hold has no row: No data, as on the ring.
  assert.equal(searchResultStatus({ concept_id: 'ZZ99', level: 2, chapter_id: 'CH-09', metric_anchor_id: 'ZZ99' }, { atlasRows }, 'overall'), 'no_data');
});

test('without the atlas map, the open chapter answers for its own results only; otherwise no mark rather than a wrong one', () => {
  const chapterRows = new Map([['5A61.5', row({ overall_status: 'moderate' })]]);
  assert.equal(searchResultStatus(subtype, { chapterRows, chapterId: 'CH-05' }, 'overall'), 'moderate');
  assert.equal(searchResultStatus({ ...subtype, chapter_id: 'CH-06' }, { chapterRows, chapterId: 'CH-05' }, 'overall'), null);
  assert.equal(searchResultStatus(subtype, { atlasRows: null }, 'overall'), null);
});

test('the palette draws the mark with its word, and reads no data per result', () => {
  const palette = readFileSync(`${SRC}features/search/SearchPalette.jsx`, 'utf8');
  assert.match(palette, /<StatusLabel status=\{status\} \/>/);
  const app = readFileSync(`${SRC}app/AtlasApp.jsx`, 'utf8');
  assert.match(app, /statusFor=\{searchStatusFor\}/);
  // One atlas map read while the palette is open in a chapter, none per result.
  assert.match(app, /useMetricMap\(filters, null, search\.isOpen && !isMultimorbidityMode && nav\.level === 1\)/);
  assert.doesNotMatch(readFileSync(`${SRC}features/search/searchMarks.js`, 'utf8'), /client|fetch/);
});
