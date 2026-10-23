// Audit batch 2 (2026-10-14): source-level checks for the fixes that have no
// pure function of their own, and the small helpers that do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchOption } from '../frontend/src/app/cardMatch.js';
import { SITE_PAGES, siteNavItems } from '../frontend/src/design/siteNav.js';

const SRC = fileURLToPath(new URL('../frontend/src/', import.meta.url));
const read = (relative) => readFileSync(`${SRC}${relative}`, 'utf8');

test('one page frame on every page: brand top left to the catalogue, same links, Settings last (A12)', () => {
  assert.deepEqual(SITE_PAGES.map((page) => page.label), ['AI systems', 'Compare', 'Data Library', 'Live interaction']);
  assert.deepEqual(siteNavItems('admin').map((page) => page.isCurrent), [false, false, true, false]);
  const sites = {
    'features/catalogue/CatalogueApp.jsx': /<AppHeader current="catalogue" onOpenSettings=/,
    'app/AtlasApp.jsx': /<AppHeader current="atlas" onOpenSettings=\{openDefaults\}/,
    'features/compare/CompareApp.jsx': /<AppHeader current="compare"/,
    'features/admin/AdminApp.jsx': /<AppHeader current="admin"/,
    'features/plugin/PluginApp.jsx': /<AppHeader current="plugin"/
  };
  for (const [file, pattern] of Object.entries(sites)) {
    const source = read(file);
    assert.match(source, pattern, file);
    assert.doesNotMatch(source, /<SiteNav|<BrandMark/, `${file} draws no header of its own`);
  }
  const header = read('design/AppHeader.jsx');
  const order = ['className="app-brand" href={SITE_PAGES[0].href}', 'className="synthetic-badge"', '<SiteNav', 'className="button-plain app-header-settings"'];
  order.reduce((last, part) => {
    const at = header.indexOf(part);
    assert.ok(at > last, part);
    return at;
  }, -1);
  assert.equal(SITE_PAGES[0].id, 'catalogue');
  // The atlas toolbar sits under the header and has no brand or links of its own.
  const toolbar = read('features/toolbar/Toolbar.jsx');
  assert.doesNotMatch(toolbar, /SiteNav|BrandMark|synthetic-badge/);
  // The current page is named, not linked.
  assert.match(read('design/SiteNav.jsx'), /aria-current="page"/);
});

test('the toolbar: views right after the title, worded card actions, no glass, wraps; mode on the ring tile (A10, A11, B9, B13)', () => {
  const responsive = read('styles/responsive.css');
  const compact = responsive.slice(responsive.indexOf('@media (max-width: 1099px)'), responsive.indexOf('@media (max-width: 959px)'));
  assert.doesNotMatch(compact, /\.toolbar-metric \{\s*order:/, 'the view switcher keeps its place after the title');
  const toolbarCss = read('styles/toolbar.css');
  const bar = toolbarCss.slice(toolbarCss.indexOf('.toolbar {'), toolbarCss.indexOf('}', toolbarCss.indexOf('.toolbar {')));
  assert.doesNotMatch(bar, /backdrop-filter/);
  assert.match(bar, /flex-wrap: wrap;/);
  assert.match(read('styles/base.css'), /\.app-shell \{[^}]*grid-template-rows: auto minmax\(0, 1fr\);/);
  const label = read('styles/label.css');
  assert.doesNotMatch(label, /max-width: 1599px\) \{\s*\.toolbar-card-actions/, 'Track and Model card keep their words from 1280px');
  // Below 1280px they are icons, so the toolbar keeps one row from 1100px (audit batch 3); the words stay for assistive tech.
  const iconOnly = label.slice(label.indexOf('@media (max-width: 1279px)'));
  assert.match(iconOnly, /^@media \(max-width: 1279px\) \{[\s\S]*?\.toolbar-card-actions \.track-toggle-text,[\s\S]*?clip: rect\(0 0 0 0\);/);
  assert.doesNotMatch(iconOnly.slice(0, iconOnly.indexOf('@media (max-width: 767px)')), /display: none/, 'hidden visually, not from the accessible name');
  assert.match(label, /max-width: 767px\) \{[\s\S]*?\.toolbar-card-actions \.toolbar-button \{\s*min-width: 44px;\s*min-height: 44px;/);
  assert.doesNotMatch(read('features/toolbar/Toolbar.jsx'), /label="Mode"/);
  // In another classification (contract v1.13) Multimorbidity stays visible, off, with its reason.
  assert.match(read('features/atlas/RingPane.jsx'), /label="Mode" options=\{modeOptions\}/);
  assert.match(read('features/atlas/RingPane.jsx'), /disabled: true, reason: NO_COMBINATIONS_TEXT/);
});

test('the Population button names a local prevalence; its popover offers actions, not dimmed text (A11)', () => {
  const popover = read('features/toolbar/PopulationPopover.jsx');
  assert.match(popover, /toolbar-button-local">, \{shortPopulationName\(local\.name\)\}/);
  assert.match(popover, /className="button-tinted"[\s\S]{0,120}Show all patients/);
  const choices = read('features/toolbar/PrevalenceChoices.jsx');
  assert.match(choices, /className="popover-state" role="status"/);
  assert.doesNotMatch(choices, /disabled=\{isSavedDefault\}/);
});

test('a link names a card loosely; an unknown card is said, not silently replaced (B5)', () => {
  assert.equal(matchOption('Clinician-Facing CDSS', ['Discharge letter generation', 'Clinician Facing CDSS']), 'Clinician Facing CDSS');
  assert.equal(matchOption('clinician facing cdss', ['Clinician Facing CDSS']), 'Clinician Facing CDSS');
  assert.equal(matchOption('Triage', ['Clinician Facing CDSS']), null);
  assert.equal(matchOption('', ['A']), null);
  const app = read('app/AtlasApp.jsx');
  assert.match(app, /This link asked for \$\{asked\}, which this dataset does not hold\. Showing/);
});

test('the full dataset export asks first and states its size (A16)', () => {
  const summary = read('features/summary/SummaryPanel.jsx');
  assert.match(summary, /Download about 1\.3 GB\?/);
  assert.match(summary, /onClick=\{\(\) => setIsConfirming\(true\)\}/);
  assert.doesNotMatch(summary, /onClick=\{datasetExport\.onClick\}/, 'one click never starts 1.3 GB');
});

test('multimorbidity candidates name their mark; the synthetic warning is said once (A19)', () => {
  const panel = read('features/multimorbidity/CombinationPanel.jsx');
  assert.match(panel, /<\/span> \{candidateWord\(status\)\}/);
  assert.match(panel, /warning\.code !== 'multimorbidity_synthetic_demo'/);
  assert.match(panel, /<AloneComparison /);
  assert.match(panel, /disabled=\{!count\}[\s\S]*disabled=\{!count\}/, 'Back and Reset wait for a selection');
  assert.doesNotMatch(read('features/atlas/RingLegend.jsx'), /label="Coloured"/);
});

test('reduced motion is intentional in the atlas bundle; the search jump keeps a held ring (B10)', () => {
  const responsive = read('styles/responsive.css');
  assert.doesNotMatch(responsive, /animation-duration:\s*1ms\s*!important|transition-duration:\s*1ms\s*!important/);
  const rule = responsive.slice(responsive.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(rule, /\.bubble-halo-ping \{\s*animation: halo-hold 1200ms linear 1;/);
  assert.match(rule, /\.ring-host\.is-entering \.ring-canvas/);
});

test('the results sheet is toggled by a worded button, never a drag handle (B12)', () => {
  const app = read('app/AtlasApp.jsx');
  assert.match(app, /className="sheet-grabber"[\s\S]*?\{sheetExpanded \? 'Show less' : 'Show more'\}/);
  assert.doesNotMatch(read('styles/responsive.css'), /\.sheet-grabber::before/);
});

test('ring bubbles say they are selected with aria-current, not aria-pressed (B16)', () => {
  const bubbles = read('features/atlas/RingBubbles.jsx');
  assert.match(bubbles, /'aria-current': isSelected \? 'true' : undefined/);
  assert.doesNotMatch(bubbles, /aria-pressed/);
  // Hovering re-renders only the hover card: the bubble layer is memoized and has no ref callback per bubble (B7).
  assert.match(bubbles, /export const RingBubbles = memo\(/);
  assert.doesNotMatch(bubbles, /ref: \(node\)/);
  assert.doesNotMatch(read('features/atlas/RingView.jsx'), /nodeRefs/);
});
