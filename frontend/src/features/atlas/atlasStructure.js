// Lookup structures over the atlas overview (chapters, blocks, top-level
// conditions) and one chapter's detail, for layout, navigation, and labels.
import { sortChapterConcepts, sortConcepts, sortConditionsByName } from './layout/conceptOrder.js';
import { conceptName } from '../../shared/conceptName.js';

function groupBy(concepts, keyOf) {
  const groups = {};
  concepts.forEach((concept) => {
    const key = keyOf(concept);
    if (!key) {
      return;
    }
    (groups[key] ||= []).push(concept);
  });
  Object.values(groups).forEach((group) => group.sort(sortConcepts));
  return groups;
}

/** @param {object} overview contract AtlasOverview */
export function buildAtlasStructure(overview) {
  const { chapters = [], blocks = [], conditions = [] } = overview || {};
  const conceptsById = {};
  [...chapters, ...blocks, ...conditions].forEach((concept) => {
    conceptsById[concept.concept_id] = concept;
  });
  const conceptPrevalenceById = {};
  [...blocks, ...conditions].forEach((concept) => {
    conceptPrevalenceById[concept.concept_id] = concept.prevalence_score ?? null;
  });

  const blocksByChapterId = groupBy(blocks, (block) => block.parent_id);
  const topLevelConditionsByBlockId = groupBy(conditions, (condition) => condition.parent_id);

  // Search focuses a chapter's first condition: the alphabetically first
  // condition of the first block that has one.
  const firstConditionByChapterId = {};
  Object.entries(blocksByChapterId).forEach(([chapterId, chapterBlocks]) => {
    const block = chapterBlocks.find((candidate) => topLevelConditionsByBlockId[candidate.concept_id]?.length);
    firstConditionByChapterId[chapterId] = block
      ? [...topLevelConditionsByBlockId[block.concept_id]].sort(sortConditionsByName)[0]
      : null;
  });

  return {
    conceptsById,
    conceptPrevalenceById,
    chapterConcepts: [...chapters].sort(sortChapterConcepts),
    blocksByChapterId,
    topLevelConditionsByBlockId,
    firstConditionByChapterId,
    topLevelConditionIds: new Set(conditions.map((condition) => condition.concept_id))
  };
}

/** Chapter → block → concept names, for search results. */
export function conceptPathLabel(concept, structure) {
  const names = [];
  const chapter = structure.conceptsById[concept.chapter_id];
  if (chapter && concept.level > 0) {
    names.push(conceptName(chapter));
  }
  if (concept.level === 2) {
    const block = structure.conceptsById[concept.parent_id];
    if (block) {
      names.push(conceptName(block));
    }
  }
  names.push(conceptName(concept));
  return names.join(' > ');
}

/**
 * The top-level condition a level-2 concept resolves to in multimorbidity
 * mode (its depth-1 metric anchor), or null for chapters and blocks.
 */
export function canonicalConditionId(concept, structure) {
  if (!concept || concept.level !== 2) {
    return null;
  }
  const stem = String(concept.concept_id).includes('.') ? String(concept.concept_id).replace(/\.[^.]+$/, '') : concept.concept_id;
  const anchorId = concept.metric_anchor_id || stem || concept.concept_id;
  return structure.topLevelConditionIds.has(anchorId) ? anchorId : concept.concept_id;
}

/** Layout input and concept lookup for one chapter (contract ChapterDetail). */
export function buildChapterStructure(chapterDetail) {
  const conceptsById = {};
  [chapterDetail.chapter, ...chapterDetail.blocks, ...chapterDetail.concepts].forEach((concept) => {
    conceptsById[concept.concept_id] = concept;
  });
  return {
    chapterConcept: chapterDetail.chapter,
    blocks: [...chapterDetail.blocks].sort(sortConcepts),
    conceptsByBlockId: groupBy(chapterDetail.concepts, (concept) => concept.parent_id),
    conceptsById
  };
}
