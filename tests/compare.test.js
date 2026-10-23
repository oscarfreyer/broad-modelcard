// The comparison page (contract v1.13, CONTRACT.md §25):
// its URL state, the card limits of the picker and the catalogue, the words
// of every reason and the "Not directly comparable" line, the table's filter
// and sort, the links into the atlas, the data client's getComparison over a
// mocked fetch, and the whole read on the real backend. All data is synthetic.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { parseStartupParams } from '../frontend/src/app/startupParams.js';
import ComparisonFlag from '../frontend/src/features/compare/ComparisonFlag.js';
import {
  NOT_COMPARABLE,
  REASON_RULES,
  REASON_WORDS,
  reasonText,
  resultContext,
  rowOnlyReasons,
  whoWords
} from '../frontend/src/features/compare/compareCopy.js';
import { defaultDepth } from '../frontend/src/app/profileDefaults.js';
import { byDifference, cardAtlasHref, cardNames, cellAtlasHref, cellMark, shownCode, showCounts, showOptions, singledOut, tableEntries } from '../frontend/src/features/compare/compareModel.js';
import {
  MAX_CARDS,
  MIN_CARDS,
  SHOW,
  SORTS,
  addCard,
  compareHref,
  compareSearch,
  isCardId,
  isComparable,
  parseCompareState,
  removeCard,
  urlDepth
} from '../frontend/src/features/compare/compareState.js';
import { catalogueSearch, parseCatalogueState } from '../frontend/src/features/catalogue/catalogueState.js';
import { atlasForwardHref } from '../frontend/src/features/catalogue/pageLinks.js';
import { SITE_PAGES, siteNavItems } from '../frontend/src/design/siteNav.js';
import { schemaErrors } from './support/openapiSchema.js';
import { apiClient, copyStore, startTestBackend } from './support/backend.js';

const openapi = JSON.parse(readFileSync(new URL('../backend/openapi.json', import.meta.url), 'utf8'));
const REASON_CODES = openapi.components.schemas.ComparisonReasonCode.enum;

const SYN = 'SynGPT-2.0|Clinician Facing CDSS';
const ICU = 'ICU_GPT-1.0|CDSS';
const RAD = 'radAIology-1|Radiology image analysis';
const VANTREL = 'Vantrel-Triage-2.1|Emergency department triage';

// ------------------------------------------------------------------ URL state

test('the comparison URL round-trips cards, chapter, lens, population, classification, filter, and sort', () => {
  const state = {
    cards: [SYN, VANTREL, ICU],
    chapterId: 'MONDO:0005066',
    lens: { age: 'Age 65+', sex: 'All sexes', ethnicity: 'Ethnicity Asian' },
    setting: 'Intensive care',
    population: 'northbridge-region',
    ontology: 'mondo',
    show: SHOW.flagged,
    sort: SORTS.difference,
    depth: 'expert',
    view: 'performance'
  };
  const search = compareSearch(state);
  assert.deepEqual(parseCompareState(search), state);
  // Legible when shared: pipes, commas, and colons stay as they are.
  assert.match(search, /cards=SynGPT-2\.0\|Clinician\+Facing\+CDSS,Vantrel/);
  assert.match(search, /chapter=MONDO:0005066/);
  assert.equal(compareHref({ cards: [SYN, ICU] }), `./compare.html?cards=${SYN.replace(/ /g, '+')},${ICU}`);
  // Defaults stay out of the URL.
  assert.equal(compareSearch({}), '');
  assert.equal(compareSearch({ cards: [], show: SHOW.all, sort: SORTS.atlas, ontology: 'icd11' }), '');
});

test('malformed comparison parameters are ignored', () => {
  const state = parseCompareState(`?cards=no-pipe,a|b|c,${SYN},${SYN},|x,${ICU},${RAD},${VANTREL},extra|card&chapter=bad id&population=Not An Id&ontology=Not An Id&show=sometimes&sort=random`);
  assert.deepEqual(state.cards, [SYN, ICU, RAD, VANTREL], 'valid, distinct, at most four');
  assert.equal(state.chapterId, null);
  assert.equal(state.population, null);
  assert.equal(state.ontology, null);
  assert.equal(state.show, SHOW.all);
  assert.equal(state.sort, SORTS.atlas);
  assert.deepEqual(state.lens, { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' });
  assert.equal(parseCompareState('?ontology=icd11').ontology, null, 'ICD-11 is the default');
  assert.ok(isCardId(SYN) && !isCardId('a|b|c') && !isCardId('a|') && !isCardId('x,y|z'));
});

test('the picker holds two to four distinct cards and says why it refuses', () => {
  assert.equal(MIN_CARDS, 2);
  assert.equal(MAX_CARDS, 4);
  let cards = [];
  for (const id of [SYN, ICU, RAD, VANTREL]) {
    const result = addCard(cards, id);
    assert.equal(result.refused, null);
    cards = result.cards;
  }
  assert.deepEqual(addCard(cards, 'MediCore-2.5|Discharge letter generation'), { cards, refused: 'full' });
  assert.deepEqual(addCard([SYN], SYN), { cards: [SYN], refused: 'duplicate' });
  assert.deepEqual(addCard([SYN], 'nope'), { cards: [SYN], refused: 'invalid' });
  assert.deepEqual(removeCard(cards, ICU), [SYN, RAD, VANTREL]);
  assert.ok(!isComparable([SYN]) && isComparable([SYN, ICU]) && isComparable(cards));
});

test('the catalogue keeps its Compare choice in its URL, never as an atlas parameter', () => {
  const search = catalogueSearch({ compare: [SYN, ICU] });
  assert.deepEqual(parseCatalogueState(search).compare, [SYN, ICU]);
  assert.equal(atlasForwardHref({ search }), null, 'a catalogue URL with a choice stays on the catalogue');
});

test('Compare is in the shared navigation, also in the static build (R7)', () => {
  assert.deepEqual(
    SITE_PAGES.map((page) => page.id),
    ['catalogue', 'compare', 'admin', 'plugin']
  );
  assert.equal(SITE_PAGES.find((page) => page.id === 'compare').href, './compare.html');
  assert.ok(siteNavItems('compare', { isStatic: false }).find((page) => page.id === 'compare').isCurrent);
  assert.ok(siteNavItems('catalogue', { isStatic: true }).some((page) => page.id === 'compare'));
  assert.ok(!siteNavItems('catalogue', { isStatic: true }).some((page) => page.id === 'admin' || page.id === 'plugin'));
});

// ---------------------------------------------------------------- the words

const NAMES = new Map([
  [SYN, 'SynGPT-2.0'],
  [ICU, 'ICU_GPT-1.0'],
  [RAD, 'radAIology-1'],
  [VANTREL, 'Vantrel Triage 2.1']
]);

test('every reason code of the contract has its words and its rule', () => {
  assert.deepEqual(Object.keys(REASON_WORDS).sort(), [...REASON_CODES].sort());
  assert.deepEqual(Object.keys(REASON_RULES).sort(), [...REASON_CODES].sort());
  for (const code of REASON_CODES) {
    for (const cards of [[SYN], [SYN, ICU], [SYN, ICU, RAD], [SYN, ICU, RAD, VANTREL]]) {
      const text = reasonText({ code, cards }, NAMES, 4);
      assert.ok(text && !text.includes('undefined') && !text.includes(code), `${code}: ${text}`);
    }
  }
  assert.equal(reasonText({ code: 'function_category_differs', cards: [VANTREL] }, NAMES, 3), 'different task: Vantrel Triage 2.1 has another function category');
  assert.equal(
    reasonText({ code: 'function_category_differs', cards: [VANTREL, RAD] }, NAMES, 4),
    'different task: Vantrel Triage 2.1 and radAIology-1 have another function category'
  );
  assert.equal(reasonText({ code: 'population_differs', cards: [VANTREL] }, NAMES, 2), 'different population: Vantrel Triage 2.1 has no data for this group or setting');
  assert.equal(reasonText({ code: 'no_result', cards: [SYN, ICU] }, NAMES, 2), 'no card has a result');
  assert.equal(reasonText({ code: 'no_result', cards: [ICU, RAD, VANTREL] }, NAMES, 4), 'no result from 3 cards');
  assert.equal(reasonText({ code: 'design_differs', cards: [RAD] }, NAMES, 3), 'different study design: radAIology-1');
  assert.deepEqual(whoWords([SYN, ICU], NAMES, 2), { who: 'every card', all: true, one: true });
});

test('a flagged row says "Not directly comparable" with its own reasons; card-level ones are said once', () => {
  const cardReasons = [
    { code: 'function_category_differs', cards: [VANTREL] },
    { code: 'population_differs', cards: [VANTREL] }
  ];
  const row = {
    concept_id: 'CH-02',
    comparable: false,
    reasons: [
      ...cardReasons,
      { code: 'no_result', cards: [VANTREL] },
      { code: 'out_of_scope', cards: [RAD] },
      { code: 'design_differs', cards: [RAD] }
    ]
  };
  const html = renderToStaticMarkup(h(ComparisonFlag, { row, cardReasons, names: NAMES, cardCount: 3 }));
  assert.match(html, new RegExp(`<p class="cmp-flag"><span class="cmp-flag-title">${NOT_COMPARABLE}:</span>`));
  assert.match(html, /outside the intended use of radAIology-1; different study design: radAIology-1<\/p>$/);
  assert.doesNotMatch(html, /different task|different population|no result from Vantrel/, 'said once above the table');
  // Only the card-level reasons: nothing under the name.
  assert.equal(renderToStaticMarkup(h(ComparisonFlag, { row: { ...row, reasons: cardReasons }, cardReasons, names: NAMES, cardCount: 3 })), '');
  assert.deepEqual(rowOnlyReasons(row, cardReasons).map((reason) => reason.code), ['out_of_scope', 'design_differs']);
  // A reason about one card singles it out; one about every card singles none out.
  assert.ok(singledOut(rowOnlyReasons(row, cardReasons), RAD, 3));
  assert.ok(!singledOut([{ code: 'no_mapping', cards: [SYN, ICU, RAD] }], SYN, 3));
});

test('the results name the lens, population, and classification (D10)', () => {
  const allPatients = { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
  assert.equal(resultContext({ lens: allPatients }), 'All patients, default prevalence'); // the shared formatter (R3): ICD-11 is not named
  assert.equal(resultContext({ lens: allPatients, ontology: { id: 'icd11', name: 'ICD-11' } }), 'All patients, default prevalence');
  assert.equal(
    resultContext({ lens: { ...allPatients, age: 'Age 65+', sex: 'Sex Female' }, population: { id: 'northbridge-region', name: 'Northbridge region (fictional)' }, ontology: { id: 'mondo', name: 'MONDO' } }),
    'Age 65+, Female, Northbridge region (fictional), MONDO'
  );
});

// ----------------------------------------------------------------- the table

const cell = (status, perf = null) => ({ status, perf, ci_low: null, ci_high: null });
const ROWS = [
  { concept_id: 'B1', level: 1, comparable: true, perf_spread: 0.05, reasons: [], cells: [cell('strong', 0.9), cell('strong', 0.85)] },
  { concept_id: 'C1', level: 2, parent_id: 'B1', comparable: false, perf_spread: 0.2, reasons: [{ code: 'design_differs', cards: [ICU] }], cells: [cell('strong', 0.9), cell('weak', 0.7)] },
  { concept_id: 'C2', level: 2, parent_id: 'B1', comparable: true, perf_spread: 0.01, reasons: [], cells: [cell('strong', 0.9), cell('strong', 0.89)] },
  { concept_id: 'B2', level: 1, comparable: false, perf_spread: null, reasons: [{ code: 'no_result', cards: [ICU] }], cells: [cell('strong', 0.9), cell('no_data')] },
  { concept_id: 'C3', level: 2, parent_id: 'B2', comparable: false, perf_spread: null, reasons: [{ code: 'no_result', cards: [ICU] }], cells: [cell('strong', 0.9), cell('no_data')] }
];

test('the filter keeps a subchapter as its conditions\' heading; the sort puts the largest difference first', () => {
  assert.deepEqual(showCounts(ROWS), { all: 5, comparable: 2, flagged: 3 });
  // Reasons that hold on every row are said once; the filter splits the rows by their own reasons.
  const cardReasons = [{ code: 'function_category_differs', cards: [ICU] }];
  const everyRow = ROWS.map((row) => ({ ...row, comparable: false, reasons: [...cardReasons, ...row.reasons] }));
  assert.deepEqual(showCounts(everyRow, cardReasons), { all: 5, comparable: 2, flagged: 3 });
  // With a card-level reason no row is plainly comparable: the filter names its counts as row flags.
  const labels = (options) => options.map((option) => option.label);
  assert.deepEqual(labels(showOptions(showCounts(ROWS))), ['All 5', 'Not flagged 2', 'Flagged 3']);
  assert.deepEqual(labels(showOptions(showCounts(everyRow, cardReasons), cardReasons)), ['All 5', 'No row flag 2', 'Row flag 3']);
  assert.deepEqual(showOptions(showCounts(ROWS)).map((option) => option.value), [SHOW.all, SHOW.comparable, SHOW.flagged]);
  const page = readFileSync(new URL('../frontend/src/features/compare/CompareApp.jsx', import.meta.url), 'utf8');
  assert.match(page, /options=\{showOptions\(counts, cardReasons\)\}/);
  assert.doesNotMatch(page, /`Not flagged \$\{/, 'the page takes its filter labels from showOptions');
  assert.deepEqual(
    tableEntries(everyRow, { scope: 'chapter', show: SHOW.comparable, cardReasons }).map((entry) => entry.row.concept_id),
    ['B1', 'C2']
  );
  const ids = (entries) => entries.map((entry) => `${entry.row.concept_id}${entry.depth ? '>' : ''}${entry.isContext ? '*' : ''}`);
  assert.deepEqual(ids(tableEntries(ROWS, { scope: 'chapter' })), ['B1', 'C1>', 'C2>', 'B2', 'C3>']);
  assert.deepEqual(ids(tableEntries(ROWS, { scope: 'chapter', show: SHOW.flagged })), ['B1*', 'C1>', 'B2', 'C3>']);
  assert.deepEqual(ids(tableEntries(ROWS, { scope: 'chapter', show: SHOW.comparable })), ['B1', 'C2>']);
  assert.deepEqual(ids(tableEntries(ROWS, { scope: 'chapter', sort: SORTS.difference })), ['C1', 'B1', 'C2', 'B2', 'C3']);
  assert.deepEqual(byDifference(ROWS).map((row) => row.perf_spread), [0.2, 0.05, 0.01, null, null]);
  assert.deepEqual(ids(tableEntries(ROWS.filter((row) => row.level === 1), { scope: 'atlas', show: SHOW.flagged })), ['B2']);
});

test('a cell opens its card\'s atlas at the concept, with the comparison\'s lens, population, and classification', () => {
  const context = { lens: { age: 'Age 65+', sex: 'All sexes', ethnicity: 'All ethnicities' }, population: 'northbridge-region', ontology: 'mondo', chapterId: 'MONDO:0005066' };
  const condition = parseStartupParams(cellAtlasHref(SYN, { concept_id: 'MONDO:0005148', level: 2 }, context).replace('./atlas.html', ''));
  assert.equal(condition.model, 'SynGPT-2.0');
  assert.equal(condition.useCase, 'Clinician Facing CDSS');
  assert.equal(condition.chapterId, 'MONDO:0005066');
  assert.equal(condition.conceptId, 'MONDO:0005148');
  assert.equal(condition.population, 'northbridge-region');
  assert.equal(condition.ontology, 'mondo');
  assert.equal(condition.lens.age, 'Age 65+');
  const chapter = parseStartupParams(cellAtlasHref(ICU, { concept_id: 'CH-05', level: 0 }, { ...context, chapterId: null }).replace('./atlas.html', ''));
  assert.equal(chapter.chapterId, 'CH-05');
  assert.equal(chapter.conceptId, 'CH-05');
  assert.equal(condition.depth, null, 'plain depth stays out of the link');
  assert.equal(parseStartupParams(cellAtlasHref(SYN, { concept_id: '5A11', level: 2 }, { ...context, depth: 'expert' }).replace('./atlas.html', '')).depth, 'expert');
});

test('a card column opens that card\'s atlas with the comparison\'s state, at the open chapter', () => {
  const context = { lens: { age: 'Age 65+', sex: 'All sexes', ethnicity: 'All ethnicities' }, population: 'northbridge-region', ontology: null, chapterId: 'CH-05', depth: 'expert' };
  const card = parseStartupParams(cardAtlasHref(ICU, context).replace('./atlas.html', ''));
  assert.deepEqual(
    [card.model, card.useCase, card.chapterId, card.conceptId, card.population, card.lens.age, card.depth],
    ['ICU_GPT-1.0', 'CDSS', 'CH-05', null, 'northbridge-region', 'Age 65+', 'expert']
  );
  assert.equal(parseStartupParams(cardAtlasHref(ICU, { ...context, chapterId: null }).replace('./atlas.html', '')).chapterId, null);
});

test('the comparison keeps an expert depth in its URL and opens a URL without one at the reader\'s default', () => {
  assert.equal(parseCompareState(compareSearch({ cards: [SYN, ICU], depth: 'expert' })).depth, 'expert');
  // Expert always; Plain only for a reader whose own default is Expert, so a reload keeps the choice.
  assert.equal(urlDepth('expert', null), 'expert');
  assert.equal(urlDepth('plain', null), null, 'plain is the default and stays out');
  assert.equal(urlDepth('plain', 'expert'), 'plain');
  assert.equal(parseCompareState(compareSearch({ cards: [SYN, ICU], depth: urlDepth('plain', 'expert') })).depth, 'plain');
  assert.equal(parseCompareState('?depth=deep').depth, null);
  // The view is carried for the links back (Overview stays out), never shown as a table view.
  assert.equal(parseCompareState('?view=safety').view, 'safety');
  assert.equal(parseCompareState('?view=overall').view, null);
  assert.equal(parseCompareState('?view=detailed').view, null);
  assert.equal(parseStartupParams(cellAtlasHref(SYN, { concept_id: '5A11', level: 2 }, { lens: {}, view: 'evidence' }).replace('./atlas.html', '')).view, 'evidence');
  assert.equal(defaultDepth({ audience: 'procurement' }), 'expert', 'the audience preset sets the starting depth');
  assert.equal(defaultDepth({ audience: 'procurement', depth: 'plain' }), 'plain', 'an explicit default wins');
  assert.equal(defaultDepth({}), null);
});

test('marks, codes, and names: No mapping draws its own mark; ICD-11 block ids stay hidden', () => {
  assert.equal(cellMark({ mapping: 'none' }, cell('no_data')), 'no_mapping');
  assert.equal(cellMark({ mapping: 'exact' }, cell('weak', 0.6)), 'weak');
  assert.equal(shownCode({ level: 1, code: 'BlockL1-5A0' }), null);
  assert.equal(shownCode({ level: 1, code: 'E08-E13' }), 'E08-E13');
  assert.equal(shownCode({ level: 2, code: '5A11' }), '5A11');
  assert.equal(shownCode({ level: 0, code: null }), null);
  const names = cardNames([
    { card_id: SYN, display_name: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS' },
    { card_id: 'SynGPT-2.0|Discharge letter generation', display_name: 'SynGPT-2.0', use_case: 'Discharge letter generation' },
    { card_id: ICU, display_name: 'ICU_GPT-1.0', use_case: 'CDSS' }
  ]);
  assert.equal(names.get(SYN), 'SynGPT-2.0 (Clinician-Facing CDSS)', 'two cards of one system are told apart by function, in the UI words');
  assert.equal(names.get(ICU), 'ICU_GPT-1.0');
});

// ------------------------------------------------------------------ the client

test('getComparison sends the cards as one value and the atlas parameters as the map does', async () => {
  const requests = [];
  const fetchMock = async (input) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = createDataClient(createApiAdapter({ fetch: fetchMock }));
  await client.getComparison({ cards: [SYN, ICU] });
  assert.deepEqual(requests.at(-1), { path: '/api/v1/compare', query: { cards: `${SYN},${ICU}` } });
  await client.getComparison(
    { cards: [SYN, ICU], scope: 'chapter', chapterId: 'CH-05', age: 'Age 65+', population: 'northbridge-region', ontology: 'icd11' },
    { version: 'staged:up_1' }
  );
  assert.deepEqual(requests.at(-1).query, {
    cards: `${SYN},${ICU}`,
    scope: 'chapter',
    chapter_id: 'CH-05',
    age: 'Age 65+',
    population: 'northbridge-region',
    version: 'staged:up_1'
  });
  await client.getComparison({ cards: [SYN, ICU], ontology: 'mondo', chapterId: 'ignored-at-atlas-scope' });
  assert.deepEqual(requests.at(-1).query, { cards: `${SYN},${ICU}`, ontology: 'mondo' });
});

// ------------------------------------------------------------ real backend

let store;
let backend;
let client;

before(async () => {
  store = copyStore();
  backend = await startTestBackend({ db: store.path });
  client = apiClient(backend.origin);
});
after(async () => {
  await backend?.stop();
  store?.dispose();
});

test('the backend answers the comparison in the contract\'s shape, and refuses bad requests in words', async () => {
  const meta = await client.getMeta();
  assert.deepEqual(meta.comparison.reasons, REASON_CODES);
  const atlas = await client.getComparison({ cards: [SYN, ICU] });
  assert.deepEqual(schemaErrors('getComparison', atlas), []);
  assert.equal(atlas.rows.length, meta.chapters.length);
  assert.deepEqual(atlas.cards.map((card) => card.card_id), [SYN, ICU]);
  const chapter = await client.getComparison({ cards: [ICU, SYN], scope: 'chapter', chapterId: 'CH-05', age: 'Age 65+' });
  assert.deepEqual(schemaErrors('getComparison', chapter), []);
  assert.equal(chapter.filters.chapter_id, 'CH-05');
  assert.ok(chapter.rows.every((row) => row.cells.length === 2));
  await assert.rejects(client.getComparison({ cards: [SYN] }), (error) => error.status === 422 && error.code === 'invalid_cards');
  await assert.rejects(client.getComparison({ cards: [SYN, 'Nope-1|CDSS'] }), (error) => error.status === 404 && error.code === 'unknown_model');
});
