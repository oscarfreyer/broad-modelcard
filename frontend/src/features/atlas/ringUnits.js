// What the ring draws, in the units the centre counts (S7, critique round 1
// R1). The centre counts conditions; the ring draws subchapters (atlas),
// one bubble per condition (Multimorbidity), or every condition with its
// subtypes (a chapter), which the key explains.

/**
 * The bubbles drawn, by kind: subchapters (ICD-11 blocks), conditions
 * (top-level categories, the centre's unit), and subtypes (deeper
 * categories, which show their condition's result, CONTRACT.md §5).
 *
 * @param {{ concept_id?: string, isEmpty?: boolean }[]} tiles
 * @param {Record<string, { level?: number, depth_in_kind?: number|null }>} conceptsById
 */
export function drawnBubbles(tiles, conceptsById) {
  const drawn = { total: 0, subchapters: 0, conditions: 0, subtypes: 0 };
  for (const tile of tiles || []) {
    if (tile.isEmpty || !tile.concept_id) {
      continue;
    }
    const concept = conceptsById?.[tile.concept_id];
    if (!concept) {
      continue;
    }
    drawn.total += 1;
    if (concept.level === 1) {
      drawn.subchapters += 1;
    } else if (concept.level === 2 && concept.depth_in_kind != null && concept.depth_in_kind > 1) {
      drawn.subtypes += 1;
    } else if (concept.level === 2) {
      drawn.conditions += 1;
    }
  }
  return drawn;
}
