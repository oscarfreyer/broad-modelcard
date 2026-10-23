// Local results, the instance, role workspaces, and narrow model cards
// (contract v1.13, CONTRACT.md §26): the pure
// presentation modules of the frontend. All data is synthetic and fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createStaticAdapter, STATIC_UNAVAILABLE } from '../frontend/src/api/staticAdapter.js';
import { decodeMetricMap } from '../frontend/src/features/atlas/decodeMetricMap.js';
import { hasLocalLayer, localDot, localLayerOf, localLayerText } from '../frontend/src/features/atlas/localLayer.js';
import { isLocalRow, localComparison } from '../frontend/src/features/details/copy/localCopy.js';
import { LocalAndPublic } from '../frontend/src/features/details/LocalResult.js';
import { narrowCardItems, narrowCardReference } from '../frontend/src/features/summary/narrowCard.js';
import SystemAbout from '../frontend/src/features/summary/SystemAbout.js';
import { instanceLine, STATIC_INSTANCE_LINE } from '../frontend/src/shared/instance.js';
import { NO_LOGIN_NOTE, TOOL_PAGES, WORKSPACES, publisherFields, publisherWords, workspaceHasPage } from '../frontend/src/features/admin/workspace.js';
import { partState, submissionReady } from '../frontend/src/features/admin/submissions.js';

const read = (path) => readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8');

const row = (overrides = {}) => ({
  concept_id: '1C45',
  model_version: 'ICU-GPT-1.0',
  use_case: 'CDSS',
  perf: 0.88,
  performance_grade: 'B',
  evidence_grade: 'C',
  n_samples: 1200,
  overall: { tier: 'graded', score: 0.81, grade: 'B' },
  status: { overall: 'strong', performance: 'strong', evidence: 'moderate' },
  provenance: { source: 'condition', lens_fallback: false, data_source: { source: 'Public registry (fictional)', study: null, date: null } },
  ...overrides
});

const LOCAL = row({
  perf: 0.63,
  performance_grade: 'D',
  overall: { tier: 'graded', score: 0.6, grade: 'C' },
  status: { overall: 'moderate', performance: 'weak', evidence: 'moderate' },
  provenance: { source: 'condition', lens_fallback: false, layer: 'local', data_source: { source: 'Northbridge ICU evaluation (fictional)', study: 'NBR-ICU-1', date: null } },
  appraisal: {
    study: {
      study_id: 'NBR-ICU-1',
      title: 'Northbridge ICU evaluation (fictional)',
      design: 'retrospective',
      sites: 1,
      patients: 410,
      population: 'Adults in intensive care (synthetic)',
      evaluation_conditions: 'Silent mode, six months (synthetic).',
      model_version: 'ICU-GPT-1.0',
      scope: 'hospital',
      population_id: 'northbridge-region'
    }
  }
});

test('the instance line names who runs this copy, and the static demo calls itself a snapshot', () => {
  assert.equal(instanceLine({ kind: 'public', organisation: 'Broad Modelcard (demonstration)', maintained_by: 'the Broad Modelcard project' }, { isStatic: false }), 'Public service, maintained by the Broad Modelcard project');
  assert.equal(
    instanceLine({ kind: 'hospital', organisation: 'Northbridge General (fictional)', maintained_by: 'the clinical AI office' }, { isStatic: false }),
    'Hospital version, Northbridge General (fictional), administered by the clinical AI office'
  );
  assert.equal(instanceLine(null, { isStatic: false }), '');
  assert.equal(instanceLine(null, { isStatic: true }), STATIC_INSTANCE_LINE);
  assert.equal(STATIC_INSTANCE_LINE, 'Public service (demonstration snapshot)');
  // In Settings, under About this copy, on every page.
  const hook = read('design/useInstanceLine.js');
  assert.match(hook, /instanceLine\(instance\)/);
  assert.match(hook, /IS_STATIC_BUILD \|\| !context/, 'the static demo never reads /meta for it');
  assert.match(read('features/profile/DefaultsSheet.jsx'), /useInstanceLine\(\)[\s\S]*About this copy/);
});

test('four workspaces without login decide the pages, and a publish records role and name', () => {
  assert.deepEqual(WORKSPACES.map((entry) => entry.id), ['developer', 'custodian', 'hospital', 'maintainer']);
  assert.match(NO_LOGIN_NOTE, /no login/);
  assert.equal(workspaceHasPage({ id: 'developer' }, 'submit'), true);
  assert.equal(workspaceHasPage({ id: 'developer' }, 'metrics'), false, 'a developer never publishes data sets');
  assert.equal(workspaceHasPage({ id: 'hospital' }, 'local_metrics'), true);
  assert.equal(workspaceHasPage({ id: 'hospital' }, 'release'), true);
  assert.equal(workspaceHasPage({ id: 'custodian' }, 'review'), true);
  assert.equal(workspaceHasPage({ id: 'maintainer' }, 'effects'), true, 'Maintainer sees every page');
  for (const page of ['submit', 'review', 'model_cards', 'instance', 'release']) assert.ok(TOOL_PAGES[page].title, page);
  assert.deepEqual(publisherFields({ id: 'custodian', name: ' C. Ustodian ' }), { role: 'custodian', publisherName: 'C. Ustodian' });
  assert.deepEqual(publisherFields({ id: 'hospital', name: '' }), { role: 'hospital' });
  assert.deepEqual(publisherFields({ id: 'developer', name: 'D' }), {}, 'a developer submits; it never publishes');
  assert.deepEqual(publisherFields(null), {});
  assert.equal(publisherWords({ publisher_role: 'hospital', publisher_name: 'A. Admin' }), 'Published in Hospital administration by A. Admin');
  assert.equal(publisherWords({ publisher_role: null, publisher_name: null }), '');
});

test('a submission part says where its check stands; a submission is ready only when every part is', () => {
  assert.equal(partState({ status: 'checking' }).word, 'Checking');
  assert.deepEqual(partState({ status: 'invalid', report: { errors: [{ count: 2 }] } }), { word: 'Needs a fix: 2 problems', tone: 'fix' });
  assert.equal(partState({ status: 'valid', report: { notes: [] } }).word, 'Ready');
  assert.equal(partState({ status: 'published' }).tone, 'done');
  assert.equal(submissionReady({ uploads: [{ status: 'valid' }, { status: 'valid' }] }), true);
  assert.equal(submissionReady({ uploads: [{ status: 'valid' }, { status: 'invalid' }] }), false);
  assert.equal(submissionReady({ uploads: [] }), false);
});

test('the map layer marks local results on the ring, never on Safety or in combination mode', () => {
  const rows = decodeMetricMap({
    columns: ['concept_id', 'perf'],
    rows: [['1C45', 0.63], ['1C4', 0.7], ['2A00', 0.9]],
    layer: ['local', 'includes_local', null]
  });
  assert.equal(rows.get('1C45').layer, 'local');
  assert.equal(localLayerOf(rows.get('1C45'), 'performance'), 'local');
  assert.equal(localLayerOf(rows.get('1C4'), 'overall'), 'includes_local');
  assert.equal(localLayerOf(rows.get('2A00'), 'overall'), null);
  assert.equal(localLayerOf(rows.get('1C45'), 'safety'), null, 'Safety draws incidents, not results');
  assert.equal(localLayerOf(rows.get('1C45'), 'overall', { isCombinationMode: true }), null);
  assert.equal(localLayerText('local'), 'local result');
  assert.equal(hasLocalLayer([{ concept_id: '2A00' }, { concept_id: '1C45' }], rows, 'evidence'), true);
  assert.equal(hasLocalLayer([{ concept_id: '2A00' }], rows, 'evidence'), false);
  const plain = decodeMetricMap({ columns: ['concept_id'], rows: [['2A00']] });
  assert.equal('layer' in plain.get('2A00'), false, 'a map without local results keeps its rows as they were');
  const dot = localDot({ x: 10, y: 10 }, 8);
  assert.ok(dot.cx > 10 && dot.cy < 10 && dot.r >= 1.6, 'the dot sits on the upper right rim');
  assert.match(read('features/atlas/RingLegend.jsx'), /label="Local result"/);
});

test('the condition card shows Local and public side by side, with where each comes from', () => {
  const details = { metrics: LOCAL, public_metrics: row(), population: { id: 'northbridge-region', name: 'Northbridge region (synthetic)' } };
  assert.equal(isLocalRow(LOCAL), true);
  assert.equal(isLocalRow(row()), false);
  const plain = localComparison(details, 'plain');
  assert.match(plain.lead, /hospital’s own evaluation for Northbridge region/);
  assert.deepEqual(plain.rows.map((entry) => [entry.label, entry.local.word, entry.public.word]), [
    ['Overview', 'Moderate', 'Strong'],
    ['Performance', 'Weak', 'Strong'],
    ['Evidence', 'Moderate', 'Moderate']
  ]);
  assert.equal(plain.rows[1].local.figure, '0.63');
  assert.equal(localComparison(details, 'expert').rows[1].local.figure, '0.63 (D)', 'expert depth adds the grade');
  assert.ok(plain.local.some((fact) => fact.label === 'Evaluation' && /Silent mode/.test(fact.value)));
  assert.ok(plain.local.some((fact) => fact.label === 'Model version' && fact.value === 'ICU-GPT-1.0'));
  assert.ok(plain.public.some((fact) => fact.label === 'Source'));
  const without = localComparison({ ...details, public_metrics: null }, 'plain');
  assert.equal(without.publicMissing, true);
  assert.equal(without.rows[0].public.word, 'No data');
  assert.equal(localComparison({ metrics: row(), public_metrics: null }, 'plain'), null, 'a public row shows no comparison');

  const markup = renderToStaticMarkup(h(LocalAndPublic, { details, depth: 'plain' }));
  assert.match(markup, />Local and public</);
  assert.match(markup, /<th scope="col">.*Local<\/th><th scope="col">Public<\/th>/);
  assert.match(markup, />Local evaluation</);
  assert.equal(renderToStaticMarkup(h(LocalAndPublic, { details: { metrics: row() }, depth: 'plain' })), '');
  // Its place on the card: right under the result it replaces, before the Overview rule, the evidence, Effects, and Across groups.
  const card = read('features/details/DetailCard.jsx');
  const at = (needle) => card.indexOf(needle);
  assert.ok(at('<LocalAndPublic') > at('className="metric-stack"'));
  assert.ok(at('<LocalAndPublic') < at('<OverviewExplainer'));
  // Effects render where the card places them (the Payer preset moves them under the header).
  assert.ok(at('<LocalAndPublic') < at("layout.lead.includes('effects') ? null : effectsSection"));
});

test('the narrow model card shows under About as the developer’s own words, and as one line on the model card', () => {
  const card = {
    model_version: 'Tidewell-Sepsis-1.0',
    source_format: 'json',
    name: 'Tidewell Sepsis',
    version: '1.0',
    licence: 'Proprietary (fictional)',
    intended_use: 'Early warning of sepsis in adult wards (synthetic).',
    limitations: 'Not evaluated in children.',
    training_data: null,
    date: '2026-09-30',
    results: [{ value: 0.81 }, { value: 0.77 }],
    markdown: null
  };
  const items = narrowCardItems(card);
  assert.equal(items.title, 'Tidewell Sepsis 1.0');
  assert.deepEqual(items.items.map((item) => item.label), ['Intended use', 'Limitations', 'Licence', 'Date']);
  assert.match(items.note, /Not checked/);
  assert.match(items.results, /2 reported results; on the atlas only once reviewed/);
  assert.equal(narrowCardItems(null), null);
  assert.equal(narrowCardReference(card), 'Developer’s model card: Tidewell Sepsis 1.0 (JSON), not checked.');
  const markup = renderToStaticMarkup(h(SystemAbout, { details: { hasDetails: false, declarations: null }, narrowCard: card }));
  assert.match(markup, /Developer’s model card/);
  assert.match(markup, /Not evaluated in children/);
  assert.equal(renderToStaticMarkup(h(SystemAbout, { details: { hasDetails: false, declarations: null } })), '');
});

test('the static demo rejects every §26 read and admin method with static_unavailable', async () => {
  const adapter = createStaticAdapter({ fetch: async () => new Response('{}', { status: 404 }) });
  for (const method of ['getNarrowModelCard', 'listDatasetVersions']) {
    await assert.rejects(adapter[method]({ modelVersion: 'X' }), (error) => error.code === STATIC_UNAVAILABLE, method);
  }
});
