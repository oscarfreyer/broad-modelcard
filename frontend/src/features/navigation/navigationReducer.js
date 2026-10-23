// Where the user is in the atlas and what is selected. Pure state
// transitions, so the interaction rules can be tested without React.
//
// Tile ids follow the layouts: `LV1-<concept>` for atlas bubbles and
// `LV2-<concept>` for chapter bubbles.

export const UI_MODES = Object.freeze({
  focused: 'simple',
  multimorbidity: 'multimorbidity'
});

export const initialNavigationState = Object.freeze({
  uiMode: UI_MODES.focused,
  /** 0 = atlas, 1 = chapter */
  level: 0,
  /** Open chapter at level 1 (the breadcrumb), otherwise null. */
  chapterId: null,
  selectedTileId: null,
  selectedConceptId: null,
  /** Multimorbidity selection: canonical condition ids in selection order. */
  multimorbidityIds: [],
  /** Bubble to scroll to and flash; the token re-triggers the same tile. */
  focus: { tileId: null, token: 0 }
});

const atlasTileId = (conceptId) => `LV1-${conceptId}`;
const chapterTileId = (conceptId) => `LV2-${conceptId}`;

function withFocus(state, tileId, shouldFocus) {
  return shouldFocus && tileId ? { ...state, focus: { tileId, token: state.focus.token + 1 } } : state;
}

function openAtlas(state) {
  return { ...state, level: 0, chapterId: null, selectedConceptId: null, selectedTileId: null };
}

function openChapter(state, chapterId, selectedConceptId, selectedTileId) {
  return { ...state, level: 1, chapterId, selectedConceptId, selectedTileId };
}

/** Add or remove a condition from the multimorbidity selection. */
function toggleMultimorbidity(state, { canonicalId, shouldFocus = false }) {
  if (!canonicalId) {
    return state;
  }
  const ids = state.multimorbidityIds.includes(canonicalId)
    ? state.multimorbidityIds.filter((id) => id !== canonicalId)
    : [...state.multimorbidityIds, canonicalId];
  const next = {
    ...state,
    level: 0,
    chapterId: null,
    selectedConceptId: canonicalId,
    selectedTileId: atlasTileId(canonicalId),
    multimorbidityIds: ids
  };
  return withFocus(next, atlasTileId(canonicalId), shouldFocus);
}

/**
 * Jump to a concept, e.g. from search. Chapters open (focusing their first
 * condition), blocks are selected on the atlas, conditions open their chapter.
 */
function navigateToConcept(state, { concept, firstConditionId = null, shouldFocus = false }) {
  if (!concept) {
    return state;
  }
  if (concept.level === 0) {
    const next = openChapter(state, concept.concept_id, concept.concept_id, null);
    return withFocus(next, firstConditionId ? chapterTileId(firstConditionId) : null, shouldFocus);
  }
  if (concept.level === 1) {
    const tileId = atlasTileId(concept.concept_id);
    return withFocus({ ...state, level: 0, chapterId: null, selectedConceptId: concept.concept_id, selectedTileId: tileId }, tileId, shouldFocus);
  }
  if (!concept.chapter_id) {
    return state;
  }
  const tileId = chapterTileId(concept.concept_id);
  return withFocus(openChapter(state, concept.chapter_id, concept.concept_id, tileId), tileId, shouldFocus);
}

/** Click on a bubble. */
function selectTile(state, { tile, concept, canonicalId }) {
  if (!tile || tile.isEmpty || !tile.concept_id || !concept) {
    return state;
  }
  if (state.uiMode === UI_MODES.multimorbidity) {
    return concept.level === 2 ? toggleMultimorbidity(state, { canonicalId }) : state;
  }
  if (state.level === 0) {
    // An atlas bubble opens its chapter and selects the clicked block or condition.
    return concept.chapter_id ? openChapter(state, concept.chapter_id, concept.concept_id, null) : state;
  }
  const chapterId = state.chapterId || concept.chapter_id;
  if (!chapterId) {
    return state;
  }
  if (tile.id === state.selectedTileId) {
    // Clicking the selected bubble again returns to the chapter card.
    return { ...state, selectedTileId: null, selectedConceptId: chapterId };
  }
  return { ...state, selectedConceptId: concept.concept_id, selectedTileId: tile.id };
}

/**
 * Put the atlas where a URL points (a shared link, browser Back or Forward).
 * The caller resolves ids to concepts it knows; unknown ones arrive as null
 * and are dropped. In multimorbidity mode only the disease set is restored;
 * otherwise a concept outside the given chapter wins over the chapter. A
 * chapter as the concept opens it the way search does, focusing its first
 * condition (`firstConditionId`).
 */
function restore(state, { chapterId = null, concept = null, firstConditionId = null, multimorbidityIds = null, shouldFocus = false }) {
  const atlas = openAtlas(state);
  if (state.uiMode === UI_MODES.multimorbidity) {
    return { ...atlas, multimorbidityIds: multimorbidityIds ? [...multimorbidityIds] : [] };
  }
  if (concept?.level === 0 && (!chapterId || concept.concept_id === chapterId)) {
    return navigateToConcept(atlas, { concept, firstConditionId, shouldFocus });
  }
  if (chapterId && (!concept || concept.concept_id === chapterId || concept.chapter_id === chapterId)) {
    const tileId = concept && concept.level >= 2 ? chapterTileId(concept.concept_id) : null;
    return withFocus(openChapter(atlas, chapterId, concept?.concept_id ?? null, tileId), tileId, shouldFocus);
  }
  return concept ? navigateToConcept(atlas, { concept, firstConditionId, shouldFocus }) : atlas;
}

export function navigationReducer(state, action) {
  switch (action.type) {
    case 'setUiMode':
      return action.uiMode === UI_MODES.multimorbidity
        ? openAtlas({ ...state, uiMode: action.uiMode })
        : { ...state, uiMode: action.uiMode };
    case 'selectTile':
      return selectTile(state, action);
    case 'navigateToConcept':
      return navigateToConcept(state, action);
    case 'toggleMultimorbidity':
      return toggleMultimorbidity(state, action);
    case 'clearSelection':
      return { ...state, selectedTileId: null, selectedConceptId: null };
    case 'back':
      if (state.uiMode === UI_MODES.multimorbidity) {
        return { ...state, multimorbidityIds: state.multimorbidityIds.slice(0, -1), selectedConceptId: null, selectedTileId: null };
      }
      return state.level === 1 && state.chapterId ? openAtlas(state) : state;
    case 'selectConcept':
      // Select a concept that has no bubble in view (a block inside its chapter).
      return action.conceptId ? { ...state, selectedConceptId: action.conceptId, selectedTileId: null } : state;
    case 'openChapter':
      return action.chapterId ? openChapter(state, action.chapterId, null, null) : state;
    case 'selectBreadcrumb':
      if (action.depth === 0) {
        return openAtlas(state);
      }
      return action.depth === 1 && state.chapterId ? openChapter(state, state.chapterId, state.chapterId, null) : state;
    case 'restore':
      return restore(state, action);
    case 'resetMultimorbidity':
      return { ...state, multimorbidityIds: [], selectedConceptId: null, selectedTileId: null };
    case 'switchClassification':
      // Another classification (contract v1.13) has other concept ids: back to
      // its atlas, nothing selected; combinations are ICD-11 only.
      return { ...openAtlas(state), uiMode: UI_MODES.focused, multimorbidityIds: [] };
    default:
      throw new Error(`Unknown navigation action: ${action.type}`);
  }
}

/**
 * What Esc does: close the open card first, then step back (chapter to
 * atlas, or one condition off the multimorbidity set). Null when nothing.
 */
export function escapeAction(state) {
  if (state.uiMode === UI_MODES.multimorbidity) {
    return state.multimorbidityIds.length ? { type: 'back' } : null;
  }
  if (state.selectedConceptId) {
    return { type: 'clearSelection' };
  }
  return state.level === 1 ? { type: 'back' } : null;
}

/** Whether Back does something in the current state. */
export function canGoBack(state) {
  return state.uiMode === UI_MODES.multimorbidity ? state.multimorbidityIds.length > 0 : state.level > 0;
}

/** Bubbles drawn as selected. */
export function selectedTileIds(state) {
  if (state.uiMode === UI_MODES.multimorbidity) {
    return state.multimorbidityIds.map(atlasTileId);
  }
  return state.selectedTileId ? [state.selectedTileId] : [];
}
