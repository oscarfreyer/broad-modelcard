// The navigation part of the atlas URL: mode, open chapter,
// selected concept, and multimorbidity selection, to and from the state in
// navigationReducer.js. Pure, so the round trip is testable without React.
import { UI_MODES } from './navigationReducer.js';

const MODE_PARAMS = Object.freeze(Object.fromEntries(Object.entries(UI_MODES).map(([param, uiMode]) => [uiMode, param])));

/** URL `mode` value for a UI mode (`focused`, `multimorbidity`). */
export function modeParam(uiMode) {
  return MODE_PARAMS[uiMode] ?? null;
}

/**
 * UI mode for a URL `mode` value, or null. The retired Detailed mode
 * opens Focused, so its old links keep working.
 */
export function uiModeFromParam(mode) {
  if (mode === 'detailed') {
    return UI_MODES.focused;
  }
  return mode && Object.hasOwn(UI_MODES, mode) ? UI_MODES[mode] : null;
}

/**
 * What the URL records of a navigation state. Multimorbidity mode is always
 * at atlas level, so it records the disease set and nothing else.
 *
 * @returns {{ mode: string, chapterId: string|null, conceptId: string|null, selectedIds: string[] }}
 */
export function navigationParams(nav) {
  const mode = modeParam(nav.uiMode);
  if (nav.uiMode === UI_MODES.multimorbidity) {
    return { mode, chapterId: null, conceptId: null, selectedIds: [...nav.multimorbidityIds] };
  }
  return { mode, chapterId: nav.level === 1 ? nav.chapterId : null, conceptId: nav.selectedConceptId, selectedIds: [] };
}

/**
 * The `restore` action for a URL's chapter, concept, and disease set, given
 * the concepts known so far. Ids that name nothing are dropped. A concept
 * that only the chapter's own data holds (a subtype) cannot be resolved from
 * the overview: then the chapter opens first and `waitForChapter` names it,
 * and the caller resolves again with `chapterConceptsById` once it loaded.
 * A chapter as the concept brings its first condition into view, as search
 * and the old `?concept=<chapter>` startup link did.
 *
 * @param {{ chapterId: string|null, conceptId: string|null, selectedIds: string[] }} target
 * @param {object} known
 * @param {Record<string, object>} known.conceptsById overview concepts (chapters, subchapters, top-level conditions)
 * @param {Record<string, object>|null} [known.chapterConceptsById] concepts of the open chapter, once loaded
 * @param {boolean} known.isMultimorbidity
 * @param {(concept: object|undefined) => string|null} known.canonicalId condition id the disease set uses
 * @param {Record<string, object|null>} [known.firstConditionByChapterId] a chapter's first condition (atlasStructure.js)
 * @returns {{ action: object, waitForChapter: string|null }}
 */
export function restoreFromUrl(target, { conceptsById, chapterConceptsById = null, isMultimorbidity, canonicalId, firstConditionByChapterId = {} }) {
  if (isMultimorbidity) {
    // The disease set only ever holds top-level conditions, which the overview
    // has: every way into it (a bubble on the atlas, a search result) goes
    // through canonicalConditionId, and every deeper category anchors to its
    // depth-1 stem (CONTRACT.md §5), so a subtype joins as that condition.
    // canonicalConditionId's fallback to the concept's own id is therefore
    // never reached with contract data, and keeping only overview conditions
    // here drops nothing the UI could have added (tests/atlasUrlState.test.js
    // checks this against every chapter of the store).
    const ids = (target.selectedIds ?? []).filter((id) => canonicalId(conceptsById[id]) === id);
    return { action: { type: 'restore', multimorbidityIds: ids }, waitForChapter: null };
  }
  const chapterId = target.chapterId && conceptsById[target.chapterId]?.level === 0 ? target.chapterId : null;
  const concept = target.conceptId ? conceptsById[target.conceptId] ?? chapterConceptsById?.[target.conceptId] ?? null : null;
  if (chapterId && target.conceptId && !concept && !chapterConceptsById) {
    return { action: { type: 'restore', chapterId }, waitForChapter: chapterId };
  }
  const firstConditionId = concept?.level === 0 ? firstConditionByChapterId[concept.concept_id]?.concept_id ?? null : null;
  return { action: { type: 'restore', chapterId, concept, firstConditionId, shouldFocus: Boolean(concept) }, waitForChapter: null };
}
