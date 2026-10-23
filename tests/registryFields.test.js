// Configurations and lineage (contract v1.14, CONTRACT.md §28):
// "About this AI system" shows the configuration (plain: label, date, one line;
// expert: every field), what the figures measure, and the versions with a link
// to compare with the previous one; the developer's data-protection
// declarations stay "Declared by the developer"; the catalogue says "Replaces X"
// and offers "Newest versions only"; the model card carries one configuration
// line; the Instance page sends the data-protection note. Fictional names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { hasLineage, isReplaced, replacesName, systemNames, visibleTiles } from '../frontend/src/features/catalogue/catalogueModel.js';
import { EMPTY_FILTERS, SORTS, TABS, catalogueSearch, parseCatalogueState } from '../frontend/src/features/catalogue/catalogueState.js';
import { buildLabelModel, configurationLine, labelText } from '../frontend/src/features/label/labelModel.js';
import { labelElements } from '../frontend/src/features/label/DeveloperLabel.js';
import SystemAbout from '../frontend/src/features/summary/SystemAbout.js';
import { configurationDetails, declarationItems, lineageDetails, samplingText, systemDetails } from '../frontend/src/features/summary/systemDetails.js';
import { functionCategoryLabel } from '../frontend/src/shared/aiSystem.js';

const RECORD = {
  configuration_id: 'cfg-2026-05',
  configuration_date: '2026-05-04',
  prompt_summary: 'Suggests a five-level urgency from the triage note; the nurse sets the final level (fictional).',
  prompt_sha256: 'ab'.repeat(32),
  retrieval: null,
  tools: ['vital_signs_rules', 'triage_scale'],
  sampling_temperature: 0,
  sampling_top_p: 1,
  sampling_max_output_tokens: 300,
  fine_tuning: null
};
const OLD = {
  model_version: 'Lumen-Triage-2.0',
  display_name: 'Lumen Triage 2.0',
  kind: 'product',
  built_on: [],
  replaced_by: ['Lumen-Triage-2.1'],
  use_cases: [{ use_case: 'Emergency department triage', has_multimorbidity: false, function_category: 'triage', declarations: null }]
};
const NEW = {
  model_version: 'Lumen-Triage-2.1',
  display_name: 'Lumen Triage 2.1',
  kind: 'product',
  built_on: [],
  replaces: 'Lumen-Triage-2.0',
  use_cases: [
    {
      use_case: 'Emergency department triage',
      has_multimorbidity: false,
      function_category: 'triage',
      configuration: RECORD,
      performance_measure: 'Agreement with the expert urgency level',
      reference_standard: 'Two senior triage nurses (fictional)',
      declarations: {
        declared_intended_purpose: null,
        declared_regulatory_status: 'Not assessed (demonstration)',
        declared_contact: null,
        declared_documentation_url: null,
        declared_data_use: 'Uses the triage note of the current visit only (fictional).',
        declared_data_location: 'EU (fictional)',
        declared_retention: '30 days (fictional)',
        declared_privacy_contact: 'privacy@lumen.example'
      }
    }
  ]
};
const REGISTRY = [OLD, NEW];
const render = (details, props = {}) => renderToStaticMarkup(createElement(SystemAbout, { details, onOpenSystem: () => {}, onOpenCard: () => {}, ...props }));

test('the configuration: plain depth shows label, date, and one line; expert depth every field', () => {
  const config = configurationDetails(NEW.use_cases[0]);
  assert.equal(config.label, 'cfg-2026-05');
  assert.equal(config.date, '4 May 2026');
  assert.equal(config.summary, RECORD.prompt_summary);
  assert.deepEqual(config.items.map((item) => item.label), ['Prompt summary', 'Tools', 'Sampling', 'Prompt checksum']);
  assert.equal(samplingText(RECORD), 'temperature 0, top-p 1, up to 300 tokens', 'a 0 temperature is a value, not a gap');
  assert.deepEqual(config.measure.map((item) => [item.label, item.value]), [
    ['Figures measure', 'Agreement with the expert urgency level'],
    ['Measured against', 'Two senior triage nurses (fictional)']
  ]);
  const details = systemDetails(NEW, NEW.use_cases[0], REGISTRY);
  const plain = render(details);
  assert.match(plain, /Configuration/);
  assert.match(plain, /cfg-2026-05, since 4 May 2026/);
  assert.match(plain, /class="system-config-summary"/);
  assert.doesNotMatch(plain, /Prompt checksum|vital_signs_rules/, 'plain depth stays short');
  const expert = render(details, { isExpert: true });
  assert.match(expert, /vital_signs_rules, triage_scale/);
  assert.match(expert, /SHA-256 abababababab…/);
  assert.match(expert, /Figures measure/);
  // Without a record or a measure there is no block; a measure alone shows without "Configuration".
  assert.equal(configurationDetails({ use_case: 'X' }), null);
  const measureOnly = systemDetails({ ...OLD, replaced_by: [] }, { ...OLD.use_cases[0], function_category: null, performance_measure: 'AUROC' }, []);
  assert.equal(measureOnly.hasDetails, true);
  assert.doesNotMatch(render(measureOnly), /system-config-head/);
});

test('versions link both ways, and Compare with previous version opens the matching card', () => {
  const lineage = lineageDetails(NEW, NEW.use_cases[0], REGISTRY);
  assert.deepEqual(lineage.replaces, {
    version: 'Lumen-Triage-2.0',
    label: 'Lumen Triage 2.0',
    canOpen: true,
    card: { modelVersion: 'Lumen-Triage-2.0', useCase: 'Emergency department triage' }
  });
  assert.deepEqual(lineage.previous, { modelVersion: 'Lumen-Triage-2.0', useCase: 'Emergency department triage' });
  assert.equal(lineageDetails(OLD, OLD.use_cases[0], REGISTRY).replacedBy[0].label, 'Lumen Triage 2.1');
  assert.equal(lineageDetails({ model_version: 'Solo' }, null, REGISTRY), null);
  // Another function: the same category, else the first card.
  const other = { model_version: 'Prev', use_cases: [{ use_case: 'Letters', function_category: 'documentation' }, { use_case: 'Rounds', function_category: 'decision_support' }] };
  const next = { model_version: 'Next', replaces: 'Prev', use_cases: [] };
  assert.equal(lineageDetails(next, { use_case: 'Advice', function_category: 'decision_support' }, [other, next]).previous.useCase, 'Rounds');
  assert.equal(lineageDetails(next, { use_case: 'Advice', function_category: 'triage' }, [other, next]).previous.useCase, 'Letters');
  // A predecessor outside the registry is named but not a link.
  const unknown = lineageDetails({ model_version: 'Next', replaces: 'Gone-1' }, null, []);
  assert.deepEqual([unknown.replaces.canOpen, unknown.previous], [false, null]);

  const opened = [];
  const html = render(systemDetails(NEW, NEW.use_cases[0], REGISTRY), {
    previousCompareHref: 'compare.html?cards=a',
    onOpenCard: (model, useCase) => opened.push([model, useCase])
  });
  assert.match(html, /<dt>Replaces<\/dt><dd><button type="button" class="link-button"[^>]*>Lumen Triage 2.0<\/button>/);
  assert.match(html, /<a class="system-compare-link" href="compare.html\?cards=a">Compare with previous version<\/a>/);
  assert.match(render(systemDetails(OLD, OLD.use_cases[0], REGISTRY)), /<dt>Replaced by<\/dt>/);
  const atlas = readFileSync(new URL('../frontend/src/app/AtlasApp.jsx', import.meta.url), 'utf8');
  assert.match(atlas, /cards: \[cardIdOf\(filters\.model, filters\.useCase\), \.\.\.otherCards\]/);
  assert.match(atlas, /compareStateHref\(\[cardIdOf\(previousCard\.modelVersion, previousCard\.useCase\)\]\)/);
});

test('data-protection declarations are shown as declared by the developer, never as checked', () => {
  const declared = declarationItems(NEW.use_cases[0].declarations);
  assert.deepEqual(declared.items.map((item) => item.label), ['Regulatory status', 'Data use', 'Data location', 'Retention', 'Privacy contact']);
  assert.equal(declared.note, 'The developer’s own statements, not checked.');
  const html = render(systemDetails(NEW, NEW.use_cases[0], REGISTRY));
  assert.ok(html.indexOf('Declared by the developer') < html.indexOf('Privacy contact'));
  assert.doesNotMatch(html, /\b(verified|certified|approved)\b/i);
  assert.equal(functionCategoryLabel('patient_communication'), 'Patient communication');
  assert.equal(functionCategoryLabel('administrative'), 'Administrative');
});

const tile = (system, use_case, extra = {}) => ({
  card_id: `${system.model_version}|${use_case}`,
  model_version: system.model_version,
  use_case,
  system: { status: 'ACTIVE', kind: 'product', ...system },
  distribution: { overall: {} },
  last_updated: { version: 1, at: '2026-10-01T00:00:00Z' },
  ...extra
});
const TILES = [
  tile({ model_version: 'Lumen-Triage-2.0', display_name: 'Lumen Triage 2.0', replaced_by: ['Lumen-Triage-2.1'] }, 'Emergency department triage'),
  tile({ model_version: 'Lumen-Triage-2.1', display_name: 'Lumen Triage 2.1', replaces: 'Lumen-Triage-2.0' }, 'Emergency department triage', { configuration: RECORD }),
  tile({ model_version: 'Solo-1', display_name: 'Solo 1' }, 'Triage')
];

test('the catalogue: "Replaces X" on a tile, and "Newest versions only" in the URL hides replaced systems', () => {
  const names = systemNames(TILES);
  assert.equal(replacesName(TILES[1], names), 'Lumen Triage 2.0');
  assert.equal(replacesName(TILES[0], names), null);
  assert.equal(replacesName(tile({ model_version: 'X', replaces: 'Gone-1' }, 'Y'), names), 'Gone-1');
  assert.deepEqual(TILES.map(isReplaced), [true, false, false]);
  assert.equal(hasLineage(TILES), true);
  assert.equal(hasLineage([TILES[2]]), false, 'no lineage, no choice');
  const ids = (newest) => visibleTiles(TILES, { tab: TABS.performance, filters: EMPTY_FILTERS, sort: SORTS.name, newest }).map((t) => t.model_version);
  assert.deepEqual(ids(false), ['Lumen-Triage-2.0', 'Lumen-Triage-2.1', 'Solo-1'], 'off by default: every card');
  assert.deepEqual(ids(true), ['Lumen-Triage-2.1', 'Solo-1']);
  assert.equal(catalogueSearch({ newest: true, tab: TABS.safety }), '?tab=safety&newest=1');
  assert.equal(parseCatalogueState('?newest=1').newest, true);
  const bar = readFileSync(new URL('../frontend/src/features/catalogue/FilterBar.jsx', import.meta.url), 'utf8');
  assert.match(bar, /aria-pressed=\{newest\}/);
  assert.match(bar, /Newest versions only/);
  const card = readFileSync(new URL('../frontend/src/features/catalogue/CatalogueTile.jsx', import.meta.url), 'utf8');
  assert.match(card, /Replaces \{replaces\}/);
});

test('the model card carries one configuration line with label and date', () => {
  assert.equal(configurationLine(RECORD), 'Configuration cfg-2026-05, since 4 May 2026');
  assert.equal(configurationLine({ ...RECORD, configuration_date: null }), 'Configuration cfg-2026-05');
  assert.equal(configurationLine({ ...RECORD, configuration_id: null }), 'Configuration not labelled, since 4 May 2026');
  assert.equal(configurationLine({ ...RECORD, configuration_id: null, configuration_date: null }), null);
  assert.equal(configurationLine(null), null);
  const catalogue = { dataset_version: '30', condition_count: 2400, lens: { context: 'Clinical', age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' } };
  const model = buildLabelModel(TILES[1], catalogue);
  assert.equal(model.configuration, 'Configuration cfg-2026-05, since 4 May 2026');
  assert.ok(labelText(model).includes('Configuration cfg-2026-05, since 4 May 2026.'));
  const drawn = renderToStaticMarkup(createElement('svg', null, ...labelElements(model).elements));
  assert.match(drawn, /Configuration cfg-2026-05, since 4 May 2026/);
  assert.equal(buildLabelModel(TILES[0], catalogue).configuration, null, 'no record, no line');
});

test('the Instance page sends the data-protection note only when given (contract v1.14, §26.2)', async () => {
  const bodies = [];
  const fetchMock = async (input, init = {}) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ kind: 'hospital', organisation: 'O', maintained_by: 'M', contact: null }), { headers: { 'Content-Type': 'application/json' } });
  };
  const client = createDataClient(createApiAdapter({ fetch: fetchMock }));
  await client.updateInstance({ kind: 'hospital', organisation: 'O', maintainedBy: 'M', contact: '', dataProtectionNote: 'Data stays on site (fictional).' });
  await client.updateInstance({ kind: 'hospital', organisation: 'O', maintainedBy: 'M', contact: '', dataProtectionNote: '' });
  assert.equal(bodies[0].data_protection_note, 'Data stays on site (fictional).');
  assert.ok(!('data_protection_note' in bodies[1]), 'left out: the backend clears it');
  const page = readFileSync(new URL('../frontend/src/features/admin/InstancePage.jsx', import.meta.url), 'utf8');
  assert.match(page, /Data-protection note \(optional\)/);
  assert.match(page, /max=\{NOTE_MAX\}/);
});
