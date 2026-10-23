// Each search result's mark: the status the ring draws for it on the card and
// view on screen (audit batch 3). Most results are ICD-11 subcategories, which
// the ring does not draw at atlas level: a subtype shares its top-level
// condition's result (CONTRACT.md §5, `metric_anchor_id`, served with every
// search result), so it is looked up by that anchor. The palette sends no
// request per result; it reads the metric maps the atlas already holds.
import { ringStatus } from '../../design/status.js';

/**
 * The row id the ring colours a concept by, or null when the ring draws no
 * mark for it (a chapter is a sector, not a bubble).
 *
 * In another classification (contract v1.13, `ownRows`) a subtype has a
 * mapping and a result of its own, so it is never read from its condition's row.
 *
 * @param {object} concept a search result (contract Concept)
 * @param {{ ownRows?: boolean }} [options]
 */
export function markConceptId(concept, { ownRows = false } = {}) {
  if (!concept || concept.level === 0) {
    return null;
  }
  if (concept.level === 1 || ownRows) {
    return concept.concept_id;
  }
  return concept.metric_anchor_id || concept.concept_id;
}

/**
 * The display key of a search result, or null when the loaded maps cannot
 * say (no mark rather than a wrong one).
 *
 * The atlas map (`scope=atlas`) holds every subchapter and every top-level
 * condition, so it answers for any result. While a chapter is open its own
 * map (`scope=chapter`) holds the chapter's subchapters and every level-2
 * concept in it, subtypes with their condition's row, so it answers for
 * results in that chapter. A concept a loaded map does not hold has no row,
 * which the ring draws as No data.
 *
 * @param {object} concept a search result
 * @param {object} maps
 * @param {Map<string, object>|null} maps.atlasRows the current atlas map's rows, or null when not loaded
 * @param {Map<string, object>|null} [maps.chapterRows] the open chapter's current map rows, or null
 * @param {string|null} [maps.chapterId] the open chapter
 * @param {string} viewId
 * @param {{ hasIntendedUse?: boolean, ownRows?: boolean }} [options] `ownRows`: another classification
 *   (contract v1.13), whose subtypes the atlas map does not hold; they get a mark only from their open chapter's map
 * @returns {string|null}
 */
export function searchResultStatus(concept, { atlasRows = null, chapterRows = null, chapterId = null }, viewId, { hasIntendedUse = true, ownRows = false } = {}) {
  const id = markConceptId(concept, { ownRows });
  if (!id) {
    return null;
  }
  const isSubtype = concept.level === 2 && (concept.depth_in_kind ?? 1) > 1;
  if (ownRows && isSubtype) {
    return chapterRows && chapterId && concept.chapter_id === chapterId && chapterRows.has(id)
      ? ringStatus(chapterRows.get(id), viewId, { hasIntendedUse })
      : null;
  }
  if (atlasRows) {
    return ringStatus(atlasRows.get(id) ?? null, viewId, { hasIntendedUse });
  }
  if (chapterRows && chapterId && concept.chapter_id === chapterId) {
    return ringStatus(chapterRows.get(concept.concept_id) ?? chapterRows.get(id) ?? null, viewId, { hasIntendedUse });
  }
  return null;
}
