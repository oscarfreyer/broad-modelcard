// Shared geometry of the circular atlas: stage size, ring radii, polar
// coordinates, and prevalence helpers used for bubble sizes.
import { prevalenceTierWeight } from '../../../shared/prevalenceTiers.js';

export const MODELCARD_STAGE_SIZE = 1000;
const MODELCARD_CENTER = MODELCARD_STAGE_SIZE / 2;
// The inner hole, the same in the atlas, a chapter, and the catalogue
// snapshot: the centre holds no text and no data (the counts are in the
// legend tile, a loading state in the ring tile's header). 100 is the
// smallest hole at which the largest subchapter bubble (16.8 + half the gap)
// fits a chapter's sector (one 21st of the turn) right at the rim, so every
// sector starts with its largest bubbles on the same inner circle and the
// sizes step down outward (2026-10-15; 60 pushed the largest bubbles out to about 115 and let small ones fill the room under them).
export const MODELCARD_INNER_RADIUS = 100;
export const MODELCARD_OUTER_RADIUS = 390;

/** Bubble-size weight from the concept's commonness tier (1 very rare … 5 very common). */
export function rarityWeightForConcept(concept) {
  return prevalenceTierWeight(concept);
}

export function polarPoint(radius, angle, centerX = MODELCARD_CENTER, centerY = MODELCARD_CENTER) {
  return {
    x: centerX + Math.sin(angle) * radius,
    y: centerY - Math.cos(angle) * radius
  };
}

export function stableConceptHash(conceptId) {
  const value = String(conceptId || '');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function median(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function finitePrevalence(concept, conceptPrevalenceById, fallback = 0.35) {
  const mapped = conceptPrevalenceById?.[concept?.concept_id];
  if (Number.isFinite(mapped)) {
    return Math.max(0, Math.min(1, mapped));
  }
  if (Number.isFinite(concept?.prevalence_score)) {
    return Math.max(0, Math.min(1, concept.prevalence_score));
  }
  return fallback;
}

export function prevalenceForConcept(concept, conceptPrevalenceById) {
  if (!concept) {
    return Number.NEGATIVE_INFINITY;
  }
  const mapped = conceptPrevalenceById?.[concept.concept_id];
  if (Number.isFinite(mapped)) {
    return mapped;
  }
  if (Number.isFinite(concept.prevalence_score)) {
    return concept.prevalence_score;
  }
  return Number.NEGATIVE_INFINITY;
}
