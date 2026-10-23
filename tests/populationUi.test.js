// Local populations in the interface and "Your defaults" (§10 "I4 personalization"; CONTRACT.md §21): the atlas URL
// carries the population, reads name it only when it is set (default keys
// stay as they were), every view that uses one names it next to the
// synthetic notice, the profile keeps defaults (the URL wins), the Data
// Library maps its form to the upload, removal needs a note, and a removed
// population falls back to the default prevalence. All data here is
// synthetic and fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { catalogueQuery, chapterQueryKey, combinationQuery, conceptMetricsQuery, filtersKey, metricParams } from '../frontend/src/api/queryKeys.js';
import { isStateUrl, withProfileDefaults } from '../frontend/src/app/profileDefaults.js';
import { atlasHref, atlasSearch, parseStartupParams, readableSearch, STATE_PARAMS } from '../frontend/src/app/startupParams.js';
import { ATLAS_PARAMS, atlasForwardHref, cardAbsoluteUrl, cardAtlasHref } from '../frontend/src/features/catalogue/pageLinks.js';
import { aboutResult, SYNTHETIC_NOTE } from '../frontend/src/features/details/copy/aboutResult.js';
import { buildConceptCardFile } from '../frontend/src/features/details/conceptCardExport.js';
import DeveloperLabel from '../frontend/src/features/label/DeveloperLabel.js';
import { buildLabelModel, labelFileStem } from '../frontend/src/features/label/labelModel.js';
import { adminRouteSearch, parseAdminRoute } from '../frontend/src/features/admin/adminRoute.js';
import { liveAtlasHref, previewHref } from '../frontend/src/features/admin/atlasLinks.js';
import { DATASETS, DATASET_ORDER, datasetTitle } from '../frontend/src/features/admin/datasets.js';
import {
  NEW_POPULATION,
  draftProblems,
  populationChoices,
  populationTarget,
  populationTemplateParams,
  populationUploadFields,
  shownPopulationChoice,
  suggestPopulationId,
  withoutRemoved
} from '../frontend/src/features/admin/populations.js';
import { describeProblem } from '../frontend/src/features/admin/problems.js';
import { noteIsReady } from '../frontend/src/features/admin/records.js';
import { adminHref, DATASET_TITLES } from '../frontend/src/features/preview/previewModel.js';
import {
  LIVE_META_KEY,
  LIVE_MODELS_KEY,
  defaultsFromView,
  defaultsPhrases,
  cardForSystem,
  readLiveMeta,
  readLiveModels
} from '../frontend/src/features/profile/defaultsModel.js';
import {
  createProfileStore,
  hasDefaults,
  importMessage,
  normalizeDefaults,
  parseProfileFile,
  withDefaultsPatch
} from '../frontend/src/features/profile/profile.js';
import {
  checkPopulation,
  populationForReads,
  localPrevalenceNotice,
  localPrevalenceTitle,
  populationFallbackText,
  prevalenceExportText
} from '../frontend/src/shared/localPopulation.js';

const NORTHBRIDGE = Object.freeze({ id: 'northbridge-region', name: 'Northbridge region (fictional)', codes: 310, updated_version: 7 });
const REF = Object.freeze({ id: NORTHBRIDGE.id, name: NORTHBRIDGE.name });
const LENS = { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
const FILTERS = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', ...LENS };

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data
  };
}

function recordingClient() {
  const requests = [];
  const fetchMock = async (input, init = {}) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ url, query: Object.fromEntries(url.searchParams), init });
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  };
  return { client: createDataClient(createApiAdapter({ fetch: fetchMock })), last: () => requests.at(-1) };
}

// ------------------------------------------------------------- URL state

test('the atlas URL carries a local population and round-trips it', () => {
  const state = { version: 'live', model: 'M', useCase: 'U', view: 'overall', lens: LENS, population: NORTHBRIDGE.id, mode: 'focused' };
  const search = readableSearch(atlasSearch(state));
  assert.match(search, /[?&]population=northbridge-region(&|$)/);
  assert.equal(parseStartupParams(search).population, NORTHBRIDGE.id);
  assert.equal(parseStartupParams(atlasSearch({ ...state, population: null })).population, null, 'the default stays out of the URL');
  assert.doesNotMatch(atlasSearch({ ...state, population: null }), /population/);
  for (const junk of ['Northbridge', '-x', 'a'.repeat(41), '../etc', 'a b']) {
    assert.equal(parseStartupParams(`?population=${encodeURIComponent(junk)}`).population, null, junk);
  }
  // Old index.html links with a population forward to the atlas.
  assert.ok(ATLAS_PARAMS.includes('population'));
  assert.equal(atlasForwardHref({ search: '?population=northbridge-region' }), './atlas.html?population=northbridge-region');
  // A tile or label read under a local population links to the card with it.
  const tile = { model_version: 'M', use_case: 'U' };
  assert.equal(cardAtlasHref(tile), atlasHref({ model: 'M', useCase: 'U' }));
  assert.match(cardAtlasHref(tile, { population: NORTHBRIDGE.id }), /population=northbridge-region/);
  assert.match(cardAbsoluteUrl(tile, 'http://127.0.0.1:5173/', { population: NORTHBRIDGE.id }), /^http:\/\/127\.0\.0\.1:5173\/atlas\.html\?.*population=northbridge-region/);
});

// ------------------------------------------------------------- reads

test('reads name the population only when one is set; default keys are unchanged', async () => {
  // Default: exactly the keys and params from before populations existed.
  assert.equal(filtersKey(FILTERS), 'SynGPT-2.0|Clinician Facing CDSS|All ages|All sexes|All ethnicities');
  assert.equal('population' in metricParams(FILTERS), false);
  assert.equal(conceptMetricsQuery(FILTERS, '5A11').key, 'concept|SynGPT-2.0|Clinician Facing CDSS|All ages|All sexes|All ethnicities|5A11');
  assert.equal(catalogueQuery({ datasetVersion: '8' }).key, 'catalogue|live|8');
  assert.equal(chapterQueryKey('CH-11', null), 'chapter|CH-11');

  const local = { ...FILTERS, population: NORTHBRIDGE.id };
  assert.notEqual(filtersKey(local), filtersKey(FILTERS));
  assert.equal(metricParams(local).population, NORTHBRIDGE.id);
  assert.notEqual(combinationQuery(local, ['5A11', 'BA00']).key, combinationQuery(FILTERS, ['5A11', 'BA00']).key);
  assert.notEqual(chapterQueryKey('CH-11', NORTHBRIDGE.id), chapterQueryKey('CH-11', null));

  // Through the client: the concept read and its export carry it; default reads do not.
  const { client, last } = recordingClient();
  await conceptMetricsQuery(local, '5A11').fetch(client, {});
  assert.equal(last().query.population, NORTHBRIDGE.id);
  await conceptMetricsQuery(FILTERS, '5A11').fetch(client, {});
  assert.equal('population' in last().query, false);
  await client.exportConcept({ ...local, conceptId: '5A11', audience: 'patient' });
  assert.equal(last().query.population, NORTHBRIDGE.id);
  await client.exportDataset({ model: FILTERS.model, useCase: FILTERS.useCase, population: undefined });
  assert.equal('population' in last().query, false);
});

// ------------------------------------------------------------- naming

test('every view that uses a local population names it, with "synthetic"; default views do not', () => {
  assert.equal(localPrevalenceTitle(REF), 'Local prevalence: Northbridge region (fictional)');
  assert.equal(localPrevalenceTitle(null), null);
  assert.match(localPrevalenceNotice(REF), /Northbridge region \(fictional\).*synthetic/);
  assert.equal(localPrevalenceNotice(null), null);

  // Condition card, About: the population sentence before the synthetic note.
  const concept = { concept_id: 'BA00', name: 'Essential hypertension', level: 2 };
  const row = { provenance: { source: 'condition' } };
  for (const depth of ['plain', 'expert']) {
    const local = aboutResult({ concept, row, depth, population: REF });
    assert.ok(local.some((sentence) => sentence.includes(REF.name) && /synthetic/.test(sentence)), depth);
    assert.equal(local.at(-1), SYNTHETIC_NOTE);
    assert.ok(!aboutResult({ concept, row, depth }).some((sentence) => /local prevalence/i.test(sentence)), `${depth} default`);
    assert.ok(aboutResult({ concept, row: null, depth, population: REF }).some((sentence) => sentence.includes(REF.name)), `${depth} no row`);
  }

  // Condition card exports: JSON names it in its context; the default export is unchanged.
  const conceptExport = {
    exported_at: '2026-10-12T00:00:00Z',
    audience_view: 'patient',
    concept: { code: 'BA00', name: 'Essential hypertension', block: 'BlockL1-BA0', hierarchy: [] },
    context: { model: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS', population: LENS },
    model_card: { overall: { grade: 'B' }, status: { overall: 'strong' }, perf: 0.8, provenance: { source: 'condition' } },
    warnings: [],
    safeguards: [],
    synthetic_data_notice: 'Synthetic demonstration data.',
    population: REF
  };
  const card = buildConceptCardFile(conceptExport);
  assert.deepEqual(card.context.local_population.id, REF.id);
  assert.equal(card.context.local_population.prevalence, prevalenceExportText(REF));
  assert.match(card.context.local_population.prevalence, /Northbridge region \(fictional\).*synthetic/);
  const { population: _ref, ...defaultExport } = conceptExport;
  assert.deepEqual(Object.keys(buildConceptCardFile(defaultExport).context), ['model', 'use_case', 'population', 'shown_for']);

  // Label: a "Prevalence" row and the card link with the population; none for the default.
  const tile = {
    card_id: 'SynGPT-2.0|Clinician Facing CDSS',
    model_version: 'SynGPT-2.0',
    use_case: 'Clinician Facing CDSS',
    system: { display_name: 'SynGPT 2.0', kind: 'model' },
    distribution: { overall: { strong: 1200, moderate: 700, not_validated: 500 } },
    chapters: [],
    last_updated: null,
    declarations: null
  };
  const catalogue = { dataset_version: '8', condition_count: 2400, lens: LENS };
  const localModel = buildLabelModel(tile, { ...catalogue, population: REF }, { pageUrl: 'http://127.0.0.1:5173/' });
  const localMarkup = renderToStaticMarkup(createElement(DeveloperLabel, { model: localModel }));
  assert.match(localMarkup, />Prevalence</);
  const flat = localMarkup.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  assert.ok(flat.includes('Northbridgeregion(fictional),asyntheticlocalset'), 'the label names the population as synthetic');
  assert.match(localModel.cardUrl, /population=northbridge-region/);
  assert.match(localModel.cardUrl, /[?&]view=overall(&|$)/, 'the label link names the view of its figures');
  assert.match(labelFileStem(localModel), /northbridge-region-model-card-v8$/);
  const defaultModel = buildLabelModel(tile, catalogue, { pageUrl: 'http://127.0.0.1:5173/' });
  assert.equal(defaultModel.population, null);
  assert.doesNotMatch(renderToStaticMarkup(createElement(DeveloperLabel, { model: defaultModel })), />Prevalence</);
  assert.doesNotMatch(defaultModel.cardUrl, /population/);
  // A default label's link is atlas state, so a reader with a local-population default opens the default prevalence.
  const opened = withProfileDefaults(parseStartupParams(new URL(defaultModel.cardUrl).search), { population: NORTHBRIDGE.id, depth: 'expert' });
  assert.deepEqual([opened.view, opened.population, opened.depth, opened.appliedDefaults], ['overall', null, null, []]);
});

// ------------------------------------------------------------- fallback

test('a population the data no longer lists falls back to the default, with a notice', () => {
  assert.equal(checkPopulation(null, [NORTHBRIDGE]).status, 'default');
  assert.equal(checkPopulation(NORTHBRIDGE.id, null).status, 'pending', 'reads wait for /meta');
  assert.equal(checkPopulation(NORTHBRIDGE.id, [NORTHBRIDGE]).entry, NORTHBRIDGE);
  // Removed elsewhere: the version watch re-read /meta, and the list lacks it.
  const seen = new Map([[NORTHBRIDGE.id, NORTHBRIDGE.name]]);
  const removed = checkPopulation(NORTHBRIDGE.id, [], seen);
  assert.equal(removed.status, 'dropped');
  assert.deepEqual(removed.dropped, { id: NORTHBRIDGE.id, name: NORTHBRIDGE.name, wasAvailable: true });
  assert.match(populationFallbackText(removed.dropped), /was removed.*default prevalence/);
  // A link naming a population this data never held.
  const unknown = checkPopulation('elsewhere', [NORTHBRIDGE]);
  assert.equal(unknown.dropped.wasAvailable, false);
  assert.match(populationFallbackText(unknown.dropped), /no local prevalence called elsewhere/);
});

test('a dropped population leaves the reads in the same render, never through the last valid filters', () => {
  const seen = new Map([[NORTHBRIDGE.id, NORTHBRIDGE.name]]);
  assert.deepEqual(populationForReads(null, checkPopulation(null, [NORTHBRIDGE])), { population: null, isSendable: true });
  assert.deepEqual(populationForReads(NORTHBRIDGE.id, checkPopulation(NORTHBRIDGE.id, null)), { population: NORTHBRIDGE.id, isSendable: false });
  assert.deepEqual(populationForReads(NORTHBRIDGE.id, checkPopulation(NORTHBRIDGE.id, [NORTHBRIDGE])), { population: NORTHBRIDGE.id, isSendable: true });
  // Removed meanwhile: the reads go on at once with the default prevalence.
  assert.deepEqual(populationForReads(NORTHBRIDGE.id, checkPopulation(NORTHBRIDGE.id, [], seen)), { population: null, isSendable: true });
  // The hook derives its filters from it, and strips a dropped population from the last valid filters too.
  const hook = readFileSync(new URL('../frontend/src/app/useModelSelection.js', import.meta.url), 'utf8');
  assert.match(hook, /populationForReads\(population, populationCheck\)/);
  assert.match(hook, /\.\.\.\(readPopulation \? \{ population: readPopulation \} : \{\}\)/);
  assert.match(hook, /withoutDroppedPopulation\(lastValidFilters\.current, droppedId\)/);
  assert.doesNotMatch(hook, /\.\.\.\(population \? \{ population \} : \{\}\)/, 'the chosen id is never sent unchecked');
});

test('the Data Library opens on a population that is a choice: a stale link or a removed one falls back', () => {
  const COAST = { id: 'coast-fictional', name: 'Coast (fictional)', codes: 12 };
  const choices = populationChoices([NORTHBRIDGE, COAST]);
  const show = (choice, list = choices, options = {}) => shownPopulationChoice(choice, list, { isLoaded: true, ...options });
  assert.equal(show(null), NORTHBRIDGE.id, 'not chosen yet: the first live one');
  assert.equal(show(COAST.id), COAST.id);
  assert.equal(show(NEW_POPULATION), NEW_POPULATION);
  // A stale ?population= link (removed elsewhere, or never there) falls back.
  assert.equal(show('gone-region'), NORTHBRIDGE.id);
  assert.equal(show('gone-region', []), NEW_POPULATION, 'no population left: name a new one');
  // A new population's first upload stays chosen before the staged list is read again.
  assert.equal(show('brand-new', choices, { stagedId: 'brand-new' }), 'brand-new');
  // While /meta loads, the URL's choice waits.
  assert.equal(shownPopulationChoice('gone-region', [], { isLoaded: false }), 'gone-region');
  // A population just removed here is no choice, although /meta still lists it until it is read again.
  const afterRemoval = populationChoices(withoutRemoved([NORTHBRIDGE, COAST], NORTHBRIDGE.id));
  assert.deepEqual(afterRemoval.map((entry) => entry.id), [COAST.id]);
  assert.equal(show(null, afterRemoval), COAST.id);
  assert.equal(show(NORTHBRIDGE.id, afterRemoval), COAST.id);
  assert.deepEqual(withoutRemoved([NORTHBRIDGE], null), [NORTHBRIDGE]);
  assert.equal(withoutRemoved(null, NORTHBRIDGE.id), null);
  // The page uses both.
  const page = readFileSync(new URL('../frontend/src/features/admin/DatasetPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /shownPopulationChoice\(populationState\.choice, choices,/);
  assert.match(page, /setRemovedPopulation\(\{ id: populationChoice, meta: populationMeta\.data \}\)/);
});

test('Your defaults never offers a staged, unpublished population (it reads the live version)', async () => {
  // In a staged preview the atlas's client reads staged:…; the sheet asks for live explicitly.
  const requests = [];
  const fetchMock = async (input) => {
    requests.push(new URL(input, 'http://localhost'));
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  };
  const client = createDataClient(createApiAdapter({ fetch: fetchMock, defaultVersion: 'staged:up-1' }));
  await readLiveMeta(client, {});
  await readLiveModels(client, {});
  // A live read sends no version parameter; the preview's client would send version=staged:up-1.
  assert.deepEqual(requests.map((url) => [url.pathname, url.searchParams.get('version')]), [
    ['/api/v1/meta', null],
    ['/api/v1/models', null]
  ]);
  await client.getMeta({}, {});
  assert.equal(requests.at(-1).searchParams.get('version'), 'staged:up-1', 'the preview client reads staged by default');
  assert.notEqual(LIVE_META_KEY, 'meta', 'its cache key is not the preview’s /meta');
  assert.notEqual(LIVE_MODELS_KEY, 'models');
  // "Use what is on screen" in a population preview does not take the staged population over.
  const filters = { model: 'M', useCase: 'U', age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities', population: 'test-coast' };
  assert.equal(defaultsFromView(filters, null, [NORTHBRIDGE]).population, undefined);
  assert.equal(defaultsFromView({ ...filters, population: NORTHBRIDGE.id }, null, [NORTHBRIDGE]).population, NORTHBRIDGE.id);
  const sheet = readFileSync(new URL('../frontend/src/features/profile/DefaultsSheet.jsx', import.meta.url), 'utf8');
  assert.match(sheet, /useClientQuery\(LIVE_META_KEY, readLiveMeta\)/);
  assert.match(sheet, /defaultsFromView\(view\.filters, view\.depth, populations\)/);
});

// ------------------------------------------------------------- profile

test('profile defaults are validated, persist per browser, and keep old profiles readable', () => {
  assert.deepEqual(normalizeDefaults({ lens: 'x', depth: 'deep', population: 'Not An Id', card: { model: 'M' }, extra: 1 }), {});
  assert.deepEqual(
    normalizeDefaults({ card: { model: 'M', useCase: 'U' }, lens: { age: 'Age 65+', sex: 'All sexes' }, depth: 'expert', population: NORTHBRIDGE.id }),
    { card: { model: 'M', useCase: 'U' }, lens: { age: 'Age 65+' }, depth: 'expert', population: NORTHBRIDGE.id }
  );
  assert.deepEqual(withDefaultsPatch({ depth: 'plain', population: NORTHBRIDGE.id }, { population: null, lens: { age: 'All ages' } }), { depth: 'plain' });

  // An S2 profile (no defaults) still loads; defaults survive a reload.
  const storage = memoryStorage({ 'bmc.profile.v1': JSON.stringify({ version: 1, profile_id: 'p_s2profile01', tracked: ['M|U'], defaults: {} }) });
  const store = createProfileStore({ storage, target: null });
  assert.deepEqual(store.get().tracked, ['M|U']);
  store.setDefaults({ card: { model: 'M', useCase: 'U' }, depth: 'expert', population: NORTHBRIDGE.id });
  const reloaded = createProfileStore({ storage, target: null });
  assert.deepEqual(reloaded.get().defaults, { card: { model: 'M', useCase: 'U' }, depth: 'expert', population: NORTHBRIDGE.id });
  assert.equal(hasDefaults(reloaded.get().defaults), true);
  reloaded.clearDefaults();
  assert.deepEqual(createProfileStore({ storage, target: null }).get().defaults, {});
});

test('the profile export carries the defaults, and an import fills the ones a browser lacks', () => {
  const source = createProfileStore({ storage: memoryStorage(), target: null });
  source.setDefaults({ lens: { age: 'Age 65+' }, population: NORTHBRIDGE.id });
  const file = source.exportFile(new Date('2026-10-12T00:00:00Z'));
  assert.deepEqual(file.defaults, { lens: { age: 'Age 65+' }, population: NORTHBRIDGE.id });
  assert.deepEqual(parseProfileFile(JSON.stringify(file)).defaults, file.defaults);

  const target = createProfileStore({ storage: memoryStorage(), target: null });
  target.setDefaults({ depth: 'plain', population: 'other-place' });
  const result = target.importText(JSON.stringify(file));
  assert.equal(result.ok, true);
  assert.equal(result.defaultsAdded, 1, 'the lens is new; the population was already set here');
  assert.deepEqual(target.get().defaults, { lens: { age: 'Age 65+' }, depth: 'plain', population: 'other-place' });
  assert.match(importMessage(result), /1 default was taken over from the file/);
});

test('defaults apply to entry links only; a shared link means the same for every reader', () => {
  const defaults = { card: { model: 'M', useCase: 'U' }, lens: { age: 'Age 65+' }, depth: 'expert', population: NORTHBRIDGE.id };
  // "Open the atlas" with nothing: everything from the profile.
  const blank = withProfileDefaults(parseStartupParams(''), defaults);
  assert.deepEqual([blank.model, blank.useCase, blank.lens.age, blank.depth, blank.population], ['M', 'U', 'Age 65+', 'expert', NORTHBRIDGE.id]);
  assert.deepEqual(blank.appliedDefaults, ['card', 'lens', 'depth', 'population']);
  // A catalogue tile names only the card: its card wins; lens, depth, and prevalence come from the profile.
  const tile = withProfileDefaults(parseStartupParams('?model=X&use_case=Y'), defaults);
  assert.equal(isStateUrl(parseStartupParams('?model=X&use_case=Y')), false);
  assert.deepEqual([tile.model, tile.useCase, tile.population, tile.depth, tile.lens.age], ['X', 'Y', NORTHBRIDGE.id, 'expert', 'Age 65+']);
  // Any other parameter makes the URL atlas state: it opens exactly what it names, with no default at all.
  const stateLinks = [
    '?model=X&use_case=Y&view=overall',
    '?model=X&use_case=Y&mode=focused',
    '?model=X&use_case=Y&chapter=CH-05',
    '?model=X&use_case=Y&concept=5A11',
    '?model=X&use_case=Y&selected=5A11,GB61',
    '?model=X&use_case=Y&age=Age+0-17',
    '?model=X&use_case=Y&sex=Sex+Female',
    '?model=X&use_case=Y&ethnicity=Ethnicity+Asian',
    '?model=X&use_case=Y&population=elsewhere',
    '?model=X&use_case=Y&depth=plain',
    '?model=X&use_case=Y&version=staged:up-1',
    '?view=safety',
    // A malformed value still says the link carries state.
    '?model=X&use_case=Y&view=colour'
  ];
  for (const search of stateLinks) {
    const parsed = parseStartupParams(search);
    assert.equal(isStateUrl(parsed), true, search);
    const opened = withProfileDefaults(parsed, defaults);
    assert.deepEqual(opened.appliedDefaults, [], search);
    assert.equal(opened.depth, parsed.depth, search);
    assert.equal(opened.population, parsed.population, search);
    assert.deepEqual(opened.lens, parsed.lens, search);
  }
  // Two readers with different defaults open a shared link to the same state.
  const shared = parseStartupParams('?model=X&use_case=Y&view=overall&sex=Sex+Female');
  const other = { lens: { age: 'Age 0-17' }, depth: 'plain', population: 'other-place' };
  const strip = ({ appliedDefaults: _applied, ...state }) => state;
  assert.deepEqual(strip(withProfileDefaults(shared, defaults)), strip(withProfileDefaults(shared, other)));
  assert.deepEqual([withProfileDefaults(shared, defaults).population, withProfileDefaults(shared, defaults).lens.age], [null, null]);
  // A staged preview shows the update as linked.
  const preview = withProfileDefaults(parseStartupParams('?version=staged:up-1'), defaults);
  assert.deepEqual([preview.model, preview.population, preview.appliedDefaults.length], [null, null, 0]);
  // Unknown parameters (tracking, old ones) are not state.
  assert.equal(isStateUrl(parseStartupParams('?utm=x&perf=0.3')), false);
  // The parameters the atlas forwards from index.html are the card plus the state parameters.
  assert.deepEqual([...ATLAS_PARAMS].sort(), ['model', 'use_case', ...STATE_PARAMS].sort());
});

test('"Your defaults" words and "Use what is on screen"', () => {
  const models = [
    { model_version: 'M', display_name: 'Model M', default_use_case: 'V', use_cases: [{ use_case: 'U' }, { use_case: 'V' }] }
  ];
  assert.deepEqual(cardForSystem(models, 'M'), { model: 'M', useCase: 'V' });
  assert.equal(cardForSystem(models, ''), null);
  const defaults = { card: { model: 'M', useCase: 'U' }, lens: { age: 'Age 65+' }, depth: 'expert', population: NORTHBRIDGE.id };
  assert.deepEqual(defaultsPhrases(defaults, { models, populations: [NORTHBRIDGE] }), [
    'Model M, U',
    'Age 65+',
    'Expert depth',
    'Local prevalence: Northbridge region (fictional)'
  ]);
  assert.match(defaultsPhrases({ population: 'gone' }, { populations: [] })[0], /no longer in the data/);
  assert.deepEqual(defaultsFromView({ ...FILTERS, age: 'Age 65+', population: NORTHBRIDGE.id }, 'plain'), {
    card: { model: FILTERS.model, useCase: FILTERS.useCase },
    lens: { age: 'Age 65+' },
    depth: 'plain',
    population: NORTHBRIDGE.id
  });
});

// ------------------------------------------------------------- Data Library

test('the Local populations data set: route, titles, and history', () => {
  assert.equal(DATASET_ORDER.at(-4), 'population', 'Studies, Effects on outcomes, and Local results (v1.13) follow it');
  assert.equal(datasetTitle('population'), 'Local populations', 'History titles population versions, never "All data sets"');
  assert.deepEqual(DATASETS.population.modes, ['replace'], 'population uploads are replace only');
  assert.equal(DATASETS.population.needsPopulation, true);
  assert.match(DATASETS.population.templateNotes.title, /Aggregate data only/);
  assert.equal(DATASET_TITLES.population, 'Local population');
  const route = parseAdminRoute('?set=population&population=northbridge-region');
  assert.deepEqual([route.page, route.population], ['population', NORTHBRIDGE.id]);
  assert.equal(parseAdminRoute('?set=population&population=Bad%20Id').population, null);
  assert.equal(adminRouteSearch({ page: 'population', population: NORTHBRIDGE.id }), '?set=population&population=northbridge-region');
  assert.equal(adminRouteSearch({ page: 'metrics', population: NORTHBRIDGE.id }), '?set=metrics', 'only the population page keeps it');
  // The atlas preview and its way back.
  const upload = { upload_id: 'up-7', kind: 'population', target: { population_id: NORTHBRIDGE.id, population_name: NORTHBRIDGE.name } };
  assert.equal(previewHref(upload), './atlas.html?version=staged%3Aup-7&population=northbridge-region');
  assert.match(previewHref(upload, { kind: 'population', target: { model: 'M', useCase: 'U' }, view: 'overall', conceptId: 'BA00' }), /model=M.*population=northbridge-region/);
  assert.equal(liveAtlasHref('population', { populationId: NORTHBRIDGE.id }), './atlas.html?population=northbridge-region');
  assert.equal(adminHref(upload), './admin.html?set=population&population=northbridge-region');
});

test('the population form maps to the upload: id always, name for a new population only', async () => {
  assert.equal(suggestPopulationId('Northbridge region (fictional)'), 'northbridge-region-fictional');
  assert.equal(suggestPopulationId('  Ålesund – Nord  '), 'alesund-nord');
  assert.deepEqual(draftProblems({ id: 'northbridge-region', name: 'Coastal (fictional)' }, [NORTHBRIDGE.id]).id !== null, true, 'a live id is taken');
  assert.match(draftProblems({ id: 'Bad Id', name: 'x' }).id, /lowercase/);
  assert.match(draftProblems({ id: 'ok', name: 'x'.repeat(81) }).name, /80 characters/);
  assert.deepEqual(draftProblems({ id: 'coast-fictional', name: 'Coast (fictional)' }), { id: null, name: null });

  const staged = { upload_id: 'up-9', status: 'valid', target: { population_id: 'coast-fictional', population_name: 'Coast (fictional)' } };
  const choices = populationChoices([NORTHBRIDGE], [staged]);
  assert.deepEqual(choices.map((entry) => [entry.id, entry.isLive, Boolean(entry.upload)]), [
    [NORTHBRIDGE.id, true, false],
    ['coast-fictional', false, true]
  ]);

  const live = populationTarget({ choice: NORTHBRIDGE.id, draft: { id: '', name: '' } }, choices);
  assert.deepEqual(populationUploadFields(live), { populationId: NORTHBRIDGE.id }, 'a live population keeps its name');
  assert.deepEqual(populationTemplateParams(live), { populationId: NORTHBRIDGE.id }, 'its own list as the filled template');
  const draft = populationTarget({ choice: NEW_POPULATION, draft: { id: 'coast-fictional', name: ' Coast (fictional) ' } }, populationChoices([NORTHBRIDGE]));
  assert.deepEqual(populationUploadFields(draft), { populationId: 'coast-fictional', populationName: 'Coast (fictional)' });
  assert.deepEqual(populationTemplateParams(draft), {}, 'a new population starts from the default tiers');
  assert.equal(populationTarget({ choice: NEW_POPULATION, draft: { id: '', name: 'x' } }, choices), null, 'no upload until the draft is valid');

  // The form fields reach the upload request as the contract's names.
  const { client, last } = recordingClient();
  await client.createUpload({ kind: 'population', file: new Blob(['ICD-11 code,Commonness\n']), ...populationUploadFields(draft) });
  const form = last().init.body;
  assert.deepEqual([form.get('kind'), form.get('population_id'), form.get('population_name')], ['population', 'coast-fictional', 'Coast (fictional)']);
  assert.equal(form.get('mode'), null);
  await client.createUpload({ kind: 'population', file: new Blob(['x']), ...populationUploadFields(live) });
  assert.equal(last().init.body.get('population_name'), null);
  assert.equal(client.getTemplateUrl({ kind: 'population', format: 'xlsx', filled: true, ...populationTemplateParams(live) }), '/api/v1/admin/templates/population.xlsx?filled=true&population_id=northbridge-region');
});

test('removing a population needs a change note, sent with the request', async () => {
  assert.equal(noteIsReady(''), false);
  assert.equal(noteIsReady('   '), false);
  assert.equal(noteIsReady('The pilot ended.'), true);
  const { client, last } = recordingClient();
  await client.removePopulation({ populationId: NORTHBRIDGE.id, note: 'The pilot ended.' });
  assert.equal(last().url.pathname, '/api/v1/admin/populations/northbridge-region/remove');
  assert.deepEqual(JSON.parse(last().init.body), { note: 'The pilot ended.' });
  // A population upload's problems speak of its id and name, not a card.
  const problem = describeProblem({ code: 'invalid_parameter', detail: 'population_name is required.' }, { kind: 'population' });
  assert.match(problem.title, /id and name/);
  assert.equal(problem.detail, 'population_name is required.');
  assert.match(describeProblem({ code: 'invalid_parameter' }).title, /AI system and function/, 'other pages keep their words');
  assert.match(describeProblem({ code: 'unknown_population' }).title, /not in the live data/);
});

test('the Population note is true for every card, products included; it is the popover title\'s help', () => {
  const popover = readFileSync(new URL('../frontend/src/features/toolbar/PopulationPopover.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(popover, /Groups without stored results are worked out from related groups/);
  assert.match(popover, /<HelpTip label="About Population">\s*<p>Results for one group of patients\. A wider group without stored results is worked out from its narrower groups; a group with no results reads No data\.<\/p>/);
});
