// The AI system in the UI (CONTRACT.md §11.1): its Model or
// Product tag, "About this AI system" with empty fields left out, developer
// declarations in a separate block that never reads as verified, and the
// Data Library's words for backend-written summaries and problems.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { DATASETS, versionSummary } from '../frontend/src/features/admin/datasets.js';
import SystemAbout from '../frontend/src/features/summary/SystemAbout.js';
import { deriveHighlights } from '../frontend/src/features/summary/summaryHighlights.js';
import { DECLARATIONS_NOTE, declarationItems, systemDetails } from '../frontend/src/features/summary/systemDetails.js';
import { formatReleaseDate, kindLabel, systemOptionGroups } from '../frontend/src/shared/aiSystem.js';

// Shapes as listModels sends them (contract v1.5); names are fictional.
const SEED_MODEL = {
  model_version: 'SkinAI-1.0',
  display_name: 'SkinAI-1.0',
  kind: 'model',
  ai_type: null,
  developer: null,
  release_date: null,
  description: null,
  built_on: [],
  use_cases: [{ use_case: 'Skin lesion CDSS', has_multimorbidity: false, function_category: null, declarations: null }]
};
const DECLARATIONS = {
  declared_intended_purpose: 'Flags skin lesions for dermatologist review (fictional).',
  declared_regulatory_status: 'Not assessed (demonstration)',
  declared_contact: '',
  declared_documentation_url: 'https://corvessa.example/docs'
};
const PRODUCT = {
  model_version: 'Corvessa-Skin-Review-1.2',
  display_name: 'Corvessa Skin Review 1.2',
  kind: 'product',
  ai_type: 'imaging',
  developer: 'Corvessa Imaging (fictional)',
  release_date: '2026-03-12',
  description: 'Fictional product that reviews skin photographs.',
  built_on: ['SkinAI-1.0', 'Retired-0.9'],
  use_cases: [{ use_case: 'Skin lesion CDSS', has_multimorbidity: false, function_category: 'image_analysis', declarations: DECLARATIONS }]
};
const REGISTRY = [SEED_MODEL, PRODUCT];
const render = (details, onOpenSystem = () => {}) => renderToStaticMarkup(createElement(SystemAbout, { details, onOpenSystem }));

test('kind tags and the AI system picker: Models and Products as groups once a product exists', () => {
  assert.equal(kindLabel(SEED_MODEL), 'Model');
  assert.equal(kindLabel(PRODUCT), 'Product');
  assert.equal(kindLabel({ model_version: 'Old' }), 'Model', 'an entry without kind is a model');
  assert.deepEqual(systemOptionGroups([SEED_MODEL]), [{ label: null, options: [{ value: 'SkinAI-1.0', label: 'SkinAI-1.0' }] }]);
  assert.deepEqual(systemOptionGroups(REGISTRY), [
    { label: 'Models', options: [{ value: 'SkinAI-1.0', label: 'SkinAI-1.0' }] },
    { label: 'Products', options: [{ value: 'Corvessa-Skin-Review-1.2', label: 'Corvessa Skin Review 1.2' }] }
  ]);
  assert.equal(formatReleaseDate('2026-03-12'), '12 March 2026');
  assert.equal(formatReleaseDate('12.03.2026'), null);
});

test('a seed entry without the new fields shows no About block at all', () => {
  const details = systemDetails(SEED_MODEL, SEED_MODEL.use_cases[0], REGISTRY);
  assert.equal(details.hasDetails, false);
  assert.equal(details.declarations, null);
  assert.equal(render(details), '');
  assert.equal(render(null), '');
});

test('About this AI system lists what is known, leaves out empty fields, and links "built on" models in the registry', () => {
  const details = systemDetails(PRODUCT, PRODUCT.use_cases[0], REGISTRY);
  assert.deepEqual(details.facts.map((fact) => [fact.label, fact.value]), [
    ['Developer', 'Corvessa Imaging (fictional)'],
    ['Released', '12 March 2026'],
    ['Function', 'Skin lesion CDSS'],
    ['Function category', 'Image analysis']
  ]);
  assert.deepEqual(details.builtOn, [
    { version: 'SkinAI-1.0', label: 'SkinAI-1.0', canOpen: true },
    { version: 'Retired-0.9', label: 'Retired-0.9', canOpen: false }
  ]);
  const html = render(details);
  assert.match(html, /About this AI system/);
  assert.match(html, /<span class="kind-tag">Product<\/span><span>Imaging model<\/span>/);
  assert.match(html, /<button type="button" class="link-button"[^>]*>SkinAI-1.0<\/button>/, 'a registry model opens on the atlas');
  assert.doesNotMatch(html, /<button[^>]*>Retired-0.9/, 'an unknown model stays plain text');

  const sparse = systemDetails({ ...PRODUCT, developer: '  ', release_date: null, built_on: [], description: null }, { use_case: 'Triage', function_category: null }, REGISTRY);
  assert.deepEqual(sparse.facts.map((fact) => fact.id), ['function']);
  const sparseHtml = render(sparse);
  assert.doesNotMatch(sparseHtml, /Developer|Released|Built on|Function category|system-description/);
});

test('developer declarations are a separate block that never reads as verified', () => {
  const details = systemDetails(PRODUCT, PRODUCT.use_cases[0], REGISTRY);
  assert.deepEqual(details.declarations.items.map((item) => item.label), ['Intended purpose', 'Regulatory status', 'Documentation'], 'an empty declaration is left out');
  const html = render(details);
  const about = html.slice(0, html.indexOf('<section class="system-declared"'));
  const declared = html.slice(html.indexOf('<section class="system-declared"'));
  assert.ok(about.includes('system-about') && declared.length > 0, 'two sections, About first');
  assert.doesNotMatch(about, /Intended purpose|Regulatory status|Declared/, 'declarations never mix with registry facts');
  assert.match(declared, /<h3 id="system-declared-title" class="group-heading">Declared by the developer<\/h3>/);
  assert.ok(declared.includes(DECLARATIONS_NOTE), 'the note says the declarations are not checked');
  assert.match(DECLARATIONS_NOTE, /not checked/);
  assert.match(declared, /<a href="https:\/\/corvessa.example\/docs" target="_blank" rel="noopener noreferrer">corvessa.example\/docs<\/a>/);
  // Our own words never claim a check, a certificate, or an approval.
  const ownWords = html.replace(/Flags skin lesions[^<]*|Not assessed \(demonstration\)/g, '');
  assert.doesNotMatch(ownWords, /certif|approv|verified|validated by|endorse/i);

  // Declarations alone (no entry fields) still show, on their own.
  const onlyDeclared = render(systemDetails(SEED_MODEL, { ...SEED_MODEL.use_cases[0], declarations: DECLARATIONS }, REGISTRY));
  assert.doesNotMatch(onlyDeclared, /About this AI system/);
  assert.match(onlyDeclared, /Declared by the developer/);
});

test('a documentation address that is not http or https is never a link', () => {
  const items = declarationItems({ declared_documentation_url: 'javascript:alert(1)' }).items;
  assert.equal(items[0].href, null);
  assert.equal(declarationItems({ declared_contact: '   ' }), null);
});

test('a population with no results reads as such in the Summary, not as empty counts', () => {
  const counts = { strong: 0, moderate: 0, weak: 0, out_of_scope: 0, no_data: 40 };
  const [only, ...rest] = deriveHighlights({ viewId: 'overall', total: 40, counts, groups: [], population: 'Age 65+' });
  assert.equal(rest.length, 0);
  assert.equal(only.tone, 'no_data');
  assert.equal(only.title, 'No results for Age 65+');
  assert.match(only.text, /read No data/);
  assert.match(only.text, /All patients/);
  const [all] = deriveHighlights({ viewId: 'intended_use', total: 40, counts: { in_scope: 0, partially_in_scope: 0, out_of_scope: 0, no_data: 40 }, population: 'All patients' });
  assert.equal(all.title, 'No results stored');
});

test('the Data Library shows backend-written summaries and problems in the UI vocabulary', () => {
  assert.equal(DATASETS.models.title, 'AI systems & functions');
  assert.equal(
    versionSummary('Models & use cases: 3 rows added, 10 rows changed, 3 models added.'),
    'AI systems & functions: 3 rows added, 10 rows changed, 3 AI systems added.'
  );
  assert.equal(versionSummary('Performance metrics for SynGPT-2.0 / CDSS: 2 rows changed.'), 'Performance metrics for SynGPT-2.0 / CDSS: 2 rows changed.');
  assert.ok(DATASETS.models.templateNotes.lines.some((line) => /Kind \(Model or Product\), AI type, Developer, Release date, Description, and Built on/.test(line)));
  assert.ok(DATASETS.models.templateNotes.lines.some((line) => /Declared columns/.test(line) && /never as checked/.test(line)));

  // Since contract v1.7 the backend writes problems in the UI's words, so the
  // Data Library shows them as sent (the page's own overrides were removed).
  const source = readFileSync(new URL('../frontend/src/features/admin/CheckStep.jsx', import.meta.url), 'utf8');
  assert.match(source, /const \{ message, fix \} = group;/);
});
