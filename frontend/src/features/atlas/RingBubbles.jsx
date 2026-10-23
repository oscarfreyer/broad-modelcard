import { memo, useLayoutEffect, useRef, useState } from 'react';
import { StatusMarkShape } from '../../design/StatusMark.js';
import { coreRadius, displayFor, ringStatus, viewLabel } from '../../design/status.js';
import { conceptName } from '../../shared/conceptName.js';
import { quantizeScale } from './arcLabels.js';
import { sectorPath } from './radialPaths.js';
import { coreText } from './coreText.js';
import { incidentHint, tallyText } from './safetyTally.js';
import { localDot, localLayerOf, localLayerText } from './localLayer.js';
import { NOT_APPRAISED_LABEL, isNotAppraised } from './appraisalMark.js';

/** A bubble's radius in ring units, never zero. */
export const bubbleRadius = (tile) => Math.max(0.75, Number(tile.r) || 5);

/** A touch target is at least this many px across (WCAG 2.5.8, audit B8). */
const MIN_HIT_PX = 24;

/**
 * Rendered px per ring unit of the svg around `nodeRef`, quantized (as the
 * frame measures its labels), so only the layer that needs it re-renders,
 * and only every few pixels of resize.
 */
function useRenderedScale(nodeRef) {
  const [pxPerUnit, setPxPerUnit] = useState(null);
  useLayoutEffect(() => {
    const svg = nodeRef.current?.ownerSVGElement;
    if (!svg) {
      return undefined;
    }
    const measure = () => setPxPerUnit(quantizeScale((svg.clientWidth || svg.getBoundingClientRect().width) / svg.viewBox.baseVal.width));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [nodeRef]);
  return pxPerUnit;
}

/** The accessible name of a bubble: its name, the view, its mark, and what its centre, tally, incident, or preview add. */
function bubbleName({ concept, tile, row, status, viewId, isLoading, isCombinationMode, hasIntendedUse, core, tally, isChanged }) {
  const display = displayFor(status);
  let word = isLoading ? 'loading' : core && display.form === 'fill' ? `${display.label}; ${coreText(core)}` : display.label;
  if (tally) {
    word = `${word}; ${tallyText(tally)}`;
  }
  if (isChanged) {
    word = `${word}; changed from live`;
  }
  const local = isLoading ? null : localLayerOf(row, viewId, { isCombinationMode });
  if (local) {
    word = `${word}; ${localLayerText(local)}`;
  }
  if (isNotAppraised(row, viewId, { isCombinationMode, isLoading })) {
    word = `${word}; ${NOT_APPRAISED_LABEL.toLowerCase()}`;
  }
  // The hover card's incident line, for screen readers too (S8).
  const incident = isLoading || !concept ? null : incidentHint(row, concept, viewId, { isCombinationMode, hasIntendedUse });
  if (incident && viewId === 'overall') {
    // On Overview the mark is the incident's; the result underneath is named too.
    word = `${word} safety incident reported; the result underneath is ${incident.result}`;
  } else if (incident) {
    word = `${word}; ${incident.status === 'serious' ? 'serious' : 'caution'} safety incident reported`;
  }
  return `${concept ? conceptName(concept) : tile.concept_id}: ${viewLabel(viewId)} ${word}`;
}

/**
 * The bubble layer: one mark per tile (StatusMark.js), recoloured in place.
 * Memoized on the data and the selection, never on hover: hovering a bubble
 * changes only the hover card (audit B7). Selection is `aria-current`, the
 * bubble's action opens its card (audit B16).
 */
export const RingBubbles = memo(function RingBubbles({
  tiles,
  conceptsById,
  rowsById,
  coresById,
  talliesById,
  changedIds,
  viewId,
  isLoading,
  isCombinationMode,
  hasIntendedUse,
  selectedSet,
  flashingId,
  tabStopId
}) {
  return tiles.map((tile) => {
    if (tile.isEmpty || !tile.concept_id) {
      return null;
    }
    const concept = conceptsById[tile.concept_id];
    const row = rowsById.get(tile.concept_id) ?? null;
    const status = ringStatus(row, viewId, { isCombinationMode, isLoading, hasIntendedUse });
    const isSelected = selectedSet.has(tile.id);
    const name = bubbleName({
      concept,
      tile,
      row,
      status,
      viewId,
      isLoading,
      isCombinationMode,
      hasIntendedUse,
      core: coresById?.get(tile.concept_id),
      tally: isLoading ? null : talliesById?.get(tile.concept_id),
      isChanged: !isLoading && Boolean(changedIds?.has(tile.concept_id))
    });
    return (
      <StatusMarkShape
        key={tile.id}
        status={status}
        cx={tile.x}
        cy={tile.y}
        r={bubbleRadius(tile)}
        className={`bubble${isSelected ? ' is-selected' : ''}${tile.id === flashingId ? ' is-flashing' : ''}`}
        bodyProps={{
          'data-tile-id': tile.id,
          role: 'button',
          tabIndex: tile.id === tabStopId ? 0 : -1,
          'aria-current': isSelected ? 'true' : undefined,
          'aria-label': name
        }}
      />
    );
  });
});

/**
 * Invisible touch targets under small subchapter bubbles: on a touch screen
 * or a phone (ring.css), a bubble narrower than 24 px gets a 24 px circle
 * behind the bubbles, so a tap between neighbours still reaches the nearest
 * one; the bubbles themselves keep the hit order where they are drawn.
 * Atlas level only: a chapter's bubbles are too dense for it.
 */
export const RingHitAreas = memo(function RingHitAreas({ tiles }) {
  const groupRef = useRef(null);
  const pxPerUnit = useRenderedScale(groupRef);
  const minRadius = pxPerUnit ? MIN_HIT_PX / 2 / pxPerUnit : null;
  return (
    <g ref={groupRef} className="ring-hits" aria-hidden="true">
      {minRadius
        ? tiles.map((tile) =>
            !tile.isEmpty && tile.concept_id && bubbleRadius(tile) < minRadius ? (
              <circle key={tile.id} className="bubble-hit" data-tile-id={tile.id} cx={tile.x} cy={tile.y} r={minRadius} />
            ) : null
          )
        : null}
    </g>
  );
});

/**
 * The centres of subchapter bubbles (status.js subchapterCore): the share of
 * weak conditions, or on Intended use the share without a scope fit, in its
 * own mark, area-proportional inside a rim of the bubble's colour. A centre
 * is drawn only where it reads (status.js coreRadius), so this layer
 * measures the ring's rendered scale. Without a white ring around the centre
 * (2026-10-15) a centre in the bubble's own mark would not show, so a
 * Weak bubble draws none; its name still gives the share.
 */
export const RingCores = memo(function RingCores({ tiles, rowsById, coresById, viewId, isCombinationMode, hasIntendedUse }) {
  const groupRef = useRef(null);
  const pxPerUnit = useRenderedScale(groupRef);
  return (
    <g ref={groupRef} className="ring-cores" aria-hidden="true">
      {tiles.map((tile) => {
        const core = coresById.get(tile.concept_id);
        const row = rowsById.get(tile.concept_id) ?? null;
        const status = ringStatus(row, viewId, { isCombinationMode, hasIntendedUse });
        if (!core || core.status === status || displayFor(status).form !== 'fill') {
          return null;
        }
        const radius = coreRadius(bubbleRadius(tile), core.share, pxPerUnit);
        return radius ? <StatusMarkShape key={tile.id} status={core.status} cx={tile.x} cy={tile.y} r={radius} className="bubble-core" /> : null;
      })}
    </g>
  );
});

/**
 * Local results (contract v1.13, §26): a small ink dot on the rim of a
 * bubble whose result is the hospital's own, hollow on a subchapter or
 * chapter that holds some. Drawn over the bubbles, never taking pointer
 * events; the bubble's name says it too.
 */
export const RingLocalMarks = memo(function RingLocalMarks({ tiles, rowsById, viewId, isCombinationMode }) {
  const groupRef = useRef(null);
  const pxPerUnit = useRenderedScale(groupRef);
  return (
    <g ref={groupRef} className="ring-local" aria-hidden="true">
      {tiles.map((tile) => {
        const layer = tile.concept_id ? localLayerOf(rowsById.get(tile.concept_id) ?? null, viewId, { isCombinationMode }) : null;
        if (!layer) {
          return null;
        }
        const dot = localDot(tile, bubbleRadius(tile), pxPerUnit);
        return <circle key={tile.id} className={`bubble-local${layer === 'includes_local' ? ' is-within' : ''}`} {...dot} />;
      })}
    </g>
  );
});

/** The chapter-view sector that holds a subchapter (block) id: its own, or the "Other" sector it was folded into. */
export function groupForBlock(groups, blockId) {
  if (!blockId) {
    return null;
  }
  return groups.find((group) => group.id === blockId || group.sourceBlockIds?.includes(blockId)) ?? null;
}

/**
 * Finding a subchapter in a chapter (audit A20). While a Summary card that
 * names a subchapter is hovered or focused, the other sectors are veiled so
 * its bubbles stand out; a selected subchapter's sector is outlined in the
 * selection blue. Drawn over the bubbles, never taking pointer events.
 */
export const RingGroupFocus = memo(function RingGroupFocus({ viewModel, highlightGroupId, selectedGroupId }) {
  const groups = viewModel.groups || [];
  const circle = viewModel.regions?.[0];
  if (!circle || !groups.length) {
    return null;
  }
  const highlighted = groupForBlock(groups, highlightGroupId);
  const selected = groupForBlock(groups, selectedGroupId);
  const sector = (group) =>
    sectorPath({ ...group, innerRadius: circle.innerRadius, outerRadius: circle.outerRadius }, viewModel.width, viewModel.height);
  if (!highlighted && !selected) {
    return null;
  }
  return (
    <g className="ring-group-focus" aria-hidden="true">
      {highlighted
        ? groups.filter((group) => group.id !== highlighted.id).map((group) => <path key={group.id} className="ring-group-veil" d={sector(group)} />)
        : null}
      {[...new Set([highlighted, selected].filter(Boolean))].map((group) => (
        <path key={`outline-${group.id}`} className="ring-group-outline" d={sector(group)} />
      ))}
    </g>
  );
});
