// Local results on the ring (contract v1.13, CONTRACT.md §26). With a local
// population chosen, a hospital's own evaluation replaces the public result
// of the same condition; the map's `layer` array says where. React-free for
// the tests.

/** The views that draw results (the Safety view draws incidents, never results). */
const RESULT_VIEWS = new Set(['overall', 'performance', 'evidence', 'intended_use']);

/**
 * The local layer a bubble shows: 'local' (its own result is local),
 * 'includes_local' (a subchapter or chapter holding some), or null.
 *
 * @param {{ layer?: string|null }|null} row a decoded map row
 * @param {string} viewId
 * @param {{ isCombinationMode?: boolean }} [options]
 */
export function localLayerOf(row, viewId, { isCombinationMode = false } = {}) {
  if (!row || isCombinationMode || !RESULT_VIEWS.has(viewId)) return null;
  return row.layer === 'local' || row.layer === 'includes_local' ? row.layer : null;
}

/** The words for a bubble's local layer, for its name and hover card. */
export function localLayerText(layer) {
  if (layer === 'local') return 'local result';
  if (layer === 'includes_local') return 'holds local results';
  return '';
}

/** Whether any drawn tile shows a local layer (the legend's note). */
export function hasLocalLayer(tiles, rowsById, viewId, options) {
  if (!tiles || !rowsById) return false;
  return tiles.some((tile) => tile.concept_id && localLayerOf(rowsById.get(tile.concept_id) ?? null, viewId, options));
}

/** A local dot is at least this many px across on screen, so it reads on the dense chapter ring. */
export const MIN_DOT_PX = 6;

/**
 * Where a bubble's local dot sits: on its rim, upper right, a third of its
 * radius across, never under MIN_DOT_PX on screen (`pxPerUnit`: rendered px
 * per ring unit, when measured).
 */
export function localDot(tile, radius, pxPerUnit = null) {
  const floor = pxPerUnit ? MIN_DOT_PX / 2 / pxPerUnit : 1.6;
  const r = Math.max(floor, radius * 0.3);
  const offset = radius * Math.SQRT1_2;
  return { cx: tile.x + offset, cy: tile.y - offset, r };
}
