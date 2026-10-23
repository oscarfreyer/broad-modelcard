// Level-2 chapter layout: the chapter's level-2 concepts as rarity-sized
// bubbles in one full circle, grouped into subchapter sectors. Runs in a web
// worker (level2LayoutWorker.js) for dense chapters.
import { MODELCARD_INNER_RADIUS, MODELCARD_OUTER_RADIUS, rarityWeightForConcept } from './atlasGeometry.js';
import { GROUP_LABEL_MAX_FONT, GROUP_LABEL_PAD, GROUP_LABEL_RADIUS, labelEm } from '../arcLabels.js';
import { groupShortLabel } from './groupLabels.js';
import { displayTerm } from '../../../shared/conceptName.js';

const MODELCARD_LEVEL2_WIDTH = 1000;
const MODELCARD_LEVEL2_HEIGHT = 1000;
const MODELCARD_LEVEL2_CENTER_X = MODELCARD_LEVEL2_WIDTH / 2;
const MODELCARD_LEVEL2_CENTER_Y = MODELCARD_LEVEL2_HEIGHT / 2;
const MODELCARD_LEVEL2_INNER_RADIUS = MODELCARD_INNER_RADIUS;
const MODELCARD_LEVEL2_OUTER_RADIUS = MODELCARD_OUTER_RADIUS;
const MODELCARD_LEVEL2_GROUP_MIN_ITEMS = 8;
const MODELCARD_LEVEL2_GROUP_MIN_SHARE = 0.03;
const MODELCARD_LEVEL2_BUBBLE_GAP = 0.5;
const MODELCARD_LEVEL2_TARGET_FILL = 0.58;
const MODELCARD_LEVEL2_RARITY_FACTORS = Object.freeze({
  1: 0.58,
  2: 0.76,
  3: 0.96,
  4: 1.22,
  5: 1.55
});

function compactCondition(condition) {
  return {
    concept_id: condition.concept_id,
    prevalence_tier: condition.prevalence_tier ?? null,
    prevalence_score: condition.prevalence_score
  };
}

function sortConditionsByRarity(a, b) {
  const rarityDelta = rarityWeightForConcept(b) - rarityWeightForConcept(a);
  if (rarityDelta !== 0) {
    return rarityDelta;
  }
  if (a?.prevalence_score !== b?.prevalence_score) {
    return (b?.prevalence_score ?? 0) - (a?.prevalence_score ?? 0);
  }
  return String(a?.concept_id || '').localeCompare(String(b?.concept_id || ''));
}

export function makeLevel2LayoutKey(chapterId, layoutMode) {
  if (!chapterId) {
    return '';
  }
  return `${layoutMode}::${chapterId}`;
}

/**
 * Worker input for one chapter: its blocks in display order, each with its
 * level-2 concepts (including deeper categories) in display order.
 */
export function createLevel2LayoutPayload({ chapterConcept, blocks, conceptsByBlockId }) {
  return {
    chapterId: chapterConcept.concept_id,
    chapterLabel: chapterConcept.pt,
    blocks: (blocks || []).map((blockConcept) => ({
      concept_id: blockConcept.concept_id,
      pt: blockConcept.pt,
      items: (conceptsByBlockId[blockConcept.concept_id] || []).map(compactCondition)
    }))
  };
}

function circlePoint(radius, angle) {
  return {
    x: MODELCARD_LEVEL2_CENTER_X + Math.sin(angle) * radius,
    y: MODELCARD_LEVEL2_CENTER_Y - Math.cos(angle) * radius
  };
}

function mergeSmallSubchapters(blocks, totalItems, chapterId) {
  const minimumItems = Math.max(
    MODELCARD_LEVEL2_GROUP_MIN_ITEMS,
    Math.ceil(totalItems * MODELCARD_LEVEL2_GROUP_MIN_SHARE)
  );
  const runs = blocks
    .map((block) => ({
      id: block.concept_id,
      label: displayTerm(block.pt),
      labelFull: displayTerm(block.pt),
      items: [...(block.items || [])].sort(sortConditionsByRarity),
      sourceBlockIds: [block.concept_id]
    }))
    .filter((run) => run.items.length > 0);
  const retained = runs.filter((run) => run.items.length >= minimumItems);
  const merged = runs.filter((run) => run.items.length < minimumItems);

  if (!merged.length) {
    return runs;
  }

  return [
    ...retained,
    {
      id: `OTHER-${chapterId}`,
      label: 'Other subchapters',
      labelFull: 'Other subchapters',
      items: merged
        .flatMap((run) => run.items)
        .sort(sortConditionsByRarity),
      sourceBlockIds: merged.flatMap((run) => run.sourceBlockIds)
    }
  ];
}

function estimateBubbleBaseRadius(runs) {
  const bandArea = Math.PI
    * (MODELCARD_LEVEL2_OUTER_RADIUS ** 2 - MODELCARD_LEVEL2_INNER_RADIUS ** 2);
  const areaUnits = runs.reduce(
    (sum, run) => sum + run.items.reduce((runSum, item) => {
      const factor = MODELCARD_LEVEL2_RARITY_FACTORS[rarityWeightForConcept(item)];
      return runSum + factor ** 2;
    }, 0),
    0
  );
  return Math.min(
    24,
    Math.max(3, Math.sqrt((bandArea * MODELCARD_LEVEL2_TARGET_FILL) / (Math.PI * Math.max(1, areaUnits))))
  );
}

function packCircleSectorCollision(startAngle, endAngle, items, radiusForItem) {
  if (!items.length) {
    return [];
  }

  const entries = items.map((item) => ({
    item,
    r: radiusForItem(item)
  }));
  const maximumBubbleRadius = Math.max(...entries.map((entry) => entry.r));
  const cellSize = maximumBubbleRadius * 2 + MODELCARD_LEVEL2_BUBBLE_GAP;
  const midAngle = startAngle + (endAngle - startAngle) / 2;
  const grid = new Map();
  const seats = [];
  // Numeric cell keys; cell coordinates stay far below 65536 on the 1000-unit stage.
  const gridKey = (x, y) => x * 65536 + y;

  const collides = (candidate, bubbleRadius) => {
    const cellX = Math.floor(candidate.x / cellSize);
    const cellY = Math.floor(candidate.y / cellSize);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const neighbors = grid.get(gridKey(cellX + offsetX, cellY + offsetY));
        if (!neighbors) {
          continue;
        }
        for (let index = 0; index < neighbors.length; index += 1) {
          const neighbor = neighbors[index];
          if (
            Math.hypot(candidate.x - neighbor.x, candidate.y - neighbor.y)
            < bubbleRadius + neighbor.r + MODELCARD_LEVEL2_BUBBLE_GAP
          ) {
            return true;
          }
        }
      }
    }
    return false;
  };

  // Every bubble of one radius scans the same candidate sequence: rings from
  // the inside out, each from the sector's middle outward. Seats are only
  // ever added, so a candidate that collided for an earlier bubble of that
  // radius still collides. The next bubble of the same radius therefore
  // resumes after the previous seat instead of rescanning, which yields the
  // same seats as a full rescan at a fraction of the cost.
  const cursors = new Map();
  const cursorFor = (bubbleRadius) => {
    let cursor = cursors.get(bubbleRadius);
    if (!cursor) {
      const clearance = bubbleRadius + MODELCARD_LEVEL2_BUBBLE_GAP / 2;
      cursor = {
        clearance,
        outerRadius: MODELCARD_LEVEL2_OUTER_RADIUS - clearance,
        radialStep: Math.max(1.1, Math.min(2.6, bubbleRadius * 0.5)),
        arcStep: Math.max(1.1, Math.min(2.6, bubbleRadius * 0.5)),
        radius: MODELCARD_LEVEL2_INNER_RADIUS + clearance,
        offset: 0,
        angleIndex: 0
      };
      cursors.set(bubbleRadius, cursor);
    }
    return cursor;
  };

  const nextSeat = (bubbleRadius) => {
    const cursor = cursorFor(bubbleRadius);
    const { clearance, outerRadius, radialStep, arcStep } = cursor;
    for (; cursor.radius <= outerRadius; cursor.radius += radialStep, cursor.offset = 0, cursor.angleIndex = 0) {
      const radius = cursor.radius;
      const angularMargin = Math.asin(Math.min(0.96, clearance / radius));
      const minimumAngle = startAngle + angularMargin;
      const maximumAngle = endAngle - angularMargin;
      if (maximumAngle <= minimumAngle) {
        continue;
      }
      const angleStep = arcStep / radius;
      const maximumOffset = Math.ceil((maximumAngle - minimumAngle) / (2 * angleStep));

      for (; cursor.offset <= maximumOffset; cursor.offset += 1, cursor.angleIndex = 0) {
        const offset = cursor.offset;
        const angleCount = offset === 0 ? 1 : 2;
        for (; cursor.angleIndex < angleCount; cursor.angleIndex += 1) {
          let angle = midAngle;
          if (offset > 0) {
            angle = cursor.angleIndex === 0 ? midAngle - offset * angleStep : midAngle + offset * angleStep;
          }
          if (angle < minimumAngle || angle > maximumAngle) {
            continue;
          }
          const point = circlePoint(radius, angle);
          if (!collides(point, bubbleRadius)) {
            // The seat now collides with the next bubble of this radius.
            cursor.angleIndex += 1;
            return { ...point, angle, radius, r: bubbleRadius };
          }
        }
      }
    }
    return null;
  };

  for (let itemIndex = 0; itemIndex < entries.length; itemIndex += 1) {
    const selected = nextSeat(entries[itemIndex].r);
    if (!selected) {
      return null;
    }

    seats.push(selected);
    const key = gridKey(Math.floor(selected.x / cellSize), Math.floor(selected.y / cellSize));
    const cell = grid.get(key);
    if (cell) {
      cell.push(selected);
    } else {
      grid.set(key, [selected]);
    }
  }

  return seats;
}

function packCircleSector(startAngle, endAngle, items, radiusForItem) {
  return packCircleSectorCollision(startAngle, endAngle, items, radiusForItem);
}

/**
 * The arc a subchapter's short name needs at the largest label size any ring
 * draws (arcLabels.planGroupLabel), so the name is never left out for want
 * of room; a name longer than a label's longest arc gets no extra room.
 */
function labelMinimumAngle(run) {
  const angle = (labelEm(groupShortLabel(run)) * GROUP_LABEL_MAX_FONT) / GROUP_LABEL_RADIUS + 2 * GROUP_LABEL_PAD;
  return angle <= 0.92 + 2 * GROUP_LABEL_PAD ? angle : 0;
}

function reverseMinimumSectorAngles(runs, radiusForItem) {
  const fullCircle = Math.PI * 2;
  const baseMinimum = fullCircle * MODELCARD_LEVEL2_GROUP_MIN_SHARE;
  const angles = runs.map((run) => {
    const centerBubbleRadius = Math.max(...run.items.map(radiusForItem));
    const centerRadius = MODELCARD_LEVEL2_INNER_RADIUS + centerBubbleRadius + MODELCARD_LEVEL2_BUBBLE_GAP / 2;
    const bubbleSpan = 2 * Math.asin(Math.min(
      0.96,
      (centerBubbleRadius + MODELCARD_LEVEL2_BUBBLE_GAP / 2) / centerRadius
    ));
    return Math.max(baseMinimum, bubbleSpan * 1.08, labelMinimumAngle(run));
  });
  const total = angles.reduce((sum, angle) => sum + angle, 0);
  if (total <= fullCircle * 0.92) {
    return angles;
  }
  const scale = (fullCircle * 0.92) / total;
  return angles.map((angle) => angle * scale);
}

function packCircleRuns(runs) {
  const fullCircle = Math.PI * 2;
  const radiusEstimate = estimateBubbleBaseRadius(runs);
  const radiusScales = [1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58, 0.52, 0.46, 0.4, 0.34, 0.28, 0.22, 0.18];

  for (let radiusIndex = 0; radiusIndex < radiusScales.length; radiusIndex += 1) {
    const bubbleBaseRadius = radiusEstimate * radiusScales[radiusIndex];
    const radiusForItem = (item) => bubbleBaseRadius
      * MODELCARD_LEVEL2_RARITY_FACTORS[rarityWeightForConcept(item)];
    const runAreaWeights = runs.map((run) => run.items.reduce(
      (sum, item) => sum + Math.PI * radiusForItem(item) ** 2,
      0
    ));
    const totalAreaWeight = runAreaWeights.reduce((sum, value) => sum + value, 0);
    const minimumAngles = reverseMinimumSectorAngles(runs, radiusForItem);
    const minimumTotal = minimumAngles.reduce((sum, angle) => sum + angle, 0);
    const remainingAngle = Math.max(0, fullCircle - minimumTotal);
    const sectorAngles = minimumAngles.map((minimumAngle, index) =>
      minimumAngle + remainingAngle * (runAreaWeights[index] / Math.max(1, totalAreaWeight))
    );
    const packedRuns = [];
    let currentAngle = 0;
    let failed = false;

    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
      const run = runs[runIndex];
      const startAngle = currentAngle;
      currentAngle += sectorAngles[runIndex];
      const endAngle = runIndex === runs.length - 1 ? fullCircle : currentAngle;
      const seats = packCircleSector(
        startAngle,
        endAngle,
        run.items,
        radiusForItem
      );
      if (!seats) {
        failed = true;
        break;
      }
      packedRuns.push({
        ...run,
        startAngle,
        endAngle,
        seats
      });
    }

    if (!failed) {
      return { packedRuns };
    }
  }

  return { packedRuns: [] };
}

export function buildLevel2ModelFromPayload(payload) {
  const chapterId = payload?.chapterId || null;
  const chapterLabel = payload?.chapterLabel || chapterId;
  const blocks = Array.isArray(payload?.blocks) ? payload.blocks : [];
  const totalItems = blocks.reduce((sum, block) => sum + (block.items || []).length, 0);
  const runs = mergeSmallSubchapters(blocks, totalItems, chapterId);
  const tiles = [];
  const separators = [];
  const groups = [];

  if (!totalItems) {
    return {
      kind: 'circle-chapter',
      chapterId,
      tiles,
      groups,
      separators,
      regions: [],
      width: MODELCARD_LEVEL2_WIDTH,
      height: MODELCARD_LEVEL2_HEIGHT
    };
  }
  const { packedRuns } = packCircleRuns(runs);
  if (!packedRuns.length) {
    throw new Error(`Unable to pack chapter ${chapterId} into the modelcard circle`);
  }

  packedRuns.forEach((run, runIndex) => {
    if (runIndex > 0) {
      separators.push({
        id: `SEP-${run.id}`,
        angle: run.startAngle
      });
    }

    groups.push({
      id: run.id,
      label: run.label,
      label_full: run.labelFull,
      startAngle: run.startAngle,
      endAngle: run.endAngle,
      // The subchapters (blocks) this sector holds: one, or the folded small ones of "Other".
      sourceBlockIds: run.sourceBlockIds
    });

    run.items.forEach((item, index) => {
      const seat = run.seats[index];
      tiles.push({
        x: seat.x,
        y: seat.y,
        r: seat.r,
        concept_id: item?.concept_id || null,
        isEmpty: !item,
        placeholder: false,
        id: item ? `LV2-${item.concept_id}` : `LV2-EMPTY-MODELCARD-${run.id}-${index}`
      });
    });
  });

  return {
    kind: 'circle-chapter',
    chapterId,
    tiles,
    groups,
    separators,
    regions: [
      {
        id: `CIRCLE-${chapterId}`,
        concept_id: chapterId,
        label: chapterLabel,
        centerX: MODELCARD_LEVEL2_CENTER_X,
        centerY: MODELCARD_LEVEL2_CENTER_Y,
        innerRadius: MODELCARD_LEVEL2_INNER_RADIUS,
        outerRadius: MODELCARD_LEVEL2_OUTER_RADIUS
      }
    ],
    width: MODELCARD_LEVEL2_WIDTH,
    height: MODELCARD_LEVEL2_HEIGHT
  };
}
