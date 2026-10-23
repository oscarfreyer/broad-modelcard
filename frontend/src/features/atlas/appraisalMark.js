// Not appraised (CONTRACT.md §22): a graded result
// with no study record behind it. Its grade is unchanged. It has no mark
// on the ring: it is named in words, in
// the bubble's spoken name, the Summary's Evidence card, and the condition
// card's Study quality. The map's `appraisal` array says linked or
// includes_linked; null, or no array at all, is not appraised.
// React-free for the tests.
import { mapRowStatus } from '../../design/status.js';

export const NOT_APPRAISED_LABEL = 'Not appraised';
/** What it means, in the Summary's words. */
export const NOT_APPRAISED_MEANING = 'no study record behind the grade';

const GRADED = new Set(['strong', 'moderate', 'weak']);

/** Whether a decoded map row has an evidence grade on screen (Strong, Moderate, or Weak). */
export function isGraded(row) {
  return Boolean(row) && GRADED.has(mapRowStatus(row, 'evidence', { withSafety: false }));
}

/**
 * Whether a bubble's name says Not appraised: the Evidence view only, a
 * graded result, and no study record behind it (`appraisal` null or absent).
 * Never in Multimorbidity or while loading.
 */
export function isNotAppraised(row, viewId, { isCombinationMode = false, isLoading = false } = {}) {
  if (viewId !== 'evidence' || isCombinationMode || isLoading || !isGraded(row)) return false;
  return !row.appraisal;
}

/**
 * Conditions in view with an evidence grade (`graded`), and those whose grade
 * rests on a study record (`linked`): the Summary names both. The API's `appraisal_counts` are
 * the same counts over all top-level conditions.
 */
export function appraisalCounts(conditions, rowsById) {
  let graded = 0;
  let linked = 0;
  for (const concept of conditions ?? []) {
    const row = rowsById?.get(concept.concept_id) ?? null;
    if (!isGraded(row)) continue;
    graded += 1;
    if (row.appraisal) linked += 1;
  }
  return { graded, linked };
}

/** The Summary's card on the Evidence view, or null when nothing in view is graded. */
export function appraisalHighlight({ graded, linked }) {
  if (!graded) return null;
  const count = (value) => Number(value).toLocaleString('en-US');
  const missing = graded - linked;
  let text;
  if (!linked) {
    text = `None of the ${count(graded)} graded ${graded === 1 ? 'condition has' : 'conditions has'} a study record behind its grade.`;
  } else if (missing) {
    text = `${count(missing)} ${missing === 1 ? 'condition is' : 'conditions are'} ${NOT_APPRAISED_LABEL}: ${NOT_APPRAISED_MEANING}.`;
  } else {
    text = 'Every grade in view rests on a linked study record.';
  }
  return {
    id: 'appraisal',
    tone: 'not_appraised',
    title: linked ? `Study appraisal for ${count(linked)} of ${count(graded)} graded` : 'No study appraisal',
    text,
    targetId: null
  };
}
