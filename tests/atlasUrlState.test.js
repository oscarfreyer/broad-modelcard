// Atlas URL state: every parameter survives
// state → URL → state, junk is ignored, and the navigation reducer restores
// the same chapter, concept, and disease set, also against the real backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptMetricsQuery } from '../frontend/src/api/queryKeys.js';
import { ALL_LENS, atlasHref, atlasSearch, parseStartupParams, readableSearch } from '../frontend/src/app/startupParams.js';
import { buildAtlasStructure, canonicalConditionId } from '../frontend/src/features/atlas/atlasStructure.js';
import { UI_MODES, initialNavigationState, navigationReducer } from '../frontend/src/features/navigation/navigationReducer.js';
import { modeParam, navigationParams, restoreFromUrl, uiModeFromParam } from '../frontend/src/features/navigation/urlNavigation.js';
import { apiClient, startTestBackend } from './support/backend.js';

const FULL_STATE = {
  version: 'staged:up-1',
  model: 'SynGPT-2.0',
  useCase: 'Clinician Facing CDSS',
  view: 'intended_use',
  lens: { age: 'Age 65+', sex: 'Female', ethnicity: 'Group B' },
  setting: 'Emergency department',
  population: 'northbridge-region',
  ontology: null,
  mode: 'focused',
  depth: 'expert',
  chapterId: 'CH-05',
  conceptId: '5A11.0',
  selectedIds: []
};

test('every parameter survives state → URL → state', () => {
  const parsed = parseStartupParams(atlasSearch(FULL_STATE));
  assert.deepEqual(parsed, {
    ...FULL_STATE,
    previewUploadId: 'up-1',
    // Every state parameter it carries (the card's model and use_case are not state).
    stateParams: ['version', 'view', 'age', 'sex', 'ethnicity', 'setting', 'population', 'mode', 'depth', 'chapter', 'concept']
  });

  const combination = { ...FULL_STATE, version: 'live', mode: 'multimorbidity', chapterId: null, conceptId: null, selectedIds: ['5A11', '5B81', 'BA00'] };
  const back = parseStartupParams(atlasSearch(combination));
  assert.deepEqual(back.selectedIds, ['5A11', '5B81', 'BA00']);
  // The URL the atlas writes keeps commas and colons legible and parses the same.
  const readable = readableSearch(atlasSearch(combination));
  assert.match(readable, /selected=5A11,5B81,BA00$/);
  assert.match(readableSearch(atlasSearch(FULL_STATE)), /^\?version=staged:up-1&/);
  assert.deepEqual(parseStartupParams(readable), back);
  assert.deepEqual(parseStartupParams(readableSearch(atlasSearch(FULL_STATE))), parsed);
  assert.equal(back.mode, 'multimorbidity');
  assert.equal(back.version, 'live');
});

test('the classification survives state → URL → state, with MONDO ids readable (contract v1.13)', () => {
  const state = { ...FULL_STATE, version: 'live', ontology: 'mondo', chapterId: 'MONDO:0005066', conceptId: 'MONDO:0005015' };
  const search = readableSearch(atlasSearch(state));
  assert.match(search, /&ontology=mondo&/);
  assert.match(search, /chapter=MONDO:0005066&concept=MONDO:0005015$/);
  const parsed = parseStartupParams(search);
  assert.equal(parsed.ontology, 'mondo');
  assert.equal(parsed.chapterId, 'MONDO:0005066');
  assert.equal(parsed.conceptId, 'MONDO:0005015');
  assert.ok(parsed.stateParams.includes('ontology'));
  // ICD-11 is the default: it never appears in the URL, and an explicit icd11 reads as no choice.
  assert.doesNotMatch(atlasSearch({ ...state, ontology: 'icd11' }), /ontology=/);
  assert.equal(parseStartupParams('?ontology=icd11').ontology, null);
  assert.equal(parseStartupParams('?ontology=Not%20An%20Id').ontology, null);
  // ICD-10-CM ids carry dots and dashes.
  assert.equal(parseStartupParams('?ontology=icd10cm&chapter=CM-CH-04&concept=E11.9').conceptId, 'E11.9');
});

test('a switch of classification returns to its atlas with nothing selected (contract v1.13)', () => {
  const inChapter = { ...initialNavigationState, level: 1, chapterId: 'CH-05', selectedConceptId: '5A11', selectedTileId: 'LV2-5A11' };
  const switched = navigationReducer(inChapter, { type: 'switchClassification' });
  assert.deepEqual(
    [switched.level, switched.chapterId, switched.selectedConceptId, switched.selectedTileId, switched.uiMode],
    [0, null, null, null, UI_MODES.focused]
  );
  const combining = { ...initialNavigationState, uiMode: UI_MODES.multimorbidity, multimorbidityIds: ['5A11', 'BA00'] };
  assert.deepEqual(navigationReducer(combining, { type: 'switchClassification' }).multimorbidityIds, []);
});

test('defaults stay out of the URL: live data, "All …" lenses, empty selections', () => {
  const search = atlasSearch({ version: 'live', model: 'M', useCase: 'U', view: 'overall', lens: ALL_LENS, mode: 'focused', depth: null, chapterId: null, conceptId: null, selectedIds: [] });
  assert.equal(search, '?model=M&use_case=U&view=overall&mode=focused');
  assert.deepEqual(parseStartupParams(search).lens, { age: null, sex: null, ethnicity: null });
  assert.equal(atlasSearch({}), '');
  assert.equal(atlasHref({}), './atlas.html');
  assert.equal(atlasSearch({ lens: { age: 'Age 18-39', sex: ALL_LENS.sex } }), '?age=Age+18-39');
});

test('junk is ignored, parameter by parameter', () => {
  const long = 'x'.repeat(201);
  const parsed = parseStartupParams(
    `?version=staged:../x&model=${long}&use_case=%20%20&view=colour&mode=admin&depth=deep&age=${long}` +
      '&chapter=CH%2F05&concept=%3Cscript%3E&selected=5A11,,bad%20id,5A11,5B81'
  );
  assert.equal(parsed.version, 'live');
  assert.equal(parsed.previewUploadId, null);
  assert.equal(parsed.model, null);
  assert.equal(parsed.useCase, null);
  assert.equal(parsed.view, null);
  assert.equal(parsed.mode, null);
  assert.equal(parsed.depth, null);
  assert.equal(parsed.lens.age, null);
  assert.equal(parsed.chapterId, null);
  assert.equal(parsed.conceptId, null);
  assert.deepEqual(parsed.selectedIds, ['5A11', '5B81'], 'empty, invalid, and repeated ids are dropped');
  const many = Array.from({ length: 40 }, (_, index) => `C${index}`).join(',');
  assert.equal(parseStartupParams(`?selected=${many}`).selectedIds.length, 32);
  // Parameters this page does not know (e.g. the perf probe's cache buster) change nothing.
  assert.deepEqual(parseStartupParams('?perf=0.3&utm=x'), parseStartupParams(''));
});

test('URL modes map onto the UI modes and back', () => {
  for (const [param, uiMode] of Object.entries(UI_MODES)) {
    assert.equal(uiModeFromParam(param), uiMode);
    assert.equal(modeParam(uiMode), param);
  }
  assert.equal(uiModeFromParam('simple'), null, 'internal names are not URL values');
  assert.equal(uiModeFromParam('toString'), null);
  assert.equal(uiModeFromParam(null), null);
});

// A small ICD-11 tree: one chapter with a subchapter, a condition, and a subtype
// that only the chapter's own data holds; a second chapter.
const chapter = { concept_id: 'CH-05', level: 0, chapter_id: 'CH-05' };
const otherChapter = { concept_id: 'CH-06', level: 0, chapter_id: 'CH-06' };
const block = { concept_id: 'BLK-05', level: 1, parent_id: 'CH-05', chapter_id: 'CH-05' };
const condition = { concept_id: '5A11', level: 2, parent_id: 'BLK-05', chapter_id: 'CH-05' };
const condition2 = { concept_id: '5B81', level: 2, parent_id: 'BLK-05', chapter_id: 'CH-05' };
const otherCondition = { concept_id: '6A00', level: 2, parent_id: 'BLK-06', chapter_id: 'CH-06' };
const subtype = { concept_id: '5A11.0', level: 2, parent_id: '5A11', chapter_id: 'CH-05' };
const overview = Object.fromEntries([chapter, otherChapter, block, condition, condition2, otherCondition].map((c) => [c.concept_id, c]));
const chapterConcepts = Object.fromEntries([chapter, block, condition, condition2, subtype].map((c) => [c.concept_id, c]));
const topLevel = new Set(['5A11', '5B81', '6A00']);
const canonicalId = (concept) => canonicalConditionId(concept, { topLevelConditionIds: topLevel });
const tile = (concept, prefix) => ({ id: `${prefix}-${concept.concept_id}`, concept_id: concept.concept_id, isEmpty: false });
const run = (actions, state = initialNavigationState) => actions.reduce(navigationReducer, state);

/** state → URL → parsed → restore (waiting for the chapter where needed) → state. */
function roundTrip(state) {
  const parsed = parseStartupParams(atlasSearch(navigationParams(state)));
  const known = { conceptsById: overview, isMultimorbidity: uiModeFromParam(parsed.mode) === UI_MODES.multimorbidity, canonicalId };
  let restored = { ...initialNavigationState, uiMode: uiModeFromParam(parsed.mode) };
  const first = restoreFromUrl(parsed, known);
  restored = navigationReducer(restored, first.action);
  if (first.waitForChapter) {
    assert.equal(restored.chapterId, first.waitForChapter, 'the chapter opens while its concepts load');
    restored = navigationReducer(restored, restoreFromUrl(parsed, { ...known, chapterConceptsById: chapterConcepts }).action);
  }
  return restored;
}

// What is on screen; in multimorbidity mode the disease set draws the selection.
const comparable = (state) => ({
  ...navigationParams(state),
  level: state.level,
  selectedTileId: state.uiMode === UI_MODES.multimorbidity ? null : state.selectedTileId
});

test('the reducer restores every navigation state the URL records', () => {
  const states = {
    atlas: initialNavigationState,
    'subchapter on the atlas': run([{ type: 'navigateToConcept', concept: block }]),
    'chapter open, card closed': run([{ type: 'openChapter', chapterId: 'CH-05' }]),
    'chapter card': run([{ type: 'openChapter', chapterId: 'CH-05' }, { type: 'selectBreadcrumb', depth: 1 }]),
    'subchapter inside its chapter': run([{ type: 'selectTile', tile: tile(block, 'LV1'), concept: block }]),
    'condition in its chapter': run([{ type: 'navigateToConcept', concept: condition }]),
    'subtype from the chapter list': run([{ type: 'navigateToConcept', concept: subtype }]),
    'focused mode again': run([{ type: 'setUiMode', uiMode: UI_MODES.focused }, { type: 'navigateToConcept', concept: condition2 }]),
    'disease set': run([
      { type: 'setUiMode', uiMode: UI_MODES.multimorbidity },
      { type: 'toggleMultimorbidity', canonicalId: '5B81' },
      { type: 'toggleMultimorbidity', canonicalId: '6A00' }
    ])
  };
  for (const [name, state] of Object.entries(states)) {
    const restored = roundTrip(state);
    assert.deepEqual(comparable(restored), comparable(state), name);
    assert.equal(restored.uiMode, state.uiMode, name);
  }
});

test('restoring drops what the data does not know and keeps old links working', () => {
  const known = { conceptsById: overview, isMultimorbidity: false, canonicalId };
  const restore = (search, state = initialNavigationState) =>
    navigationReducer(state, restoreFromUrl(parseStartupParams(search), known).action);

  assert.deepEqual(comparable(restore('?chapter=NOPE&concept=NOPE')), comparable(initialNavigationState));
  // A Data Library link names only the condition: its chapter opens with it selected.
  const legacy = restore('?concept=5A11');
  assert.equal(legacy.chapterId, 'CH-05');
  assert.equal(legacy.selectedTileId, 'LV2-5A11');
  assert.equal(legacy.focus.tileId, 'LV2-5A11', 'the restored bubble is brought into view');
  // A concept from another chapter wins over the chapter.
  assert.equal(restore('?chapter=CH-05&concept=6A00').chapterId, 'CH-06');
  // A subchapter id is not a chapter.
  assert.equal(restore('?chapter=BLK-05').level, 0);
  // A subtype in a chapter that does not have it: the chapter stays open, nothing is selected.
  const waiting = restoreFromUrl(parseStartupParams('?chapter=CH-06&concept=5A11.0'), known);
  assert.equal(waiting.waitForChapter, 'CH-06');
  const settled = navigationReducer(
    navigationReducer(initialNavigationState, waiting.action),
    restoreFromUrl(parseStartupParams('?chapter=CH-06&concept=5A11.0'), { ...known, chapterConceptsById: { 'CH-06': otherChapter } }).action
  );
  assert.equal(settled.chapterId, 'CH-06');
  assert.equal(settled.selectedConceptId, null);

  // Multimorbidity: only canonical top-level conditions join the set; subtypes and blocks do not.
  const mm = { ...initialNavigationState, uiMode: UI_MODES.multimorbidity };
  const set = navigationReducer(mm, restoreFromUrl(parseStartupParams('?mode=multimorbidity&selected=5A11,BLK-05,5A11.0,ZZZ'), { ...known, isMultimorbidity: true }).action);
  assert.deepEqual(set.multimorbidityIds, ['5A11']);
  assert.equal(set.level, 0);
});

test('a condition added to the disease set from search survives the URL round trip', () => {
  // Search can return a subtype the overview does not hold; it joins the set
  // as its top-level condition, so the URL never names an id restore drops.
  const added = run([
    { type: 'setUiMode', uiMode: UI_MODES.multimorbidity },
    { type: 'toggleMultimorbidity', canonicalId: canonicalId(subtype), shouldFocus: true },
    { type: 'toggleMultimorbidity', canonicalId: canonicalId(otherCondition), shouldFocus: true }
  ]);
  assert.deepEqual(added.multimorbidityIds, ['5A11', '6A00']);
  assert.deepEqual(roundTrip(added).multimorbidityIds, ['5A11', '6A00']);
  // Pinned behaviour: an id that is not an overview condition is dropped on
  // restore. The UI cannot add one (see the backend check below); a
  // hand-edited URL that names one loses it.
  const known = { conceptsById: overview, isMultimorbidity: true, canonicalId };
  const handEdited = restoreFromUrl(parseStartupParams('?mode=multimorbidity&selected=5A11.0,5B81'), known).action;
  assert.deepEqual(handEdited.multimorbidityIds, ['5B81']);
});

test('a link to a chapter opens it and brings its first condition into view, as search does', () => {
  const firstConditionByChapterId = { 'CH-05': condition, 'CH-06': otherCondition };
  const known = { conceptsById: overview, isMultimorbidity: false, canonicalId, firstConditionByChapterId };
  const restore = (search) => navigationReducer(initialNavigationState, restoreFromUrl(parseStartupParams(search), known).action);
  const searched = run([{ type: 'navigateToConcept', concept: chapter, firstConditionId: '5A11', shouldFocus: true }]);

  // The Data Library's old-style link, and the URL the atlas writes for the same state.
  for (const search of ['?concept=CH-05', '?chapter=CH-05&concept=CH-05']) {
    const restored = restore(search);
    assert.equal(restored.level, 1, search);
    assert.equal(restored.chapterId, 'CH-05', search);
    assert.equal(restored.selectedConceptId, 'CH-05', `${search}: the chapter card is open`);
    assert.equal(restored.selectedTileId, null, search);
    assert.equal(restored.focus.tileId, 'LV2-5A11', `${search}: the first condition is focused and flashed`);
    assert.deepEqual(comparable(restored), comparable(searched), search);
  }
  // A chapter link wins over a different open chapter, like any concept.
  assert.equal(restore('?chapter=CH-05&concept=CH-06').focus.tileId, 'LV2-6A00');
  // A chapter that has no condition opens without a focus.
  const bare = navigationReducer(initialNavigationState, restoreFromUrl(parseStartupParams('?concept=CH-05'), { ...known, firstConditionByChapterId: {} }).action);
  assert.equal(bare.chapterId, 'CH-05');
  assert.equal(bare.focus.tileId, null);
  // Opening a chapter without selecting it (a click on its bubble) does not focus anything.
  assert.equal(restore('?chapter=CH-05').focus.tileId, null);
});

test('Back from a chapter restores the atlas without touching the disease set outside multimorbidity mode', () => {
  const state = { ...run([{ type: 'navigateToConcept', concept: condition }]), multimorbidityIds: ['5B81'] };
  const atlas = navigationReducer(state, { type: 'restore' });
  assert.equal(atlas.level, 0);
  assert.equal(atlas.chapterId, null);
  assert.equal(atlas.selectedConceptId, null);
  assert.deepEqual(atlas.multimorbidityIds, ['5B81']);
});

// End to end: a URL built from real ids restores against the backend's data.
test('a shared URL restores the same state from the real backend', async (t) => {
  const backend = await startTestBackend();
  t.after(() => backend.stop());
  const client = apiClient(backend.origin);
  const [registry, meta, overviewData] = await Promise.all([client.listModels(), client.getMeta(), client.getAtlasOverview()]);
  const structure = buildAtlasStructure(overviewData);
  // A configuration that is not the default, with a narrowed lens.
  const entry = registry.models.find((model) => model.model_version !== registry.default_model_version) ?? registry.models[0];
  const useCase = entry.use_cases.at(-1).use_case;
  const lens = { age: meta.axes.age.at(-1), sex: meta.axes.sex.at(-1), ethnicity: meta.axes.ethnicity.at(-1) };
  // A subtype that only its chapter's data holds.
  const chapterId = structure.chapterConcepts[0].concept_id;
  const chapterData = await client.getChapter({ chapterId });
  const subtype = chapterData.concepts.find((concept) => !structure.conceptsById[concept.concept_id]);
  assert.ok(subtype, 'the first chapter has a concept below the overview');

  const href = atlasHref({ model: entry.model_version, useCase, view: 'evidence', lens, mode: 'detailed', depth: 'plain', chapterId, conceptId: subtype.concept_id });
  const parsed = parseStartupParams(href.slice('./atlas.html'.length));
  assert.equal(parsed.model, entry.model_version);
  assert.equal(parsed.useCase, useCase);
  assert.deepEqual(parsed.lens, lens);

  const conceptsById = structure.conceptsById;
  const canonical = (concept) => canonicalConditionId(concept, structure);
  let nav = { ...initialNavigationState, uiMode: uiModeFromParam(parsed.mode) };
  const first = restoreFromUrl(parsed, { conceptsById, isMultimorbidity: false, canonicalId: canonical });
  assert.equal(first.waitForChapter, chapterId);
  nav = navigationReducer(nav, first.action);
  const chapterConceptsById = Object.fromEntries([chapterData.chapter, ...chapterData.blocks, ...chapterData.concepts].map((c) => [c.concept_id, c]));
  nav = navigationReducer(nav, restoreFromUrl(parsed, { conceptsById, chapterConceptsById, isMultimorbidity: false, canonicalId: canonical }).action);
  assert.equal(nav.chapterId, chapterId);
  assert.equal(nav.selectedConceptId, subtype.concept_id);

  // The restored filters are ones the API accepts: the selected card loads.
  const filters = { model: parsed.model, useCase: parsed.useCase, ...parsed.lens };
  const card = await conceptMetricsQuery(filters, nav.selectedConceptId).fetch(client);
  assert.equal(card.concept.concept_id, subtype.concept_id);

  // A link to the chapter itself focuses its first condition.
  const chapterLink = restoreFromUrl(parseStartupParams(`?concept=${chapterId}`), {
    conceptsById,
    isMultimorbidity: false,
    canonicalId: canonical,
    firstConditionByChapterId: structure.firstConditionByChapterId
  });
  const atChapter = navigationReducer(initialNavigationState, chapterLink.action);
  assert.equal(atChapter.chapterId, chapterId);
  assert.equal(atChapter.focus.tileId, `LV2-${structure.firstConditionByChapterId[chapterId].concept_id}`);

  // Every condition and subtype of every chapter joins the disease set as a
  // top-level condition of the overview, so restore keeps whatever the UI adds.
  const chapters = await Promise.all(structure.chapterConcepts.map((entry) => client.getChapter({ chapterId: entry.concept_id })));
  const levelTwo = chapters.flatMap((detail) => detail.concepts.filter((concept) => concept.level === 2));
  assert.ok(levelTwo.length > structure.topLevelConditionIds.size, 'the chapters hold subtypes below the overview');
  const outside = levelTwo.filter((concept) => !structure.topLevelConditionIds.has(canonical(concept)));
  assert.deepEqual(outside.map((concept) => concept.concept_id), [], 'no concept canonicalizes outside the overview');

  // A disease set of real top-level conditions survives too.
  const ids = [...structure.topLevelConditionIds].slice(0, 3);
  const mmParsed = parseStartupParams(atlasSearch({ model: entry.model_version, mode: 'multimorbidity', selectedIds: ids }));
  const mm = navigationReducer(
    { ...initialNavigationState, uiMode: UI_MODES.multimorbidity },
    restoreFromUrl(mmParsed, { conceptsById, isMultimorbidity: true, canonicalId: canonical }).action
  );
  assert.deepEqual(mm.multimorbidityIds, ids);
});

test('a link to the retired Detailed mode opens Focused', () => {
  const parsed = parseStartupParams('?model=SynGPT-2.0&mode=detailed&view=evidence');
  assert.equal(uiModeFromParam(parsed.mode), UI_MODES.focused);
  assert.equal(modeParam(UI_MODES.focused), 'focused');
  assert.equal(Object.hasOwn(UI_MODES, 'detailed'), false, 'no Detailed mode');
  assert.ok(parsed.stateParams.includes('mode'), 'the link still carries the atlas state, so it opens what it says');
});
