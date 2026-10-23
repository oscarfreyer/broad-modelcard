// "Disease modelcard" atlas: one bubble per top-level condition, in rows
// from the centre outward inside 21 equal chapter sectors, sized by rarity.
import { sortConcepts } from './conceptOrder.js';
import {
  MODELCARD_INNER_RADIUS,
  MODELCARD_OUTER_RADIUS,
  MODELCARD_STAGE_SIZE,
  finitePrevalence,
  polarPoint,
  rarityWeightForConcept,
  stableConceptHash
} from './atlasGeometry.js';
import { buildChapterRegion } from './chapterRegions.js';

const DISEASE_MODELCARD_BUBBLE_GAP = 0.2;
const DISEASE_RARITY_RADII = Object.freeze({
  1: 2.7,
  2: 3.2,
  3: 3.7,
  4: 4.2,
  5: 5
});

function packDiseaseRaritySector(
  startAngle,
  endAngle,
  items,
  reverseOrder = false,
  bubbleScale = 1
) {
  if (!items.length) {
    return [];
  }

  const sectorAngle = endAngle - startAngle;
  const remaining = items.map((item) => ({
    item,
    r: DISEASE_RARITY_RADII[item.rarityWeight] * bubbleScale
  }));
  const placedById = new Map();
  let rowInnerRadius = MODELCARD_INNER_RADIUS + DISEASE_MODELCARD_BUBBLE_GAP / 2;

  const rowAngularSpan = (row, radius) => {
    if (!row.length) {
      return 0;
    }
    let span = Math.asin(Math.min(0.96, row[0].r / radius));
    for (let index = 1; index < row.length; index += 1) {
      const minimumDistance = row[index - 1].r + row[index].r + DISEASE_MODELCARD_BUBBLE_GAP;
      span += 2 * Math.asin(Math.min(0.96, minimumDistance / (2 * radius)));
    }
    span += Math.asin(Math.min(0.96, row[row.length - 1].r / radius));
    return span;
  };

  while (remaining.length) {
    const row = [];
    let rowMaxRadius = 0;

    for (let index = 0; index < remaining.length;) {
      const candidate = remaining[index];
      if (reverseOrder && row.length && candidate.item.rarityWeight !== row[0].item.rarityWeight) {
        index += 1;
        continue;
      }
      const candidateMaxRadius = Math.max(rowMaxRadius, candidate.r);
      const candidateRadius = rowInnerRadius + candidateMaxRadius;
      const candidateRow = [...row, candidate];
      if (
        candidateRadius + candidateMaxRadius <= MODELCARD_OUTER_RADIUS
        && rowAngularSpan(candidateRow, candidateRadius) <= sectorAngle
      ) {
        row.push(candidate);
        rowMaxRadius = candidateMaxRadius;
        remaining.splice(index, 1);
      } else {
        index += 1;
      }
    }

    if (!row.length) {
      return null;
    }

    const rowRadius = rowInnerRadius + rowMaxRadius;
    const occupiedSpan = rowAngularSpan(row, rowRadius);
    let angle = startAngle + (sectorAngle - occupiedSpan) / 2
      + Math.asin(Math.min(0.96, row[0].r / rowRadius));

    row.forEach((entry, index) => {
      if (index > 0) {
        const previous = row[index - 1];
        const minimumDistance = previous.r + entry.r + DISEASE_MODELCARD_BUBBLE_GAP;
        angle += 2 * Math.asin(Math.min(0.96, minimumDistance / (2 * rowRadius)));
      }
      placedById.set(entry.item.condition.concept_id, {
        ...polarPoint(rowRadius, angle),
        angle,
        radius: rowRadius,
        r: entry.r,
        item: entry.item
      });
    });

    rowInnerRadius = rowRadius + rowMaxRadius + DISEASE_MODELCARD_BUBBLE_GAP;
  }

  return items.map((item) => placedById.get(item.condition.concept_id));
}

function optimizeDiseaseBubbleScale(chapterLayouts, sectorAngle, reverseOrder) {
  const fits = (scale) => chapterLayouts.every(({ conditions }, chapterIndex) => Boolean(
    packDiseaseRaritySector(
      chapterIndex * sectorAngle,
      (chapterIndex + 1) * sectorAngle,
      conditions,
      reverseOrder,
      scale
    )
  ));

  let lower = 1;
  let upper = 1.25;
  while (upper < 4 && fits(upper)) {
    lower = upper;
    upper *= 1.25;
  }
  upper = Math.min(4, upper);
  if (fits(upper)) {
    return upper;
  }

  for (let iteration = 0; iteration < 14; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (fits(midpoint)) {
      lower = midpoint;
    } else {
      upper = midpoint;
    }
  }

  return lower * 0.998;
}

function diseaseRowExpansion(packedChapterLayouts) {
  const expansionLimits = packedChapterLayouts.flatMap(({ packed }) => packed.map((seat) => {
    const baselineRadius = MODELCARD_INNER_RADIUS + seat.r;
    const radialOffset = seat.radius - baselineRadius;
    if (radialOffset <= 0.001) {
      return Number.POSITIVE_INFINITY;
    }
    return (MODELCARD_OUTER_RADIUS - baselineRadius - seat.r) / radialOffset;
  })).filter(Number.isFinite);
  return expansionLimits.length > 0
    ? Math.max(1, Math.min(...expansionLimits))
    : 1;
}

function expandDiseaseSeat(seat, expansion) {
  const baselineRadius = MODELCARD_INNER_RADIUS + seat.r;
  const radius = baselineRadius + (seat.radius - baselineRadius) * expansion;
  return {
    ...seat,
    ...polarPoint(radius, seat.angle),
    radius
  };
}

export function buildDiseaseModelcardAtlasModel(
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
  const chapterLayouts = chapterConcepts.map((chapterConcept) => ({
    chapterConcept,
    conditions: (blocksByChapterId[chapterConcept.concept_id] || [])
      .flatMap((blockConcept) => conditionsByBlockId[blockConcept.concept_id] || [])
      .map((condition) => {
        const prevalence = finitePrevalence(condition, conceptPrevalenceById);
        return {
          condition,
          prevalence,
          rarityWeight: rarityWeightForConcept(condition)
        };
      })
      .sort((a, b) => (reverseOrder ? b.rarityWeight - a.rarityWeight : a.rarityWeight - b.rarityWeight)
        || stableConceptHash(a.condition.concept_id) - stableConceptHash(b.condition.concept_id)
        || sortConcepts(a.condition, b.condition))
  }));
  const bubbleScale = optimizeDiseaseBubbleScale(chapterLayouts, sectorAngle, reverseOrder);
  const packedChapterLayouts = chapterLayouts.map((layout, chapterIndex) => {
    const packed = packDiseaseRaritySector(
      chapterIndex * sectorAngle,
      (chapterIndex + 1) * sectorAngle,
      layout.conditions,
      reverseOrder,
      bubbleScale
    );
    if (!packed) {
      throw new Error(`Unable to pack disease modelcard chapter ${layout.chapterConcept.concept_id}`);
    }
    return { ...layout, packed };
  });
  const radialExpansion = diseaseRowExpansion(packedChapterLayouts);

  packedChapterLayouts.forEach(({ chapterConcept, conditions, packed }, chapterIndex) => {
    const startAngle = chapterIndex * sectorAngle;
    const endAngle = startAngle + sectorAngle;
    regions.push(buildChapterRegion(chapterConcept, startAngle, endAngle));

    conditions.forEach((rarity, conditionIndex) => {
      const condition = rarity.condition;
      const seat = expandDiseaseSeat(packed[conditionIndex], radialExpansion);
      tiles.push({
        x: seat.x,
        y: seat.y,
        r: seat.r,
        concept_id: condition.concept_id,
        isEmpty: false,
        placeholder: false,
        id: `LV1-${condition.concept_id}`,
        prevalence: rarity.prevalence,
        packed_radius: seat.radius
      });
    });
  });

  return {
    kind: 'radial-atlas',
    bubbleScale,
    radialExpansion,
    tiles,
    regions,
    width: MODELCARD_STAGE_SIZE,
    height: MODELCARD_STAGE_SIZE
  };
}
