// The care setting as a lens axis (contract v1.14, CONTRACT.md §29):
// one vocabulary, the read parameter, URL state on the atlas and the comparison,
// the population line, the condition card's "No data for this setting" with the
// Any-setting result on request, the toolbar choice, the live panel, and the
// Data Library's change summary. All data is synthetic.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { conceptMetricsQuery, conceptSubgroupsQuery, filtersKey, metricParams, subgroupSummaryQuery } from '../frontend/src/api/queryKeys.js';
import { atlasSearch, parseStartupParams, STATE_PARAMS } from '../frontend/src/app/startupParams.js';
import { compareSearch, parseCompareState } from '../frontend/src/features/compare/compareState.js';
import { requestedLensWords, resultContext, settingsWords } from '../frontend/src/features/compare/compareCopy.js';
import { cardAtlasHref } from '../frontend/src/features/compare/compareModel.js';
import {
  ANY_SETTING,
  CARE_SETTINGS,
  anySettingResultLabel,
  codeOfSetting,
  settingLabel,
  settingNotice,
  settingOfCode,
  specificSetting,
  storedSettings,
  storesSetting
} from '../frontend/src/shared/careSetting.js';
import { resultPopulationLabel, resultPopulationSlug } from '../frontend/src/shared/resultPopulation.js';
import { anySettingResult, noSettingResult } from '../frontend/src/features/details/copy/settingCopy.js';
import { lookupBody, readPanelInputs } from '../frontend/src/embed/panelInputs.js';
import { populationLine } from '../frontend/src/embed/panelView.js';
import { PRESETS, caseFromPreset, matchingPreset, panelAttributes, settingOptions } from '../frontend/src/features/plugin/pluginCase.js';
import { onlySetting, sampleText, settingChanges } from '../frontend/src/features/admin/changeSummary.js';
import { previewHref } from '../frontend/src/features/admin/atlasLinks.js';
import { ATLAS_PARAMS } from '../frontend/src/features/catalogue/pageLinks.js';

// Modules that import JSX load through Vite, as in the other component tests.
let vite;
const load = (path) => vite.ssrLoadModule(path);
before(async () => {
  vite = await createServer({
    configFile: false,
    root: new URL('../frontend/', import.meta.url).pathname,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] }
  });
});
after(async () => {
  await vite?.close();
});

const spec = JSON.parse(readFileSync(new URL('../backend/openapi.json', import.meta.url), 'utf8'));
const contract = readFileSync(new URL('../backend/CONTRACT.md', import.meta.url), 'utf8');
const source = (relative) => readFileSync(new URL(`../frontend/src/${relative}`, import.meta.url), 'utf8');

const ED = 'Emergency department';
const ALL = { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
const FILTERS = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', ...ALL };

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function mockClient(respond = () => json({ ok: true })) {
  const requests = [];
  const fetchMock = async (input) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), keys: [...url.searchParams.keys()] });
    return respond(url);
  };
  return { client: createDataClient(createApiAdapter({ fetch: fetchMock })), requests };
}

// ------------------------------------------------------------- vocabulary

test('one vocabulary: the axis values of /meta, the study setting categories, and the codes', () => {
  const contextEnum = spec.components.schemas.ContextLens.enum;
  assert.deepEqual(contextEnum, [ANY_SETTING, ...CARE_SETTINGS.map((setting) => setting.value)]);
  const lookupEnum = spec.components.schemas.LookupContext.properties.setting.anyOf[0].enum;
  assert.deepEqual(lookupEnum, CARE_SETTINGS.map((setting) => setting.code));
  assert.deepEqual(spec.components.schemas.Study.properties.setting_category.enum.slice(0, 5), lookupEnum);
  for (const { code, value } of CARE_SETTINGS) {
    assert.equal(settingOfCode(code), value);
    assert.equal(codeOfSetting(value), code);
    assert.equal(settingLabel(value), value);
  }
  assert.equal(settingLabel(ANY_SETTING), 'Any setting');
  assert.equal(settingLabel(null), 'Any setting');
  assert.equal(specificSetting(ANY_SETTING), null);
  assert.equal(specificSetting('Ward 7'), null);
  assert.equal(settingOfCode('Emergency department'), null, 'the URL and the lookup take codes');
  assert.deepEqual(storedSettings({ use_case: 'X' }), [ANY_SETTING]);
  assert.deepEqual(storedSettings({ settings: [ANY_SETTING, ED] }), [ANY_SETTING, ED]);
  assert.equal(storesSetting({ settings: [ANY_SETTING, ED] }, 'Intensive care'), false);
  assert.equal(storesSetting({}, null), true);
  assert.match(settingNotice(ED), /^Setting: Emergency department\. Only results measured there/);
  assert.equal(settingNotice(null), '');
  assert.equal(anySettingResultLabel(ED), 'Any setting, not specific to Emergency department');
});

test('the contract adds the read parameter to every read that takes a lens (v1.14, §29)', () => {
  const lensReads = [
    'getMetricMap', 'getMetricSummary', 'getConceptMetrics', 'getConceptSubgroups', 'getSubgroupSummary',
    'getComparison', 'getMultimorbidityCandidates', 'getMultimorbidityCombination', 'exportConcept'
  ];
  for (const [, item] of Object.entries(spec.paths)) {
    for (const op of Object.values(item)) {
      const names = (op.parameters ?? []).map((p) => (p.$ref ? spec.components.parameters[p.$ref.split('/').pop()] : p).name);
      assert.equal(names.includes('context'), lensReads.includes(op.operationId), op.operationId);
    }
  }
  const parameter = spec.components.parameters.Context;
  assert.equal(parameter.required, false);
  assert.equal(parameter.schema.$ref, '#/components/schemas/ContextLens');
  // Additive facts: optional, sent only when a card stores a specific setting.
  const lenses = spec.components.schemas.ComparisonCard.properties.lenses;
  assert.ok(lenses.properties.settings && !lenses.required.includes('settings'));
  assert.ok(!spec.components.schemas.Axes.required.includes('settings'));
  assert.match(contract, /## 29\. Care settings/);
  assert.match(contract, /`setting_not_stored`|population_differs/);
});

// ------------------------------------------------------------ data layer

test('a specific setting is sent as context and keys every read; Any setting changes nothing', async () => {
  assert.equal(filtersKey(FILTERS), 'SynGPT-2.0|Clinician Facing CDSS|All ages|All sexes|All ethnicities');
  assert.equal(filtersKey({ ...FILTERS, setting: ED }), `SynGPT-2.0|Clinician Facing CDSS|All ages|All sexes|All ethnicities|setting:${ED}`);
  assert.equal(metricParams(FILTERS).setting, undefined);
  assert.equal(metricParams({ ...FILTERS, setting: ED }).setting, ED);
  assert.notEqual(conceptSubgroupsQuery(FILTERS, '5A11').key, conceptSubgroupsQuery({ ...FILTERS, setting: ED }, '5A11').key);
  assert.notEqual(subgroupSummaryQuery(FILTERS).key, subgroupSummaryQuery({ ...FILTERS, setting: ED }).key);
  assert.equal(subgroupSummaryQuery(FILTERS).key, 'subgroup-summary|SynGPT-2.0|Clinician Facing CDSS');

  const { client, requests } = mockClient();
  await client.getMetricMap({ ...metricParams(FILTERS), scope: 'atlas' });
  assert.ok(!requests.at(-1).keys.includes('context'), 'an Any-setting URL is what it was');
  await client.getMetricMap({ ...metricParams({ ...FILTERS, setting: ED }), scope: 'atlas' });
  assert.equal(requests.at(-1).query.context, ED);
  await client.getMetricMap({ ...metricParams(FILTERS), setting: ANY_SETTING, scope: 'atlas' });
  assert.ok(!requests.at(-1).keys.includes('context'), 'Clinical is not sent either');
  await conceptMetricsQuery({ ...FILTERS, setting: ED }, '5A11').fetch(client, {});
  assert.equal(requests.at(-1).query.context, ED);
  await conceptSubgroupsQuery({ ...FILTERS, setting: ED }, '5A11').fetch(client, {});
  assert.deepEqual([requests.at(-1).path, requests.at(-1).query.context], ['/api/v1/metrics/concepts/5A11/subgroups', ED]);
  await subgroupSummaryQuery({ ...FILTERS, setting: ED }).fetch(client, {});
  assert.equal(requests.at(-1).query.context, ED);
  await client.getComparison({ cards: ['A|B', 'C|D'], ...ALL, setting: ED });
  assert.equal(requests.at(-1).query.context, ED);
  await client.exportConcept({ ...metricParams({ ...FILTERS, setting: ED }), conceptId: '5A11' });
  assert.equal(requests.at(-1).query.context, ED);
});

// ---------------------------------------------------------------- URL state

test('the atlas URL keeps the setting by its code, and links between pages carry it', () => {
  assert.ok(STATE_PARAMS.includes('setting') && ATLAS_PARAMS.includes('setting'));
  const search = atlasSearch({ model: 'M', useCase: 'U', lens: ALL, setting: ED, view: 'overall' });
  assert.match(search, /&setting=emergency_department/);
  const parsed = parseStartupParams(search);
  assert.equal(parsed.setting, ED);
  assert.ok(parsed.stateParams.includes('setting'), 'a link naming a setting is atlas state');
  assert.doesNotMatch(atlasSearch({ model: 'M', setting: ANY_SETTING }), /setting/);
  assert.equal(parseStartupParams('?setting=ward').setting, null, 'an unknown code reads as Any setting');
  assert.equal(parseStartupParams('?setting=Emergency+department').setting, null);

  const state = parseCompareState(compareSearch({ cards: ['A|B', 'C|D'], lens: ALL, setting: 'Primary care' }));
  assert.equal(state.setting, 'Primary care');
  assert.equal(parseCompareState('?cards=A|B,C|D').setting, null);
  assert.match(cardAtlasHref('A|B', { lens: ALL, setting: 'Primary care' }), /setting=primary_care/);
  assert.match(previewHref({ upload_id: 'u1', kind: 'metrics' }, { kind: 'metrics', target: { model: 'M', useCase: 'U' }, setting: ED }), /setting=emergency_department/);
});

// ------------------------------------------------------------ who it is for

test('the population line names a specific setting after the group, never Any setting', () => {
  assert.equal(resultPopulationLabel(ALL, null), 'All patients, default prevalence');
  assert.equal(resultPopulationLabel(ALL, null, { setting: ANY_SETTING }), 'All patients, default prevalence');
  assert.equal(resultPopulationLabel(ALL, null, { setting: ED }), 'All patients, Emergency department, default prevalence');
  assert.equal(
    resultPopulationLabel({ ...ALL, age: 'Age 65+' }, { id: 'northbridge-region', name: 'Northbridge region (fictional)' }, { setting: 'Intensive care' }),
    'Age 65+, Intensive care, Northbridge region (fictional)'
  );
  assert.equal(resultPopulationSlug(ALL, null, ED), 'emergency-department');
  assert.equal(resultPopulationSlug(ALL, null, ANY_SETTING), '');
  assert.equal(resultContext({ lens: ALL, setting: 'Primary care' }), 'All patients, Primary care, default prevalence');
});

// ------------------------------------------------------- the condition card

test('a setting without a result says so and offers the Any-setting result on request, labelled', async () => {
  const { AnySettingResult } = await load('/src/features/details/AnySettingResult.js');
  const { DataClientProvider } = await load('/src/api/DataClientProvider.jsx');
  assert.equal(noSettingResult(null, 'condition'), null);
  assert.deepEqual(noSettingResult(ED, 'condition'), {
    title: 'No data for this setting',
    text: 'No result for this condition was measured in Emergency department for the current AI system, function, and population.'
  });
  const row = {
    perf: 0.82, performance_grade: 'B', evidence_grade: 'C', overall: { tier: 'graded', score: 0.71, grade: 'C' },
    status: { overall: 'moderate', performance: 'strong', evidence: 'moderate' }, intended_use_level: 'in_scope', provenance: { source: 'condition' }
  };
  const shown = anySettingResult(row, ED, 'expert');
  assert.equal(shown.label, 'Any setting, not specific to Emergency department');
  assert.deepEqual(shown.rows.map((entry) => entry.title), ['Overview', 'Performance', 'Evidence']);
  assert.equal(shown.rows[1].figure, '0.82 (B)');
  assert.match(shown.text, /not in Emergency department alone/);
  assert.deepEqual(anySettingResult(null, ED).rows, []);

  // On request only: the button first, no read; the read goes through the data client once asked.
  const query = { key: 'concept|x', fetch: () => Promise.resolve({ metrics: row }) };
  const { client } = mockClient();
  const markup = renderToStaticMarkup(h(DataClientProvider, { client }, h(AnySettingResult, { query, setting: ED, depth: 'plain' })));
  assert.match(markup, /Show the Any-setting result/);
  assert.doesNotMatch(markup, /not specific to/);
  const card = source('features/details/DetailCard.jsx');
  assert.match(card, /settingEmpty/);
  assert.match(source('app/AtlasApp.jsx'), /conceptMetricsQuery\(\{ \.\.\.filters, setting: null \}/, 'the Any-setting read is the concept read without the setting');
});

// ------------------------------------------------------------- the toolbar

test('the Setting choice offers Any setting and the five, marking settings the card stores nothing for', async () => {
  const { default: SettingChoice } = await load('/src/features/toolbar/SettingChoice.jsx');
  const markup = renderToStaticMarkup(
    h(SettingChoice, { value: 'Intensive care', options: CARE_SETTINGS.map((setting) => setting.value), stored: [ANY_SETTING, ED], onChange: () => {} })
  );
  assert.match(markup, />Setting</);
  assert.match(markup, /<option value="Clinical">Any setting<\/option>/);
  assert.match(markup, /<option value="Emergency department">Emergency department<\/option>/);
  assert.match(markup, /Intensive care \(No data stored\)/);
  assert.match(markup, /stores no results for Intensive care, so every condition reads No data/);
  // The static demo (release 0.5, Q9) records the settings each card stores: the others cannot be chosen there,
  // and in another classification none can.
  const options = CARE_SETTINGS.map((setting) => setting.value);
  const recorded = renderToStaticMarkup(h(SettingChoice, { value: ED, options, stored: [ANY_SETTING, ED], onChange: () => {}, isStatic: true }));
  assert.match(recorded, /<option value="Emergency department"[^>]*>Emergency department<\/option>/);
  assert.match(recorded, /<option value="Intensive care" disabled="">Intensive care \(not in the static demo\)<\/option>/);
  assert.match(recorded, /holds the settings each card stores, for all patients/);
  const locked = renderToStaticMarkup(
    h(SettingChoice, { value: null, options, stored: [ANY_SETTING], onChange: () => {}, isStatic: true, lockedNote: 'In this static demo, care settings are shown in ICD-11 only.' })
  );
  assert.match(locked, /<select aria-labelledby="setting-title" aria-describedby="setting-note" disabled="">/);
  assert.match(locked, /care settings are shown in ICD-11 only/);
  assert.match(source('features/compare/CompareApp.jsx'), /const settingOptions = IS_STATIC_BUILD \? \[\]/);
});

// ----------------------------------------------------------- comparison facts

test('the comparison names each card\'s settings and a card without the chosen one', () => {
  assert.equal(settingsWords({ stored: 90 }), 'Any setting');
  assert.equal(settingsWords({ settings: [ANY_SETTING, ED] }), 'Any setting, Emergency department');
  assert.equal(requestedLensWords({ requested: 'none', stored: 0, settings: undefined }, ALL, ED), 'No data for this setting');
  assert.equal(requestedLensWords({ requested: 'stored', settings: [ANY_SETTING, ED] }, ALL, ED), '');
  assert.equal(requestedLensWords({ requested: 'stored' }, ALL, null), '');
});

// --------------------------------------------------------------- live panel

test('the live panel takes a setting code, sends it in the lookup body, and names it', () => {
  const attributes = { model: 'Vantrel-Triage-2.1', 'use-case': 'Emergency department triage', codes: '8B20', setting: 'emergency_department' };
  const inputs = readPanelInputs((name) => attributes[name] ?? null);
  assert.equal(inputs.setting, 'emergency_department');
  assert.equal(lookupBody(inputs).context.setting, 'emergency_department');
  assert.match(populationLine(inputs), /All patients, Emergency department, default prevalence/);
  const plain = readPanelInputs((name) => ({ ...attributes, setting: null })[name] ?? null);
  assert.ok(!('setting' in lookupBody(plain).context), 'no setting: the body is what it was');
  const odd = readPanelInputs((name) => ({ ...attributes, setting: 'a note' })[name] ?? null);
  assert.equal(odd.setting, null);
  assert.deepEqual(odd.ignored.lens, ['setting']);
  // The demo page: a preset in the emergency department, and the setting choice.
  const preset = PRESETS.find((item) => item.setting);
  const current = caseFromPreset(preset);
  assert.equal(matchingPreset(current)?.id, preset.id);
  assert.equal(panelAttributes(current).setting, 'emergency_department');
  assert.equal(matchingPreset({ ...current, setting: null })?.id === preset.id, false);
  assert.deepEqual(settingOptions().map((option) => option.label), ['Any setting', ...CARE_SETTINGS.map((setting) => setting.value)]);
});

// ------------------------------------------------------------ Data Library

test('the change summary counts and names rows per care setting', () => {
  const changes = {
    kind: 'metrics',
    rows: {
      added: 600, changed: 0, removed: 0, unchanged: 0,
      settings: [{ setting: ED, added: 600, changed: 0, removed: 0 }],
      samples: { added: [{ key: 'NA00|90', name: 'Superficial injury of head', concept_id: 'NA00', code: 'NA00', lens: ALL, setting: ED }], changed: [], removed: [] }
    }
  };
  assert.deepEqual(settingChanges(changes), ['Emergency department: 600 added']);
  assert.equal(onlySetting(changes), ED, 'an update of one setting only previews there');
  assert.equal(onlySetting({ rows: { ...changes.rows, added: 601 } }), null);
  assert.equal(sampleText(changes.rows.samples.added[0]), 'Superficial injury of head, NA00, All patients, Emergency department');
  assert.deepEqual(settingChanges({ rows: { added: 3 } }), []);
});
