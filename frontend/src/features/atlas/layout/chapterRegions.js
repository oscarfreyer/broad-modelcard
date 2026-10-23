// The chapter sector of the atlas ring, with its label and icon.
import { MODELCARD_INNER_RADIUS, MODELCARD_OUTER_RADIUS } from './atlasGeometry.js';
import { conceptName } from '../../../shared/conceptName.js';
import { chapterIconKey, chapterNumberLabel, chapterShortLabel } from './chapterLabels.js';

export function buildChapterRegion(chapterConcept, startAngle, endAngle) {
  return {
    id: `REGION-${chapterConcept.concept_id}`,
    concept_id: chapterConcept.concept_id,
    short_label: chapterShortLabel(chapterConcept),
    // The full name without its leading chapter number ("02 Neoplasms" → "Neoplasms").
    label_full: conceptName({ ...chapterConcept, level: 0 }),
    chapter_no: String(chapterConcept.chapter_no || '').padStart(2, '0'),
    // "Chapter 4"; null for a classification without chapter numbers (MONDO, contract v1.13).
    number_label: chapterNumberLabel(chapterConcept),
    icon: chapterIconKey(chapterConcept),
    startAngle,
    endAngle,
    innerRadius: MODELCARD_INNER_RADIUS,
    outerRadius: MODELCARD_OUTER_RADIUS
  };
}
