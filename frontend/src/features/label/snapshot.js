// The card snapshot: the atlas in miniature.
// Every ICD-11 subchapter is one bubble, at the size and in the place it has
// on the atlas's "All chapters" ring (the same layout code over the same
// atlas structure), drawn with the one mark of its state. Performance shows
// each subchapter's Overview mark; Safety shows the incident
// marks where they are and the neutral "No reported incidents" mark
// elsewhere. The catalogue tile and the model card draw the same snapshot.
//
// The geometry depends only on the atlas structure (concepts and prevalence),
// so it is computed once per structure and shared by every tile on a page.
import { ATLAS_LAYOUT_MODES, buildLevelOneModel } from '../atlas/layout/atlasLayout.js';
import { MODELCARD_STAGE_SIZE } from '../atlas/layout/atlasGeometry.js';
import { buildAtlasStructure } from '../atlas/atlasStructure.js';
import { mapRowStatus, safetyKey } from '../../design/status.js';

/** The atlas's subchapter ring ("All chapters"). */
const RING_LAYOUT = ATLAS_LAYOUT_MODES[0];
const CENTRE = MODELCARD_STAGE_SIZE / 2;
/** Space kept around the outermost bubble, in atlas units. */
const MARGIN = 6;

export const SNAPSHOT_MODES = Object.freeze({ overview: 'overview', safety: 'safety' });

const geometryCache = new WeakMap();

/**
 * The snapshot's geometry for an atlas structure: one seat per subchapter,
 * exactly where the atlas ring puts it, and a square view box around the
 * ring (centred on the atlas centre, so the open middle stays in the middle).
 *
 * @param {object|null} overview contract AtlasOverview (the response object; cached per object)
 * @returns {{ viewBox: string, extent: number, seats: Map<string, { x: number, y: number, r: number }>, order: string[] }|null}
 */
export function snapshotGeometry(overview) {
  if (!overview?.blocks?.length) {
    return null;
  }
  const cached = geometryCache.get(overview);
  if (cached) {
    return cached;
  }
  const structure = buildAtlasStructure(overview);
  const model = buildLevelOneModel({
    chapterConcepts: structure.chapterConcepts,
    blocksByChapterId: structure.blocksByChapterId,
    conditionsByBlockId: structure.topLevelConditionsByBlockId,
    conceptPrevalenceById: structure.conceptPrevalenceById,
    layoutMode: RING_LAYOUT
  });
  const round = (value) => Math.round(value * 10) / 10;
  const seats = new Map();
  let reach = 0;
  for (const tile of model.tiles) {
    if (tile.isEmpty || !tile.concept_id) continue;
    seats.set(tile.concept_id, { x: round(tile.x), y: round(tile.y), r: round(tile.r) });
    reach = Math.max(reach, Math.hypot(tile.x - CENTRE, tile.y - CENTRE) + tile.r);
  }
  const extent = Math.ceil(reach + MARGIN);
  const geometry = {
    viewBox: `${CENTRE - extent} ${CENTRE - extent} ${extent * 2} ${extent * 2}`,
    extent,
    seats,
    order: [...seats.keys()]
  };
  geometryCache.set(overview, geometry);
  return geometry;
}

/** The geometry already computed for this structure, or null (never computes). */
export function cachedSnapshotGeometry(overview) {
  return (overview && geometryCache.get(overview)) ?? null;
}

/**
 * The mark of one subchapter on the snapshot.
 *
 * - overview: through the atlas's own rule (`mapRowStatus`): an
 *   open or mitigated incident's mark first, then Out of scope only when the
 *   card has an intended-use statement, then the grade, otherwise No data.
 * - safety: Serious or Caution where an incident applies, else the neutral
 *   No reported incidents mark (never green).
 *
 * @param {{ overview?: string|null, safety?: string|null }|null} block a `tile.snapshot.blocks` entry
 * @param {'overview'|'safety'} mode
 * @param {{ hasIntendedUse?: boolean }} [options]
 */
export function snapshotStatus(block, mode, { hasIntendedUse = true } = {}) {
  if (mode === SNAPSHOT_MODES.safety) {
    return safetyKey(block?.safety ?? null);
  }
  const row = block ? { overall_status: block.overview ?? 'no_data', safety: block.safety ?? null } : null;
  return mapRowStatus(row, 'overall', { hasIntendedUse });
}

/**
 * Every subchapter's mark for one tile, in the geometry's order. A
 * subchapter the tile does not list reads No data (or no incidents).
 *
 * @param {{ id: string, overview?: string, safety?: string|null }[]} blocks tile.snapshot.blocks
 * @param {ReturnType<typeof snapshotGeometry>} geometry
 * @param {'overview'|'safety'} mode
 * @param {{ hasIntendedUse?: boolean }} [options]
 * @returns {{ id: string, x: number, y: number, r: number, status: string }[]}
 */
export function snapshotMarks(blocks, geometry, mode, options = {}) {
  if (!geometry) {
    return [];
  }
  const byId = new Map((blocks ?? []).map((block) => [block.id, block]));
  return geometry.order.map((id) => ({ id, ...geometry.seats.get(id), status: snapshotStatus(byId.get(id) ?? null, mode, options) }));
}

/** How many subchapters show each mark, for the snapshot's text description. */
export function markCounts(marks) {
  const counts = {};
  for (const mark of marks) {
    counts[mark.status] = (counts[mark.status] ?? 0) + 1;
  }
  return counts;
}
