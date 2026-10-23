// Release 0.5 code review (fix/review-0.5): regression tests for the
// frontend and script fixes that no other test file covers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaticAdapter } from '../frontend/src/api/staticAdapter.js';
import { filterOptions, tabTiles, visibleTiles } from '../frontend/src/features/catalogue/catalogueModel.js';
import { cdsCodes } from '../frontend/src/features/plugin/cdsHooks.js';
import { audienceSummary, sharesText } from '../frontend/src/features/summary/audienceModel.js';
import { parseCodes } from '../frontend/src/embed/panelInputs.js';
import { parseArgs } from '../scripts/static/record.mjs';

test('the CDS Hooks mode takes up to the service’s 12 codes in ICD-11 too; the live panel keeps 8', () => {
  const codes = Array.from({ length: 14 }, (_, index) => `5A${String(index).padStart(2, '0')}`).join(', ');
  assert.equal(cdsCodes(codes, 'icd11').codes.length, 12);
  assert.equal(cdsCodes(codes, 'icd11').ignored, 2);
  assert.equal(parseCodes(codes).codes.length, 8);
  assert.deepEqual(cdsCodes('E11.9 e11.9 5A11', 'icd10cm'), { codes: ['E11.9'], ignored: 1 });
});

test('the static demo refuses a query over 200 characters as the API does', async () => {
  const adapter = createStaticAdapter({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const long = 'a'.repeat(201);
  await assert.rejects(adapter.interpretQuery({ q: long }), { status: 422, code: 'invalid_query' });
  await assert.rejects(adapter.searchConcepts({ q: long }), { status: 422, code: 'invalid_query' });
  await assert.rejects(adapter.searchConcepts({ q: 'asthma', limit: 0 }), { status: 422, code: 'invalid_limit' });
});

test('the catalogue’s facet counts leave out replaced versions while Newest versions only is on', () => {
  const tile = (id, system, extra = {}) => ({ card_id: id, model_version: id, use_case: 'Triage', system: { developer: system, ...extra } });
  const tiles = [tile('Old-1', 'Acme', { replaced_by: ['New-2'] }), tile('New-2', 'Acme')];
  assert.equal(tabTiles(tiles, { tab: 'all' }).length, 2);
  assert.deepEqual(tabTiles(tiles, { tab: 'all', newest: true }).map((entry) => entry.card_id), ['New-2']);
  const developerCount = (newest) => filterOptions(tabTiles(tiles, { tab: 'all', newest }), null).developer.find((entry) => entry.value === 'Acme').count;
  assert.equal(developerCount(false), 2);
  assert.equal(developerCount(true), 1);
  assert.deepEqual(visibleTiles(tiles, { tab: 'all', filters: null, sort: 'name', newest: true }).map((entry) => entry.card_id), ['New-2']);
});

test('audience copy: a share under 0.5% reads <1%, and an open serious incident is serious for the regulator', () => {
  assert.equal(sharesText({ strong: 0.996, weak: 0.004 }), '100% strong, <1% weak');
  const incidents = {
    data: {
      incidents: [
        { incident_id: 'SI-2', status: 'open', severity: 'serious', reported_date: '2026-10-01' },
        { incident_id: 'SI-1', status: 'open', severity: 'caution', reported_date: '2026-09-01' }
      ]
    },
    error: null
  };
  const regulator = audienceSummary('regulator', { incidents, versions: { data: { versions: [] }, error: null } });
  assert.equal(regulator.lines.find((line) => line.id === 'incidents-now').tone, 'serious');
  const mild = { data: { incidents: [{ incident_id: 'SI-1', status: 'open', severity: 'caution', reported_date: '2026-09-01' }] }, error: null };
  assert.equal(audienceSummary('regulator', { incidents: mild, versions: { data: { versions: [] }, error: null } }).lines.find((line) => line.id === 'incidents-now').tone, 'caution');
});

test('the recorder refuses a port or concurrency that is not a positive whole number', () => {
  assert.throws(() => parseArgs(['--concurrency', '0'], {}), /--concurrency/);
  assert.throws(() => parseArgs(['--concurrency', 'many'], {}), /--concurrency/);
  assert.throws(() => parseArgs(['--port', 'x'], {}), /--port/);
  assert.equal(parseArgs(['--concurrency', '4'], {}).concurrency, 4);
});
