import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UI_MODES,
  canGoBack,
  initialNavigationState,
  navigationReducer,
  selectedTileIds
} from '../frontend/src/features/navigation/navigationReducer.js';

const chapter = { concept_id: 'CH-05', level: 0, chapter_id: 'CH-05' };
const block = { concept_id: 'BLK-05', level: 1, parent_id: 'CH-05', chapter_id: 'CH-05' };
const condition = { concept_id: '5A11', level: 2, parent_id: 'BLK-05', chapter_id: 'CH-05' };
const tile = (concept, prefix = 'LV1') => ({ id: `${prefix}-${concept.concept_id}`, concept_id: concept.concept_id, isEmpty: false });
const run = (actions, state = initialNavigationState) => actions.reduce(navigationReducer, state);

test('clicking an atlas bubble opens its chapter and selects the bubble concept', () => {
  const state = run([{ type: 'selectTile', tile: tile(block), concept: block }]);
  assert.equal(state.level, 1);
  assert.equal(state.chapterId, 'CH-05');
  assert.equal(state.selectedConceptId, 'BLK-05');
  assert.equal(state.selectedTileId, null);
  assert.equal(canGoBack(state), true);
});

test('clicking the selected chapter bubble again returns to the chapter card', () => {
  const opened = run([{ type: 'selectTile', tile: tile(block), concept: block }]);
  const selected = run([{ type: 'selectTile', tile: tile(condition, 'LV2'), concept: condition }], opened);
  assert.equal(selected.selectedConceptId, '5A11');
  assert.equal(selected.selectedTileId, 'LV2-5A11');
  const deselected = run([{ type: 'selectTile', tile: tile(condition, 'LV2'), concept: condition }], selected);
  assert.equal(deselected.selectedConceptId, 'CH-05');
  assert.equal(deselected.selectedTileId, null);
});

test('back and breadcrumbs move between chapter and atlas', () => {
  const opened = run([{ type: 'navigateToConcept', concept: condition, shouldFocus: true }]);
  assert.equal(opened.level, 1);
  assert.equal(opened.selectedTileId, 'LV2-5A11');
  assert.deepEqual(opened.focus, { tileId: 'LV2-5A11', token: 1 });

  const chapterCard = run([{ type: 'selectBreadcrumb', depth: 1 }], opened);
  assert.equal(chapterCard.selectedConceptId, 'CH-05');
  const atlas = run([{ type: 'back' }], chapterCard);
  assert.equal(atlas.level, 0);
  assert.equal(atlas.chapterId, null);
  assert.equal(atlas.selectedConceptId, null);
  assert.equal(canGoBack(atlas), false);
});

test('search navigation focuses a chapter’s first condition or a block on the atlas', () => {
  const chapterState = run([{ type: 'navigateToConcept', concept: chapter, firstConditionId: '5A10', shouldFocus: true }]);
  assert.equal(chapterState.selectedConceptId, 'CH-05');
  assert.equal(chapterState.focus.tileId, 'LV2-5A10');
  const blockState = run([{ type: 'navigateToConcept', concept: block, shouldFocus: true }], chapterState);
  assert.equal(blockState.level, 0);
  assert.equal(blockState.selectedTileId, 'LV1-BLK-05');
  assert.equal(blockState.focus.token, 2);
});

test('multimorbidity mode builds, trims, and resets a disease set', () => {
  let state = run([{ type: 'selectTile', tile: tile(block), concept: block }]);
  state = run([{ type: 'setUiMode', uiMode: UI_MODES.multimorbidity }], state);
  assert.equal(state.level, 0);
  assert.equal(state.selectedConceptId, null);

  state = run([
    { type: 'selectTile', tile: tile(condition), concept: condition, canonicalId: '5A11' },
    { type: 'selectTile', tile: tile(block), concept: block, canonicalId: null },
    { type: 'toggleMultimorbidity', canonicalId: '5B81' },
    { type: 'toggleMultimorbidity', canonicalId: '5C80', shouldFocus: true }
  ], state);
  assert.deepEqual(state.multimorbidityIds, ['5A11', '5B81', '5C80']);
  assert.deepEqual(selectedTileIds(state), ['LV1-5A11', 'LV1-5B81', 'LV1-5C80']);
  assert.equal(state.focus.tileId, 'LV1-5C80');

  state = run([{ type: 'selectTile', tile: tile(condition), concept: condition, canonicalId: '5A11' }], state);
  assert.deepEqual(state.multimorbidityIds, ['5B81', '5C80'], 'clicking a selected disease removes it');
  state = run([{ type: 'back' }], state);
  assert.deepEqual(state.multimorbidityIds, ['5B81']);
  assert.equal(canGoBack(state), true);
  state = run([{ type: 'resetMultimorbidity' }], state);
  assert.deepEqual(state.multimorbidityIds, []);
  assert.equal(canGoBack(state), false);
});

test('background click clears the selection', () => {
  const state = run([
    { type: 'navigateToConcept', concept: condition },
    { type: 'clearSelection' }
  ]);
  assert.equal(state.level, 1);
  assert.equal(state.selectedConceptId, null);
  assert.deepEqual(selectedTileIds(state), []);
});
