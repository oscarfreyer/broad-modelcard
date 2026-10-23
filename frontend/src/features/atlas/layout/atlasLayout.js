// Level-1 atlas layouts. Both are deterministic functions of the ontology and
// prevalence; metric colors are applied by the renderer.
import { buildChapterToChapterAtlasModel } from './chapterAtlasLayout.js';
import { buildDiseaseModelcardAtlasModel } from './diseaseAtlasLayout.js';

export const ATLAS_LAYOUT_MODES = Object.freeze(['Chapter modelcard', 'Disease modelcard']);

/**
 * @param {object} input
 * @param {object[]} input.chapterConcepts chapters in ICD-11 order
 * @param {Record<string, object[]>} input.blocksByChapterId
 * @param {Record<string, object[]>} input.conditionsByBlockId top-level conditions per block
 * @param {Record<string, number>} input.conceptPrevalenceById
 * @param {string} input.layoutMode one of ATLAS_LAYOUT_MODES
 */
export function buildLevelOneModel({ chapterConcepts, blocksByChapterId, conditionsByBlockId, conceptPrevalenceById, layoutMode }) {
  if (layoutMode === 'Chapter modelcard') {
    return buildChapterToChapterAtlasModel(chapterConcepts, blocksByChapterId, conditionsByBlockId, conceptPrevalenceById, true);
  }
  if (layoutMode === 'Disease modelcard') {
    return buildDiseaseModelcardAtlasModel(chapterConcepts, blocksByChapterId, conditionsByBlockId, conceptPrevalenceById, true);
  }
  throw new Error(`Unsupported atlas view mode: ${layoutMode}`);
}
