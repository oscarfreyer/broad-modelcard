// The atlas tab title names the card and keeps atlas.html's "Atlas – Broad
// Modelcard" ending (S8b).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ATLAS_TITLE_BASE, atlasTitle } from '../frontend/src/app/atlasTitle.js';

test('the atlas title names the AI system and function before the page name', () => {
  assert.equal(
    atlasTitle({ system: 'SynGPT-2.0', fn: 'Clinician-Facing CDSS' }),
    'SynGPT-2.0 – Clinician-Facing CDSS – Atlas – Broad Modelcard'
  );
});

test('a preview says so first', () => {
  assert.equal(
    atlasTitle({ system: 'SynGPT-2.0', fn: 'Clinician-Facing CDSS', isPreview: true }),
    'Preview, not live – SynGPT-2.0 – Clinician-Facing CDSS – Atlas – Broad Modelcard'
  );
});

test('missing parts are left out, never printed as undefined', () => {
  assert.equal(atlasTitle(), ATLAS_TITLE_BASE);
  assert.equal(atlasTitle({ system: null, fn: 'Triage' }), ATLAS_TITLE_BASE);
  assert.equal(atlasTitle({ system: 'MediCore-2.5', fn: '' }), 'MediCore-2.5 – Atlas – Broad Modelcard');
  assert.equal(atlasTitle({ isPreview: true }), 'Preview, not live – Atlas – Broad Modelcard');
});

test('atlas.html starts with the same title the runtime keeps as its ending', () => {
  const html = readFileSync(new URL('../frontend/atlas.html', import.meta.url), 'utf8');
  assert.match(html, new RegExp(`<title>${ATLAS_TITLE_BASE}</title>`));
});

test('plain depth shows ICD-11 codes for conditions only, not internal block ids', async () => {
  const { conceptCode } = await import('../frontend/src/shared/conceptName.js');
  const block = { level: 1, concept_id: 'BLK-01-BlockL1-1G4', icd11_code: 'BlockL1-1G4' };
  assert.equal(conceptCode({ level: 2, concept_id: 'BA00', icd11_code: 'BA00' }), 'BA00');
  assert.equal(conceptCode(block), null);
  assert.equal(conceptCode(block, { isExpert: true }), null, 'no raw block id at expert depth (audit A29)');
  assert.equal(conceptCode({ level: 0, concept_id: 'CH-06', chapter_no: '06' }, { isExpert: true }), 'Chapter 06');
  assert.equal(conceptCode(null), null);
});

test('scores round down at two decimals, so a figure never crosses its band edge (S8)', async () => {
  const { formatScore } = await import('../frontend/src/design/rangeScale.js');
  assert.equal(formatScore(0.757), '0.75');
  assert.equal(formatScore(0.76), '0.76');
  assert.equal(formatScore(0.7649), '0.76');
  assert.equal(formatScore(0.64), '0.64');
  assert.equal(formatScore(1), '1.00');
});
