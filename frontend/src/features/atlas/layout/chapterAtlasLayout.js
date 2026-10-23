// "Chapter modelcard" atlas: one bubble per ICD-11 block, packed inside 21
// equal chapter sectors. Bubble size encodes the block's disease mix.
import { sortConcepts } from './conceptOrder.js';
import {
  MODELCARD_INNER_RADIUS,
  MODELCARD_OUTER_RADIUS,
  MODELCARD_STAGE_SIZE,
  finitePrevalence,
  median,
  polarPoint,
  prevalenceForConcept,
  rarityWeightForConcept,
  stableConceptHash
} from './atlasGeometry.js';
import { buildChapterRegion } from './chapterRegions.js';

const PACKED_MODELCARD_BUBBLE_GAP = 0.8;
// Five disease-mix bands, 1.2× the B3 sizes for legibility; the densest
// chapters (01, 13, 22) no longer pack at 1.3×.
const PACKED_MODELCARD_RADII = Object.freeze({
  1: 7.2,
  2: 9.6,
  3: 12,
  4: 14.4,
  5: 16.8
});

// Bubble scales a chapter tries in turn when its bubbles do not fit at full size.
const PACKING_SCALES = Object.freeze([1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64]);

function blockRarityStats(blockConcept, conditionsByBlockId, conceptPrevalenceById) {
  const conditions = (conditionsByBlockId?.[blockConcept.concept_id] || [])
    .filter((condition) => Number.isFinite(prevalenceForConcept(condition, conceptPrevalenceById)));
  const prevalenceValues = conditions.map((condition) => Math.max(0, prevalenceForConcept(condition, conceptPrevalenceById)));
  const weights = conditions.map(rarityWeightForConcept);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const fallback = finitePrevalence(blockConcept, conceptPrevalenceById, 0.01);
  const typicalPrevalence = median(prevalenceValues) ?? fallback;
  const rarityCounts = weights.reduce(
    (counts, weight) => {
      if (weight >= 4) {
        counts.common += 1;
      } else if (weight === 3) {
        counts.uncommon += 1;
      } else {
        counts.rare += 1;
      }
      return counts;
    },
    { common: 0, uncommon: 0, rare: 0 }
  );
  // A block without conditions has no tier and weighs as very rare.
  return {
    rarityWeightSum: weightSum || rarityWeightForConcept(blockConcept),
    averageRarityWeight: weights.length ? weightSum / weights.length : rarityWeightForConcept(blockConcept),
    count: prevalenceValues.length || 1,
    typicalPrevalence,
    rarityCounts
  };
}

function packCompactRadialRows(
  startAngle,
  endAngle,
  items,
  radiusForItem,
  idForItem,
  gap,
  reverseOrder = false
) {
  if (!items.length) {
    return [];
  }

  const entries = items
    .map((item) => ({ item, r: radiusForItem(item) }))
    .sort((a, b) => (reverseOrder ? b.r - a.r : a.r - b.r)
      || stableConceptHash(idForItem(a.item)) - stableConceptHash(idForItem(b.item)));
  const maximumBubbleRadius = Math.max(...entries.map((entry) => entry.r));
  const cellSize = maximumBubbleRadius * 2 + gap;
  const midAngle = startAngle + (endAngle - startAngle) / 2;
  const radialStep = 1.5;
  const arcStep = 1.5;
  const attemptCount = Math.min(12, Math.max(1, entries.length));
  let best = null;

  for (let attempt = 0; attempt < attemptCount; attempt += 1) {
    const orderedEntries = [];
    const sizeGroups = new Map();
    entries.forEach((entry) => {
      const group = sizeGroups.get(entry.r) || [];
      group.push(entry);
      sizeGroups.set(entry.r, group);
    });
    [...sizeGroups.keys()].sort((a, b) => (reverseOrder ? b - a : a - b)).forEach((radius) => {
      const group = sizeGroups.get(radius);
      const offset = group.length ? Math.floor((attempt * group.length) / attemptCount) : 0;
      orderedEntries.push(...group.slice(offset), ...group.slice(0, offset));
    });
    const grid = new Map();
    const gridKey = (x, y) => x * 65536 + y;
    const placed = [];
    let failed = false;
    let currentRadius = orderedEntries[0]?.r ?? null;
    let currentBandFloor = MODELCARD_INNER_RADIUS;

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
            if (Math.hypot(candidate.x - neighbor.x, candidate.y - neighbor.y) < bubbleRadius + neighbor.r + gap) {
              return true;
            }
          }
        }
      }
      return false;
    };

    const nextSeat = (scan, entry) => {
      const outerRadius = MODELCARD_OUTER_RADIUS - entry.r - gap / 2;
      for (; scan.radius <= outerRadius; scan.radius += radialStep, scan.offset = 0, scan.angleIndex = 0) {
        const radius = scan.radius;
        const angularMargin = Math.asin(Math.min(0.96, (entry.r + gap / 2) / radius));
        const minimumAngle = startAngle + angularMargin;
        const maximumAngle = endAngle - angularMargin;
        const angleStep = arcStep / radius;
        const maximumOffset = Math.floor((maximumAngle - minimumAngle) / (2 * angleStep));

        for (; scan.offset <= maximumOffset; scan.offset += 1, scan.angleIndex = 0) {
          const angleOffset = scan.offset;
          const angleCount = angleOffset === 0 ? 1 : 2;
          for (; scan.angleIndex < angleCount; scan.angleIndex += 1) {
            let angle = midAngle;
            if (angleOffset > 0) {
              angle = scan.angleIndex === 0 ? midAngle - angleOffset * angleStep : midAngle + angleOffset * angleStep;
            }
            if (angle < minimumAngle || angle > maximumAngle) {
              continue;
            }
            const point = polarPoint(radius, angle);
            if (!collides(point, entry.r)) {
              // The seat now collides with the next bubble of this radius.
              scan.angleIndex += 1;
              return { ...point, angle, radius, r: entry.r, item: entry.item };
            }
          }
        }
      }
      return null;
    };

    // Bubbles of one radius are contiguous in orderedEntries and share one
    // candidate sequence; seats only accumulate, so each bubble resumes the
    // scan after the previous seat of its run (same seats as a full rescan).
    let scan = null;
    for (let itemIndex = 0; itemIndex < orderedEntries.length; itemIndex += 1) {
      const entry = orderedEntries[itemIndex];
      if (reverseOrder && entry.r !== currentRadius) {
        currentRadius = entry.r;
        currentBandFloor = Math.max(currentBandFloor, ...placed.map((item) => item.radius));
      }
      if (!scan || scan.r !== entry.r) {
        scan = {
          r: entry.r,
          radius: Math.max(
            MODELCARD_INNER_RADIUS + entry.r + gap / 2,
            reverseOrder ? currentBandFloor : MODELCARD_INNER_RADIUS
          ),
          offset: 0,
          angleIndex: 0
        };
      }
      const selected = nextSeat(scan, entry);

      if (!selected) {
        failed = true;
        break;
      }

      placed.push(selected);
      const cellX = Math.floor(selected.x / cellSize);
      const cellY = Math.floor(selected.y / cellSize);
      const key = gridKey(cellX, cellY);
      const cell = grid.get(key) || [];
      cell.push(selected);
      grid.set(key, cell);
    }

    if (!failed) {
      const occupiedRadius = Math.max(...placed.map((entry) => entry.radius + entry.r));
      if (!best || occupiedRadius < best.occupiedRadius) {
        best = { occupiedRadius, placed };
      }
    }
  }

  if (!best) {
    return null;
  }

  const placedById = new Map(best.placed.map((entry) => [idForItem(entry.item), entry]));
  return items.map((item) => placedById.get(idForItem(item)));
}

function compactRadialSeats(startAngle, endAngle, seats, gap) {
  if (!seats?.length) {
    return seats || [];
  }

  const maximumBubbleRadius = Math.max(...seats.map((seat) => seat.r));
  const compacted = seats.map((seat) => ({ ...seat, sourceRadius: seat.radius }));
  const indicesByBubbleRadius = new Map();
  compacted.forEach((seat, index) => {
    const indices = indicesByBubbleRadius.get(seat.r) || [];
    indices.push(index);
    indicesByBubbleRadius.set(seat.r, indices);
  });
  const orderedGroups = [...indicesByBubbleRadius.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, indices]) => indices.sort((a, b) => compacted[a].radius - compacted[b].radius));

  const collides = (candidate, bubbleRadius, ignoredIndex) => compacted.some((neighbor, index) => (
    index !== ignoredIndex
    && Math.hypot(candidate.x - neighbor.x, candidate.y - neighbor.y) < bubbleRadius + neighbor.r + gap
  ));

  for (let pass = 0; pass < 2; pass += 1) {
    let previousGroupMeanRadius = MODELCARD_INNER_RADIUS;
    orderedGroups.forEach((groupIndices) => {
      groupIndices.forEach((seatIndex) => {
        const seat = compacted[seatIndex];
        const clearance = seat.r + gap / 2;
        const minimumRadius = Math.max(
          MODELCARD_INNER_RADIUS + clearance,
          previousGroupMeanRadius,
          seat.sourceRadius - (maximumBubbleRadius + seat.r + gap) * 1.65
        );
        const radialStep = Math.max(0.8, Math.min(1.5, seat.r * 0.35));
        const arcStep = radialStep;
        const itemId = seat.item?.concept_id || seat.item?.condition?.concept_id || seatIndex;
        const jitterUnit = (stableConceptHash(itemId) % 2001) / 1000 - 1;
        let selected = null;

        for (let radius = minimumRadius; radius < seat.radius - 0.1 && !selected; radius += radialStep) {
          const angularMargin = Math.asin(Math.min(0.96, clearance / radius));
          const minimumAngle = startAngle + angularMargin;
          const maximumAngle = endAngle - angularMargin;
          const angleStep = arcStep / radius;
          const maximumAngleOffset = Math.min(
            Math.ceil(((maximumBubbleRadius + seat.r + gap) * 2.2) / arcStep),
            Math.ceil((maximumAngle - minimumAngle) / (2 * angleStep))
          );
          const preferredAngle = Math.max(
            minimumAngle,
            Math.min(
              maximumAngle,
              seat.angle + jitterUnit * maximumAngleOffset * angleStep * 0.72
            )
          );

          for (let offset = 0; offset <= maximumAngleOffset && !selected; offset += 1) {
            const angles = offset === 0
              ? [preferredAngle]
              : [preferredAngle - offset * angleStep, preferredAngle + offset * angleStep];
            for (let angleIndex = 0; angleIndex < angles.length; angleIndex += 1) {
              const angle = angles[angleIndex];
              if (angle < minimumAngle || angle > maximumAngle) {
                continue;
              }
              const point = polarPoint(radius, angle);
              if (!collides(point, seat.r, seatIndex)) {
                selected = { ...point, angle, radius };
                break;
              }
            }
          }
        }

        if (selected) {
          Object.assign(seat, selected);
        }
      });
      previousGroupMeanRadius = groupIndices.reduce(
        (sum, seatIndex) => sum + compacted[seatIndex].radius,
        0
      ) / groupIndices.length;
    });
  }

  return compacted.map(({ sourceRadius, ...seat }) => seat);
}

export function buildChapterToChapterAtlasModel(
  chapterConcepts,
  blocksByChapterId,
  conditionsByBlockId,
  conceptPrevalenceById,
  reverseOrder = false
) {
  const chapterCount = Math.max(1, chapterConcepts.length);
  const sectorAngle = (Math.PI * 2) / chapterCount;
  const regions = [];
  const tiles = [];
  const rawBlockStats = chapterConcepts.flatMap((chapterConcept) =>
    (blocksByChapterId[chapterConcept.concept_id] || []).map((blockConcept) => ({
      chapterConcept,
      blockConcept,
      ...blockRarityStats(blockConcept, conditionsByBlockId, conceptPrevalenceById)
    }))
  );
  const maximumDiseaseCount = Math.max(1, ...rawBlockStats.map((entry) => entry.count));
  const allBlockStats = rawBlockStats.map((entry) => {
    const rarityComponent = Math.max(0, Math.min(1, (entry.averageRarityWeight - 1) / 4));
    const countComponent = Math.log1p(entry.count) / Math.log1p(maximumDiseaseCount);
    return {
      ...entry,
      diseaseMixScore: rarityComponent * 0.82 + countComponent * 0.18
    };
  });
  const sortedDiseaseMixScores = allBlockStats
    .map((entry) => entry.diseaseMixScore)
    .sort((a, b) => a - b);
  const diseaseMixThresholds = [0.2, 0.4, 0.6, 0.8].map((quantile) =>
    sortedDiseaseMixScores[Math.min(
      sortedDiseaseMixScores.length - 1,
      Math.max(0, Math.ceil(sortedDiseaseMixScores.length * quantile) - 1)
    )]
  );
  const diseaseMixBand = (score) => {
    const thresholdIndex = diseaseMixThresholds.findIndex((threshold) => score <= threshold);
    return thresholdIndex === -1 ? 5 : thresholdIndex + 1;
  };
  const statsByBlockId = new Map(allBlockStats.map((entry) => [entry.blockConcept.concept_id, entry]));

  chapterConcepts.forEach((chapterConcept, chapterIndex) => {
    const startAngle = chapterIndex * sectorAngle;
    const endAngle = startAngle + sectorAngle;
    const blocks = [...(blocksByChapterId[chapterConcept.concept_id] || [])]
      .map((blockConcept) => {
        const rarityStats = statsByBlockId.get(blockConcept.concept_id);
        return {
          blockConcept,
          diseaseMixScore: rarityStats.diseaseMixScore,
          diseaseMixBand: diseaseMixBand(rarityStats.diseaseMixScore),
          diseaseCount: rarityStats.count,
          typicalPrevalence: rarityStats.typicalPrevalence,
          rarityCounts: rarityStats.rarityCounts
        };
      })
      .sort((a, b) => a.diseaseMixBand - b.diseaseMixBand
        || stableConceptHash(a.blockConcept.concept_id) - stableConceptHash(b.blockConcept.concept_id)
        || sortConcepts(a.blockConcept, b.blockConcept));
    regions.push(buildChapterRegion(chapterConcept, startAngle, endAngle));

    // The bands are quantiles over every block, so a chapter whose blocks are
    // mostly common (e.g. under a local population, CONTRACT.md §21) can hold
    // more large bubbles than its sector fits. Such a chapter shrinks all its
    // bubbles in steps until they pack; every other chapter keeps the
    // standard sizes, and with the default prevalence nothing shrinks.
    let packed = null;
    for (const scale of PACKING_SCALES) {
      const radiusById = new Map(
        blocks.map((entry) => [entry.blockConcept.concept_id, PACKED_MODELCARD_RADII[entry.diseaseMixBand] * scale])
      );
      const initialPacking = packCompactRadialRows(
        startAngle,
        endAngle,
        blocks.map((entry) => entry.blockConcept),
        (blockConcept) => radiusById.get(blockConcept.concept_id),
        (blockConcept) => blockConcept.concept_id,
        PACKED_MODELCARD_BUBBLE_GAP,
        reverseOrder
      );
      // Check before compacting: compacting a failed packing would hide the failure.
      packed = initialPacking && reverseOrder
        ? compactRadialSeats(startAngle, endAngle, initialPacking, PACKED_MODELCARD_BUBBLE_GAP)
        : initialPacking;
      if (packed) {
        break;
      }
    }
    if (!packed) {
      throw new Error(`Unable to pack prevalence-weighted modelcard chapter ${chapterConcept.concept_id}`);
    }

    const rarityByBlockId = new Map(blocks.map((entry) => [entry.blockConcept.concept_id, entry]));
    packed.forEach(({ item: blockConcept, x, y, r, radius, angle }) => {
      const rarityStats = rarityByBlockId.get(blockConcept.concept_id);
      tiles.push({
        x,
        y,
        r,
        concept_id: blockConcept.concept_id,
        isEmpty: false,
        placeholder: false,
        id: `LV1-${blockConcept.concept_id}`,
        prevalence: rarityStats.typicalPrevalence,
        rarity_coverage_score: rarityStats.diseaseMixScore,
        disease_mix_score: rarityStats.diseaseMixScore,
        disease_mix_band: rarityStats.diseaseMixBand,
        disease_count: rarityStats.diseaseCount,
        rarity_counts: rarityStats.rarityCounts,
        packed_radius: radius
      });
    });
  });

  return {
    kind: 'radial-atlas',
    tiles,
    regions,
    width: MODELCARD_STAGE_SIZE,
    height: MODELCARD_STAGE_SIZE
  };
}
