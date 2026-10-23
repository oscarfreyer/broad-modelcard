// Atlas preview of a staged update: URL parameters, the staged-versus-live
// diff behind the changed-from-live halo, and the ended-preview copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { atlasHref, parseStartupParams } from '../frontend/src/app/startupParams.js';
import { decodeMetricMap } from '../frontend/src/features/atlas/decodeMetricMap.js';
import { adminHref, changedConceptIds, liveComparisonFilters, previewEndedReason, previewedPopulationId } from '../frontend/src/features/preview/previewModel.js';

test('startup parameters: a staged version, target, view, mode, and concept; junk is ignored', () => {
  const staged = parseStartupParams('?version=staged:up-abc_1&model=SynGPT-2.0&use_case=Clinician%20Facing%20CDSS&view=evidence&mode=multimorbidity&concept=5A11');
  assert.deepEqual(staged, {
    version: 'staged:up-abc_1',
    previewUploadId: 'up-abc_1',
    model: 'SynGPT-2.0',
    useCase: 'Clinician Facing CDSS',
    view: 'evidence',
    mode: 'multimorbidity',
    depth: null,
    lens: { age: null, sex: null, ethnicity: null },
    setting: null,
    population: null,
    ontology: null,
    chapterId: null,
    conceptId: '5A11',
    selectedIds: [],
    stateParams: ['version', 'view', 'mode', 'concept']
  });
  const junk = parseStartupParams('?version=staged:../../etc&view=colour&mode=admin&concept=%3Cscript%3E');
  assert.deepEqual([junk.version, junk.previewUploadId, junk.view, junk.mode, junk.conceptId], ['live', null, null, null, null]);
  assert.equal(parseStartupParams('').version, 'live');
});

test('atlas links round-trip through the startup parameters', () => {
  const href = atlasHref({ version: 'staged:u1', model: 'M', useCase: 'Use case', view: 'overall', conceptId: '5A11' });
  assert.equal(href, './atlas.html?version=staged%3Au1&model=M&use_case=Use+case&view=overall&concept=5A11');
  const parsed = parseStartupParams(href.slice('./atlas.html'.length));
  assert.equal(parsed.previewUploadId, 'u1');
  assert.equal(parsed.useCase, 'Use case');
  assert.equal(atlasHref({}), './atlas.html');
  assert.equal(atlasHref({ version: 'live', model: 'M' }), './atlas.html?model=M');
});

test('the preview diff finds added, removed, and changed rows, and nothing else', () => {
  const map = (rows) =>
    decodeMetricMap({ columns: ['concept_id', 'overall_status', 'perf', 'ci_low'], rows });
  const live = map([['A', 'strong', 0.9, 0.85], ['B', 'weak', 0.5, null], ['C', 'moderate', 0.75, 0.7]]);
  const staged = map([['A', 'strong', 0.9, 0.85], ['B', 'moderate', 0.72, null], ['D', 'weak', 0.4, 0.3]]);
  assert.deepEqual([...changedConceptIds(staged, live)].sort(), ['B', 'C', 'D']);
  assert.equal(changedConceptIds(live, live).size, 0);
  assert.equal(changedConceptIds(map([['A', 'strong', 0.9, 0.85]]), map([['A', 'strong', 0.9, 0.851]])).size, 1, 'a CI change counts');
});

test('an ended preview says why, and leads back to its data set and target', () => {
  assert.match(previewEndedReason({ status: 'published' }), /published/);
  assert.match(previewEndedReason({ status: 'superseded' }), /newer file/);
  assert.match(previewEndedReason({ status: 'discarded' }), /discarded/);
  assert.match(previewEndedReason(null), /no longer exists/);
  assert.equal(
    adminHref({ kind: 'metrics', target: { model_version: 'SynGPT-2.0', use_case: 'CDSS' } }),
    './admin.html?set=metrics&model=SynGPT-2.0&use_case=CDSS'
  );
  assert.equal(adminHref(null), './admin.html');
});

test('a population preview compares only its own population with the default prevalence', () => {
  const base = { model: 'M', useCase: 'U', age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
  const staged = { kind: 'population', target: { population_id: 'test-coast', population_name: 'Test coast (fictional)' } };
  const previewed = previewedPopulationId(staged);
  assert.equal(previewed, 'test-coast');
  // The previewed population on screen: the live side reads the default prevalence.
  assert.deepEqual(liveComparisonFilters({ ...base, population: 'test-coast' }, previewed), base);
  // Another population on screen (e.g. Northbridge): the live side reads that population, unchanged.
  const other = { ...base, population: 'northbridge-region' };
  assert.equal(liveComparisonFilters(other, previewed), other);
  // The default prevalence on screen, or any other kind of preview: the same filters.
  assert.equal(liveComparisonFilters(base, previewed), base);
  assert.equal(previewedPopulationId({ kind: 'metrics', target: { model_version: 'M', use_case: 'U' } }), null);
  assert.equal(liveComparisonFilters(other, previewedPopulationId({ kind: 'prevalence', target: null })), other);
  assert.equal(liveComparisonFilters(null, previewed), null);
  // The atlas uses it for its live comparison.
  const app = readFileSync(new URL('../frontend/src/app/AtlasApp.jsx', import.meta.url), 'utf8');
  assert.match(app, /liveComparisonFilters\(filters, previewedPopulation\)/);
});
