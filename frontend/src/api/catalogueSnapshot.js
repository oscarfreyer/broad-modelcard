// The catalogue's compact tile snapshots, expanded for the UI (contract v1.11,
// CONTRACT.md §17). Shared by both adapters (apiAdapter.js, staticAdapter.js).

/**
 * The catalogue with each tile's snapshot also as one object per subchapter
 * (contract v1.11, CONTRACT.md §17). On the wire the snapshot is compact, to
 * keep the catalogue within its budget: the body lists the subchapters once
 * (`snapshot_blocks`, atlas order, `{ id, chapter }`) and each tile has
 * aligned arrays `snapshot.overview` (Status) and `snapshot.safety`
 * ('serious' | 'caution' | null). This adds
 * `tile.snapshot.blocks = [{ id, chapter, overview, safety }]` next to them.
 */
export function withSnapshotBlocks(catalogue) {
  const blocks = catalogue?.snapshot_blocks;
  if (!Array.isArray(blocks) || !Array.isArray(catalogue.tiles)) {
    return catalogue;
  }
  const tiles = catalogue.tiles.map((tile) => {
    const snapshot = tile.snapshot;
    if (!snapshot) {
      return tile;
    }
    const expanded = blocks.map((block, index) => ({
      id: block.id,
      chapter: block.chapter,
      overview: snapshot.overview?.[index] ?? 'no_data',
      safety: snapshot.safety?.[index] ?? null
    }));
    return { ...tile, snapshot: { ...snapshot, blocks: expanded } };
  });
  return { ...catalogue, tiles };
}
