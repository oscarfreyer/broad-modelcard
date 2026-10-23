// The catalogue landing page (§S2): the
// entry pages and the index → atlas forwarding, the catalogue's URL state,
// and the filter, sort, and tab logic over the loaded tiles (no request).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { atlasSearch, parseStartupParams } from '../frontend/src/app/startupParams.js';
import {
  availableSorts,
  availableTabs,
  distributionParts,
  filterOptions,
  functionsPerSystem,
  hasSafetyData,
  matchesFilters,
  matchesQuery,
  relativeUpdated,
  sameUpdateDay,
  TAB_LABELS,
  NO_STATEMENT_NOTE,
  overviewParts,
  openIncidents,
  SORT_LABELS,
  sortTiles,
  tabTiles,
  visibleTiles
} from '../frontend/src/features/catalogue/catalogueModel.js';
import {
  DEFAULT_SORT,
  DEFAULT_TAB,
  EMPTY_FILTERS,
  FILTER_PARAMS,
  SORTS,
  TABS,
  catalogueSearch,
  defaultSortFor,
  parseCatalogueState
} from '../frontend/src/features/catalogue/catalogueState.js';
import { ATLAS_PARAMS, atlasForwardHref, cardAbsoluteUrl, cardAtlasHref } from '../frontend/src/features/catalogue/pageLinks.js';
import { apiClient, startTestBackend } from './support/backend.js';

const FRONTEND = fileURLToPath(new URL('../frontend/', import.meta.url));

function tile(modelVersion, useCase, { kind = 'model', aiType = 'llm', developer = 'Dev A (fictional)', status = 'ACTIVE', release = null, updated = 1, at = '2026-10-01T00:00:00Z', name = null, safety, overall = { strong: 1 } } = {}) {
  return {
    card_id: `${modelVersion}|${useCase}`,
    model_version: modelVersion,
    use_case: useCase,
    system: { display_name: name ?? modelVersion, kind, ai_type: aiType, developer, status, release_date: release, built_on: [] },
    distribution: { overall },
    chapters: [],
    last_updated: { version: updated, at },
    staged_change: false,
    ...(safety === undefined ? {} : { safety })
  };
}

const TILES = [
  tile('Beta-1', 'Triage', { aiType: 'hybrid', developer: 'Dev B (fictional)', release: '2025-01-01', updated: 3, at: '2026-10-03T00:00:00Z' }),
  tile('Alpha-2', 'Discharge letter generation', { release: '2026-02-01', updated: 2, at: '2026-10-02T00:00:00Z' }),
  tile('Alpha-2', 'Clinician Facing CDSS', { release: '2026-02-01', status: 'EXPERIMENTAL' }),
  tile('Gamma-Product', 'Triage', { kind: 'product', aiType: 'llm', developer: 'Dev C (fictional)' })
];

// ---------------------------------------------------------------- entry pages

test('index.html is the catalogue and atlas.html the unchanged atlas; the build has three pages', () => {
  assert.match(readFileSync(`${FRONTEND}index.html`, 'utf8'), /src="\/src\/catalogueMain\.jsx"/);
  assert.match(readFileSync(`${FRONTEND}atlas.html`, 'utf8'), /src="\/src\/main\.jsx"/);
  const vite = readFileSync(`${FRONTEND}vite.config.js`, 'utf8');
  for (const page of ['index.html', 'atlas.html', 'admin.html']) {
    assert.match(vite, new RegExp(`page\\('${page.replace('.', '\\.')}'\\)`), page);
  }
  // The catalogue forwards before it renders anything.
  const main = readFileSync(`${FRONTEND}src/catalogueMain.jsx`, 'utf8');
  assert.ok(main.indexOf('atlasForwardHref(window.location)') < main.indexOf('createRoot'));
});

test('index.html forwards every atlas parameter to atlas.html with the same query', () => {
  for (const name of ATLAS_PARAMS) {
    const search = `?${name}=x&tab=mine`;
    assert.equal(atlasForwardHref({ search, hash: '' }), `./atlas.html${search}`, name);
  }
  // Old atlas links, with their hash.
  assert.equal(
    atlasForwardHref({ search: '?version=staged:up-1&model=SynGPT-2.0&use_case=CDSS', hash: '#x' }),
    './atlas.html?version=staged:up-1&model=SynGPT-2.0&use_case=CDSS#x'
  );
  // The catalogue's own parameters (and unrelated ones) stay on the catalogue.
  assert.equal(atlasForwardHref({ search: '' }), null);
  assert.equal(atlasForwardHref({ search: '?tab=mine&system=A&function=B&kind=model&ai_type=llm&developer=D&status=ACTIVE&sort=name&preview=staged:x' }), null);
  assert.equal(atlasForwardHref({ search: '?perf=0.1' }), null);
});

test('every parameter the atlas writes into its URL forwards, and none collides with the catalogue', () => {
  const full = atlasSearch({
    version: 'staged:u1',
    model: 'M',
    useCase: 'U',
    view: 'evidence',
    lens: { age: 'Age 65+', sex: 'Sex Female', ethnicity: 'Ethnicity Asian' },
    setting: 'Emergency department',
    population: 'northbridge-region',
    ontology: 'icd10cm',
    mode: 'multimorbidity',
    depth: 'expert',
    chapterId: 'CH-01',
    conceptId: '1A00',
    selectedIds: ['1A00', '1A01']
  });
  const written = [...new URLSearchParams(full).keys()];
  assert.deepEqual([...written].sort(), [...ATLAS_PARAMS].sort(), 'ATLAS_PARAMS lists exactly what the atlas writes');
  const catalogueParams = [...Object.values(FILTER_PARAMS), 'tab', 'sort', 'preview'];
  for (const name of catalogueParams) {
    assert.ok(!ATLAS_PARAMS.includes(name), `${name} is not an atlas parameter`);
  }
});

test('a tile opens its card on atlas.html, and a staged catalogue opens the staged atlas', () => {
  const card = tile('SynGPT-2.0', 'Discharge letter generation');
  const href = cardAtlasHref(card);
  assert.equal(href, './atlas.html?model=SynGPT-2.0&use_case=Discharge+letter+generation');
  const parsed = parseStartupParams(href.slice('./atlas.html'.length));
  assert.equal(parsed.model, 'SynGPT-2.0');
  assert.equal(parsed.useCase, 'Discharge letter generation');
  assert.equal(parseStartupParams(cardAtlasHref(card, { version: 'staged:up-9' }).split('?')[1]).version, 'staged:up-9');
  // The label's link is absolute, always live, and names the view of its figures.
  assert.equal(
    cardAbsoluteUrl(card, 'http://127.0.0.1:5173/?tab=mine'),
    'http://127.0.0.1:5173/atlas.html?model=SynGPT-2.0&use_case=Discharge+letter+generation&view=overall'
  );
});

// ---------------------------------------------------------------- URL state

test('the catalogue URL round-trips tab, filters, sort, and a staged preview; defaults stay out', () => {
  assert.equal(catalogueSearch({}), '');
  assert.equal(catalogueSearch({ tab: DEFAULT_TAB, sort: DEFAULT_SORT, filters: EMPTY_FILTERS }), '');
  const state = {
    tab: TABS.mine,
    sort: SORTS.release,
    query: 'dev a',
    filters: { system: 'Alpha-2', functionName: 'Clinician Facing CDSS', category: 'decision_support', kind: 'model', aiType: 'llm', developer: 'Dev A (fictional)', status: 'EXPERIMENTAL' },
    newest: true,
    version: 'staged:up_1',
    compare: ['Alpha-2|Clinician Facing CDSS', 'Beta-1|CDSS']
  };
  const search = catalogueSearch(state);
  assert.deepEqual(parseCatalogueState(search), state);
  assert.equal(atlasForwardHref({ search }), null, 'a catalogue URL never forwards');
  const defaults = parseCatalogueState('');
  // No sort in the URL: the tab's own default applies until the reader picks one (A8).
  assert.deepEqual(defaults, { tab: 'performance', sort: null, query: '', filters: EMPTY_FILTERS, newest: false, version: 'live', compare: [] });
  // "Newest versions only" (contract v1.14) is off by default and written as newest=1 when on.
  assert.equal(catalogueSearch({ newest: true }), '?newest=1');
  assert.equal(parseCatalogueState('?newest=yes').newest, false);
});

test('a tab never changes the reader’s sort; an unchosen sort follows the tab and stays out of the URL (A8)', () => {
  assert.equal(defaultSortFor(TABS.performance), SORTS.name);
  assert.equal(defaultSortFor(TABS.safety), SORTS.incidents);
  assert.equal(defaultSortFor(TABS.safety, [SORTS.name, SORTS.release]), SORTS.name, 'without safety data there is no incident sort');
  assert.equal(catalogueSearch({ tab: TABS.safety, sort: null }), '?tab=safety');
  assert.equal(catalogueSearch({ tab: TABS.safety, sort: SORTS.incidents }), '?tab=safety', 'the tab default is left out');
  assert.equal(catalogueSearch({ tab: TABS.safety, sort: SORTS.name }), '?tab=safety&sort=name', 'a chosen Name sort on Safety is kept');
  assert.equal(parseCatalogueState('?tab=safety&sort=name').sort, SORTS.name);
  const app = readFileSync(`${FRONTEND}src/features/catalogue/CatalogueApp.jsx`, 'utf8');
  const changeTab = app.slice(app.indexOf('const changeTab'), app.indexOf('const trackChanged'));
  assert.doesNotMatch(changeTab, /setSort/, 'switching tabs leaves the sort alone');
  assert.deepEqual(Object.values(TAB_LABELS), ['Performance', 'Safety', 'My systems']);
});

test('the text search finds a card by AI system, function, or developer, word by word (A9)', () => {
  const card = tile('Vantrel-2.1', 'Emergency department triage', { name: 'Vantrel Triage 2.1', developer: 'Nordlicht Médical (fictional)' });
  assert.ok(matchesQuery(card, ''));
  assert.ok(matchesQuery(card, '  '));
  assert.ok(matchesQuery(card, 'vantrel'));
  assert.ok(matchesQuery(card, 'TRIAGE 2.1'));
  assert.ok(matchesQuery(card, 'emergency'));
  assert.ok(matchesQuery(card, 'medical nord'), 'accents and word order do not matter');
  assert.ok(!matchesQuery(card, 'dermatology'));
  assert.deepEqual(
    visibleTiles(TILES, { tab: TABS.performance, filters: EMPTY_FILTERS, query: 'dev b', sort: SORTS.name }).map((t) => t.card_id),
    ['Beta-1|Triage']
  );
  assert.deepEqual(
    visibleTiles(TILES, { tab: TABS.performance, filters: { ...EMPTY_FILTERS, kind: 'product' }, query: 'triage', sort: SORTS.name }).map((t) => t.card_id),
    ['Gamma-Product|Triage'],
    'the search combines with the filters'
  );
  // The AI system has no menu any more: the search finds it, and a set system filter shows as a chip.
  const bar = readFileSync(`${FRONTEND}src/features/catalogue/FilterBar.jsx`, 'utf8');
  assert.match(bar, /Find an AI system, function, or developer/);
  assert.match(bar, /MENU_KEYS = FILTER_KEYS\.filter\(\(key\) => key !== 'system'\)/);
  assert.ok(bar.indexOf('cat-search') < bar.indexOf('MENU_KEYS.map'), 'the search comes first');
});

test('update dates read relative, and a date every tile shares is said once (A26)', () => {
  const now = new Date('2026-10-14T09:00:00Z');
  assert.equal(relativeUpdated('2026-10-14T01:00:00Z', now), 'Updated today');
  assert.equal(relativeUpdated('2026-10-13T23:00:00Z', now), 'Updated yesterday');
  assert.equal(relativeUpdated('2026-10-11T12:00:00Z', now), 'Updated 3 days ago');
  assert.equal(relativeUpdated('2026-08-01T12:00:00Z', now), 'Updated 1 Aug 2026');
  assert.equal(relativeUpdated(null, now), null);
  assert.equal(relativeUpdated('not a date', now), null);
  assert.equal(sameUpdateDay(TILES), false);
  assert.equal(sameUpdateDay([TILES[2], TILES[3]]), true);
  assert.equal(sameUpdateDay([TILES[2]]), false, 'one tile has nothing to repeat');
});

test('malformed catalogue parameters are ignored', () => {
  const state = parseCatalogueState('?tab=nope&sort=random&kind=robot&status=gone&ai_type=Not%20A%20Code&preview=live&compare=no-pipe,a|b|c&system=' + 'x'.repeat(201));
  assert.deepEqual(state, { tab: 'performance', sort: null, query: '', filters: EMPTY_FILTERS, newest: false, version: 'live', compare: [] });
  assert.equal(parseCatalogueState('?q=' + 'y'.repeat(300)).query.length, 120, 'a long search is cut, not dropped');
  assert.equal(parseCatalogueState('?status=active').filters.status, 'ACTIVE');
});

// ---------------------------------------------------------------- filters, sorts, tabs

test('filters combine with AND, and every option names its card count', () => {
  const options = filterOptions(TILES);
  assert.deepEqual(options.system.map((o) => [o.value, o.count]), [['Alpha-2', 2], ['Beta-1', 1], ['Gamma-Product', 1]]);
  assert.deepEqual(options.kind.map((o) => o.label), ['Model', 'Product']);
  assert.deepEqual(options.aiType.map((o) => o.label), ['Hybrid', 'Large language model']);
  assert.deepEqual(options.status.map((o) => [o.label, o.count]), [['Active', 3], ['Experimental', 1]]);
  assert.deepEqual(options.functionName.map((o) => o.label), ['Clinician-Facing CDSS', 'Discharge letter generation', 'Triage']);

  const ids = (filters) => visibleTiles(TILES, { tab: TABS.performance, filters: { ...EMPTY_FILTERS, ...filters }, sort: SORTS.name }).map((t) => t.card_id);
  assert.equal(ids({}).length, 4);
  assert.deepEqual(ids({ functionName: 'Triage' }), ['Beta-1|Triage', 'Gamma-Product|Triage']);
  assert.deepEqual(ids({ functionName: 'Triage', kind: 'product' }), ['Gamma-Product|Triage']);
  assert.deepEqual(ids({ functionName: 'Triage', kind: 'product', aiType: 'hybrid' }), []);
  assert.deepEqual(ids({ system: 'Alpha-2', status: 'EXPERIMENTAL' }), ['Alpha-2|Clinician Facing CDSS']);
  assert.deepEqual(ids({ developer: 'Dev A (fictional)', aiType: 'llm' }), ['Alpha-2|Clinician Facing CDSS', 'Alpha-2|Discharge letter generation']);
  // Every single-value filter keeps exactly the cards its option counts.
  for (const [key, choices] of Object.entries(options)) {
    for (const choice of choices) {
      assert.equal(TILES.filter((t) => matchesFilters(t, { ...EMPTY_FILTERS, [key]: choice.value })).length, choice.count, `${key}=${choice.value}`);
    }
  }
  assert.deepEqual(Object.fromEntries(functionsPerSystem(TILES)), { 'Beta-1': 1, 'Alpha-2': 2, 'Gamma-Product': 1 });
});

test('filter counts are faceted: a choice counts what it would show with the other filters, so a dead end reads (0) (S8a)', () => {
  const faceted = filterOptions(TILES, { ...EMPTY_FILTERS, functionName: 'Triage' });
  // With Triage set, Model and Product count only Triage cards.
  assert.deepEqual(faceted.kind.map((o) => [o.value, o.count]), [['model', 1], ['product', 1]]);
  // A filter's own choices ignore its own value, so another function can still be picked.
  assert.deepEqual(faceted.functionName.map((o) => [o.label, o.count]), [['Clinician-Facing CDSS', 1], ['Discharge letter generation', 1], ['Triage', 2]]);
  // Every value stays listed; the combinations that match nothing count 0.
  const product = filterOptions(TILES, { ...EMPTY_FILTERS, kind: 'product' });
  assert.equal(product.functionName.find((o) => o.label === 'Discharge letter generation').count, 0);
  for (const [key, choices] of Object.entries(product)) {
    for (const choice of choices) {
      const shown = visibleTiles(TILES, { tab: TABS.performance, filters: { ...EMPTY_FILTERS, kind: 'product', [key]: choice.value }, sort: SORTS.name });
      assert.equal(shown.length, choice.count, `${key}=${choice.value}`);
    }
  }
  // Without filters the counts are the plain ones; My systems counts its own cards.
  assert.deepEqual(filterOptions(TILES), filterOptions(TILES, null));
  assert.deepEqual(tabTiles(TILES, { tab: TABS.mine, tracked: ['Beta-1|Triage'] }).map((t) => t.card_id), ['Beta-1|Triage']);
  assert.equal(SORT_LABELS[SORTS.incidents], 'Most open incidents', 'short enough for the sort pill');
});

test('a tile leads with its snapshot, at least 1.5× the old 116 px, and one line of counts (T4, E12)', () => {
  const tileSource = readFileSync(`${FRONTEND}src/features/catalogue/CatalogueTile.jsx`, 'utf8');
  const css = readFileSync(`${FRONTEND}src/styles/catalogue.css`, 'utf8');
  // The snapshot follows the tab: Safety marks where incidents are, else the Overview marks.
  assert.match(tileSource, /mode=\{isSafety \? SNAPSHOT_MODES\.safety : SNAPSHOT_MODES\.overview\}/);
  assert.match(tileSource, /hasIntendedUse=\{hasIntendedUse\}/);
  assert.match(tileSource, /const hasIntendedUse = hasIntendedUseStatement\(tile\);/);
  // The tags sit under the function name, so the name has the tile's full width (A5).
  assert.ok(tileSource.indexOf('cat-tile-function') < tileSource.indexOf('cat-tile-tags'));
  assert.doesNotMatch(css, /\.cat-tile-tags \{[^}]*max-width: 50%/);
  // "No intended-use statement" is a neutral tag, not a count (A26).
  assert.match(tileSource, /<span className="kind-tag is-neutral">\{NO_STATEMENT_NOTE\}<\/span>/);
  const size = Number(css.match(/\.cat-tile \.card-snapshot,\s*\.cat-skeleton-ring \{\s*width: min\(100%, (\d+)px\)/)[1]);
  assert.ok(size >= 174, `snapshot ${size}px`);
  // The unexplained distribution bar is gone, and so are the facts (they are on the atlas and the model card).
  assert.doesNotMatch(tileSource, /StatusStrip|cat-tile-meta|Built on|releaseText|aiTypeLabel/);
  assert.equal((tileSource.match(/className="cat-tile-line/g) || []).length, 2, 'one line component per tab (Overview, Safety)');
  // The model card, never "Label".
  assert.match(tileSource, />\s*Model card\s*</);
  assert.doesNotMatch(tileSource, />\s*Label\s*</);
});

test('the Overview counts use one missing state and say "No intended-use statement" where scope would be counted (D5, D8)', () => {
  const counts = { strong: 4, moderate: 192, weak: 2025, out_of_scope: 0, no_data: 179 };
  assert.deepEqual(overviewParts(counts, { hasIntendedUse: false }), [['strong', 4], ['moderate', 192], ['weak', 2025], ['no_data', 179]]);
  assert.deepEqual(overviewParts({ strong: 13, moderate: 1, out_of_scope: 2386 }), [['strong', 13], ['moderate', 1], ['out_of_scope', 2386]]);
  assert.deepEqual(overviewParts({ strong: 1, out_of_scope: 5 }, { hasIntendedUse: false }), [['strong', 1]]);
  assert.equal(NO_STATEMENT_NOTE, 'No intended-use statement');
});

test('the four sorts order the cards; ties fall back to the name, missing dates last', () => {
  const order = (sort, tiles = TILES) => sortTiles(tiles, sort).map((t) => t.card_id);
  assert.deepEqual(order(SORTS.name), ['Alpha-2|Clinician Facing CDSS', 'Alpha-2|Discharge letter generation', 'Beta-1|Triage', 'Gamma-Product|Triage']);
  assert.deepEqual(order(SORTS.release), ['Alpha-2|Clinician Facing CDSS', 'Alpha-2|Discharge letter generation', 'Beta-1|Triage', 'Gamma-Product|Triage']);
  assert.deepEqual(order(SORTS.updated), ['Beta-1|Triage', 'Alpha-2|Discharge letter generation', 'Alpha-2|Clinician Facing CDSS', 'Gamma-Product|Triage']);
  const withSafety = [
    tile('A', 'F', { safety: { serious: 0, caution: 3, open: 3, mitigated: 0, closed: 0 } }),
    tile('B', 'F', { safety: { serious: 1, caution: 0, open: 1, mitigated: 0, closed: 0 } }),
    tile('C', 'F', { safety: { serious: 0, caution: 0, open: 0, mitigated: 2, closed: 1 } }),
    tile('D', 'F', { safety: { serious: 1, caution: 2, open: 3, mitigated: 0, closed: 0 } })
  ];
  assert.deepEqual(order(SORTS.incidents, withSafety), ['D|F', 'B|F', 'A|F', 'C|F']);
  // Sorting copies; the loaded tiles keep their registry order.
  assert.equal(TILES[0].card_id, 'Beta-1|Triage');
});

test('the Safety tab and sort stay hidden until tiles carry safety counts', () => {
  assert.equal(hasSafetyData(TILES), false);
  assert.deepEqual(availableTabs(TILES), [TABS.performance, TABS.mine]);
  assert.ok(!availableSorts(TILES).includes(SORTS.incidents));
  // The v1.7 tile shape (CONTRACT.md §17): open counts by severity, all incidents by status.
  const later = [tile('A', 'F', { safety: { serious: 2, caution: 1, open: 3, mitigated: 1, closed: 3 } })];
  assert.equal(hasSafetyData(later), true);
  assert.deepEqual(availableTabs(later), [TABS.performance, TABS.safety, TABS.mine]);
  assert.ok(availableSorts(later).includes(SORTS.incidents));
  assert.deepEqual(openIncidents(later[0]), { serious: 2, caution: 1, open: 3, mitigated: 1, closed: 3 });
  assert.equal(openIncidents(TILES[0]), null);
});

test('My systems shows the tracked cards only, with the filters on top', () => {
  const tracked = new Set(['Alpha-2|Clinician Facing CDSS', 'Gamma-Product|Triage', 'Gone|Removed']);
  const mine = visibleTiles(TILES, { tab: TABS.mine, filters: EMPTY_FILTERS, sort: SORTS.name, tracked });
  assert.deepEqual(mine.map((t) => t.card_id), ['Alpha-2|Clinician Facing CDSS', 'Gamma-Product|Triage']);
  const filtered = visibleTiles(TILES, { tab: TABS.mine, filters: { ...EMPTY_FILTERS, kind: 'product' }, sort: SORTS.name, tracked });
  assert.deepEqual(filtered.map((t) => t.card_id), ['Gamma-Product|Triage']);
  assert.deepEqual(visibleTiles(TILES, { tab: TABS.mine, filters: EMPTY_FILTERS, sort: SORTS.name, tracked: [] }), []);
});

test('the distribution leads with the non-zero statuses in display order', () => {
  assert.deepEqual(distributionParts({ strong: 2, moderate: 0, weak: 1, not_validated: 0, out_of_scope: 3, no_data: 0 }), [
    ['strong', 2],
    ['weak', 1],
    ['out_of_scope', 3]
  ]);
});

// ---------------------------------------------------------------- real catalogue

let backend;
before(async () => {
  backend = await startTestBackend();
});
after(() => backend?.stop());

test('on the real catalogue, filter options cover every tile and each option keeps exactly its cards', async () => {
  const catalogue = await apiClient(backend.origin).getCatalogue();
  const options = filterOptions(catalogue.tiles);
  for (const [key, choices] of Object.entries(options)) {
    const covered = choices.reduce((sum, choice) => sum + choice.count, 0);
    // Optional entry fields (AI type, developer) may be missing on seed entries.
    assert.ok(covered <= catalogue.tiles.length, key);
    for (const choice of choices) {
      const shown = visibleTiles(catalogue.tiles, { tab: TABS.performance, filters: { ...EMPTY_FILTERS, [key]: choice.value }, sort: SORTS.name });
      assert.equal(shown.length, choice.count, `${key}=${choice.value}`);
    }
  }
  assert.equal(options.system.reduce((sum, choice) => sum + choice.count, 0), catalogue.tiles.length);
  assert.equal(options.functionName.reduce((sum, choice) => sum + choice.count, 0), catalogue.tiles.length);
  for (const sort of availableSorts(catalogue.tiles)) {
    assert.equal(sortTiles(catalogue.tiles, sort).length, catalogue.tiles.length, sort);
  }
});

test('a filtered catalogue says how many cards it shows, in a live region (S8 testing pass)', () => {
  const app = readFileSync(new URL('../frontend/src/features/catalogue/CatalogueApp.jsx', import.meta.url), 'utf8');
  assert.match(app, /<p className="cat-result-count" role="status">\s*\{isNarrowed \? `Showing \$\{shown\.length\} of \$\{inTabCount\} \$\{inTabCount === 1 \? 'card' : 'cards'\}` : ''\}/);
});

test('the live interaction page shows functions in their display wording (S8 testing pass)', async () => {
  const { displayUseCase } = await import('../frontend/src/shared/format.js');
  assert.equal(displayUseCase('Clinician Facing CDSS'), 'Clinician-Facing CDSS');
  const page = readFileSync(new URL('../frontend/src/features/plugin/PluginApp.jsx', import.meta.url), 'utf8');
  assert.match(page, /<option key=\{name\} value=\{name\}>\s*\{displayUseCase\(name\)\}/, 'the Function select');
  assert.match(page, /<p className="plg-output-function">\{displayUseCase\(current\.useCase\)\}<\/p>/, 'the simulated host header');
});

test('the live interaction page has one scroll, and the host output stays beside the panel (A34)', () => {
  const css = readFileSync(`${FRONTEND}src/styles/plugin.css`, 'utf8');
  const setup = css.match(/\.plg-setup \{[^}]*\}/)[0];
  assert.doesNotMatch(setup, /overflow|max-height|position: sticky/, 'the Case column has no scroll box of its own');
  assert.match(css, /\.plg-host \{[^}]*overflow: clip;/, 'clip keeps sticky working inside the host window');
  assert.match(css, /\.plg-output \{\s*position: sticky;/);
});
