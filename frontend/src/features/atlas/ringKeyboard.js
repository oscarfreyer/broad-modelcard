// Arrow-key movement around the ring, as pure functions of the layout.
// Left and right step around the ring (counter-clockwise and clockwise),
// up and down step outward and inward, Home and End jump to the ends.

const TWO_PI = Math.PI * 2;

/** Signed smallest difference between two angles, in -π..π. */
function angleDelta(from, to) {
  return ((((to - from) % TWO_PI) + TWO_PI + Math.PI) % TWO_PI) - Math.PI;
}

/**
 * Polar positions of the interactive tiles, in clockwise order from 12
 * o'clock (ties broken from the centre outward).
 *
 * @param {{ id: string, x: number, y: number, isEmpty?: boolean, concept_id?: string }[]} tiles
 * @param {{ x: number, y: number }} center
 */
export function buildRingIndex(tiles, center = { x: 500, y: 500 }) {
  const entries = tiles
    .filter((tile) => !tile.isEmpty && tile.concept_id)
    .map((tile) => {
      const dx = tile.x - center.x;
      const dy = tile.y - center.y;
      // Layouts place 0 at the top and grow clockwise: x = sin(a), y = -cos(a).
      const angle = (Math.atan2(dx, -dy) + TWO_PI) % TWO_PI;
      return { id: tile.id, angle, radius: Math.hypot(dx, dy) };
    })
    .sort((a, b) => a.angle - b.angle || a.radius - b.radius);
  const position = new Map(entries.map((entry, index) => [entry.id, index]));
  return { entries, position };
}

function radialNeighbour(entries, current, direction) {
  let best = null;
  let bestScore = Infinity;
  for (const entry of entries) {
    const radialGap = (entry.radius - current.radius) * direction;
    if (radialGap <= 0.5) {
      continue;
    }
    const arcGap = Math.abs(angleDelta(current.angle, entry.angle)) * current.radius;
    const score = arcGap * 2 + radialGap;
    if (score < bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

/**
 * The tile id a key moves to, or null when the key does not move. With no
 * current tile, any movement key lands on the first tile.
 *
 * @param {ReturnType<typeof buildRingIndex>} index
 * @param {string|null} currentId
 * @param {string} key KeyboardEvent.key
 */
export function nextRingTile(index, currentId, key) {
  const { entries, position } = index;
  if (!entries.length) {
    return null;
  }
  const isMove = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key);
  if (!isMove) {
    return null;
  }
  if (key === 'Home') {
    return entries[0].id;
  }
  if (key === 'End') {
    return entries[entries.length - 1].id;
  }
  const currentIndex = currentId != null ? position.get(currentId) : undefined;
  if (currentIndex === undefined) {
    return entries[0].id;
  }
  const current = entries[currentIndex];
  if (key === 'ArrowRight') {
    return entries[(currentIndex + 1) % entries.length].id;
  }
  if (key === 'ArrowLeft') {
    return entries[(currentIndex - 1 + entries.length) % entries.length].id;
  }
  const neighbour = radialNeighbour(entries, current, key === 'ArrowUp' ? 1 : -1);
  return neighbour ? neighbour.id : current.id;
}

/**
 * The chapter a key moves to on the atlas rim (one tab stop for all chapters,
 * like the bubbles): Right and Down go clockwise, Left and Up
 * counter-clockwise, wrapping; Home and End jump to the first and last
 * chapter. Null when the key does not move.
 *
 * @param {string[]} chapterIds in clockwise order
 * @param {string|null} currentId
 * @param {string} key KeyboardEvent.key
 */
export function nextChapterId(chapterIds, currentId, key) {
  if (!chapterIds.length) {
    return null;
  }
  if (key === 'Home') {
    return chapterIds[0];
  }
  if (key === 'End') {
    return chapterIds[chapterIds.length - 1];
  }
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (!step) {
    return null;
  }
  const index = chapterIds.indexOf(currentId);
  if (index < 0) {
    return chapterIds[0];
  }
  return chapterIds[(index + step + chapterIds.length) % chapterIds.length];
}
