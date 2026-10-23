import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HoverCard from './HoverCard.jsx';
import { RingBubbles, RingCores, RingGroupFocus, RingHitAreas, RingLocalMarks, bubbleRadius } from './RingBubbles.jsx';
import RingFrame from './RingFrame.jsx';
import { buildRingIndex, nextRingTile } from './ringKeyboard.js';

// The selection ring pings twice after a search jump (two 600 ms rings, ring.css).
const FLASH_DURATION_MS = 1200;
const VIEWBOX_SIZE = 960;
const VIEWBOX = `20 20 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`;
/**
 * The selected bubble's ring hugs it: its centre line sits
 * this far outside the bubble, in SVG units (about 2.5 px at 1280×800), so a
 * thin white gap and a 2 px blue ring show on every mark (green, amber,
 * coral, grey, barred) without covering the neighbours.
 */
const HALO_GAP = 3.75;
/** Extra room when the bubble also carries the changed-from-live ring (3 units out, 2px ink). */
const CHANGED_HALO_ROOM = 3.5;

/**
 * The full name of what a rim label or segment stands for, beside it, while
 * it is hovered or focused: an atlas chapter label (R2), a chapter on the
 * chapter view's switch rim, or a subchapter label around a chapter circle.
 * It opens at once on pointer entry, unlike a
 * native title tooltip.
 */
function FrameTip({ tip }) {
  const style = {
    left: `${tip.x}px`,
    top: `${tip.y}px`,
    transform: `translate(${tip.placeLeft ? 'calc(-100% - 10px)' : '10px'}, ${tip.placeAbove ? 'calc(-100% - 6px)' : '6px'})`
  };
  return (
    <div className="hover-card chapter-tip" style={style} aria-hidden="true">
      <p className="hover-card-name">{tip.title}</p>
      {tip.meta ? <p className="hover-card-meta">{tip.meta}</p> : null}
    </div>
  );
}

/**
 * The radial ICD-11 ring (atlas or chapter circle). Bubbles keep their
 * geometry and recolour in place; every state is drawn with its one mark
 * (StatusMark.js), absence by shape. Events are
 * delegated from the bubble layer, and keyboard focus roves over bubbles.
 *
 * @param {object} props
 * @param {object} props.viewModel layout model (radial-atlas or circle-chapter)
 * @param {Record<string, object>} props.conceptsById concepts for the bubbles in view
 * @param {Map<string, object>} props.rowsById decoded metric map rows
 * @param {Map<string, { share: number, status: string }>|null} [props.coresById] subchapter absence shares
 * @param {Map<string, { serious: number, caution: number, total: number }>|null} [props.talliesById] Safety view: marked conditions per subchapter
 * @param {Set<string>|null} [props.changedIds] preview: concepts whose data differs from live (ink halo)
 * @param {string} props.viewId contract MetricView
 * @param {boolean} props.isLoading metrics not loaded yet: bubbles draw in the loading form
 * @param {string[]} props.selectedTileIds
 * @param {{ tileId: string|null, token: number }} props.focusRequest bubble to scroll to and flash
 * @param {(tile: object) => void} props.onSelectTile
 * @param {() => void} props.onBackground
 * @param {((chapterId: string, how: 'pointer'|'keyboard') => void)|null} [props.onOpenChapter] atlas: a chapter's sector or label opens it
 */
function RingView({
  viewModel,
  conceptsById,
  rowsById,
  coresById = null,
  talliesById = null,
  changedIds = null,
  viewId,
  statusBands,
  isLoading = false,
  isCombinationMode = false,
  isExpert = false,
  hasIntendedUse = true,
  resultFor = null,
  selectedTileIds = [],
  selectedChapterId = null,
  selectedGroupId = null,
  highlightGroupId = null,
  focusRequest,
  showLabels = true,
  rim = null,
  onSelectTile,
  onBackground,
  onOpenChapter = null,
  label
}) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [flashingId, setFlashingId] = useState(null);
  const [frameTip, setFrameTip] = useState(null); // { key, source, title, meta, x, y, placeLeft, placeAbove }
  /**
   * Shows (or, with null, hides) the tip of a rim label or segment.
   * `target` names it by angle and radius in ring units, so the tip sits
   * beside it; `source` keeps a hover and a focus tip from hiding each other.
   *
   * @param {{ key: string, angle: number, radius: number, title: string, meta?: string }|null} target
   * @param {'hover'|'focus'} source
   */
  const showFrameTip = useCallback((target, source) => {
    if (!target) {
      setFrameTip((current) => (current?.source === source ? null : current));
      return;
    }
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) {
      return;
    }
    const frame = stage.getBoundingClientRect();
    const box = canvas.getBoundingClientRect();
    const scale = box.width / VIEWBOX_SIZE;
    // In stage pixels (the viewBox starts at 20, 20).
    const x = box.left - frame.left + (500 + Math.sin(target.angle) * target.radius - 20) * scale;
    const y = box.top - frame.top + (500 - Math.cos(target.angle) * target.radius - 20) * scale;
    setHover(null);
    setFrameTip({ ...target, source, x, y, placeLeft: x > frame.width / 2, placeAbove: y > frame.height / 2 });
  }, []);

  const tiles = viewModel.tiles || [];
  const tilesById = useMemo(() => new Map(tiles.map((tile) => [tile.id, tile])), [tiles]);
  const ringIndex = useMemo(() => buildRingIndex(tiles, { x: viewModel.width / 2, y: viewModel.height / 2 }), [tiles, viewModel]);
  const selectedSet = useMemo(() => new Set(selectedTileIds), [selectedTileIds]);

  // Keep the roving tab stop on a bubble that exists in this view.
  const tabStopId = activeId && tilesById.has(activeId)
    ? activeId
    : selectedTileIds.find((id) => tilesById.has(id)) ?? ringIndex.entries[0]?.id ?? null;

  useEffect(() => {
    setHover(null);
    setActiveId(null);
    setFrameTip(null);
  }, [viewModel]);

  // A bubble's node, found when needed: no ref callback per bubble, so the
  // bubble layer stays memoized (audit B7).
  const nodeFor = useCallback(
    (tileId) => canvasRef.current?.querySelector(`.ring-bubbles .bubble[data-tile-id="${CSS.escape(tileId)}"]`) ?? null,
    []
  );

  const showCardFor = useCallback((tileId) => {
    const node = nodeFor(tileId);
    const tile = tilesById.get(tileId);
    const concept = tile ? conceptsById[tile.concept_id] : null;
    const stage = stageRef.current;
    if (!node || !concept || !stage) {
      setHover(null);
      return;
    }
    const box = node.getBoundingClientRect();
    const frame = stage.getBoundingClientRect();
    const x = box.left + box.width / 2 - frame.left;
    const y = box.top + box.height / 2 - frame.top;
    setHover({ tileId, x, y, placeLeft: x > frame.width * 0.6, placeAbove: y > frame.height * 0.62 });
  }, [conceptsById, nodeFor, tilesById]);

  useEffect(() => {
    const tileId = focusRequest?.tileId;
    if (!tileId || !tilesById.has(tileId)) {
      return undefined;
    }
    setActiveId(tileId);
    setFlashingId(tileId);
    const timer = window.setTimeout(() => setFlashingId((current) => (current === tileId ? null : current)), FLASH_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [focusRequest?.tileId, focusRequest?.token, tilesById]);

  const tileIdOf = (event) => event.target?.closest?.('[data-tile-id]')?.getAttribute('data-tile-id') ?? null;

  const handleClick = (event) => {
    const tileId = tileIdOf(event);
    event.stopPropagation();
    if (!tileId) {
      setHover(null);
      const chapterId = onOpenChapter ? event.target?.closest?.('[data-chapter-id]')?.getAttribute('data-chapter-id') : null;
      if (chapterId) {
        onOpenChapter(chapterId, 'pointer');
        return;
      }
      onBackground?.();
      return;
    }
    setActiveId(tileId);
    onSelectTile(tilesById.get(tileId));
  };

  const handleKeyDown = (event) => {
    const currentId = tileIdOf(event);
    if (event.key === 'Enter' || event.key === ' ') {
      if (currentId) {
        event.preventDefault();
        onSelectTile(tilesById.get(currentId));
      }
      return;
    }
    const nextId = nextRingTile(ringIndex, currentId, event.key);
    if (nextId) {
      event.preventDefault();
      setActiveId(nextId);
      nodeFor(nextId)?.focus({ preventScroll: true });
      // Show the result directly; focus events do not fire while the window is unfocused.
      showCardFor(nextId);
    }
  };

  const hoverTile = hover ? tilesById.get(hover.tileId) : null;
  const hoverConcept = hoverTile ? conceptsById[hoverTile.concept_id] : null;
  const isAtlas = viewModel.kind === 'radial-atlas';

  return (
    <div ref={stageRef} className="ring-stage" onClick={handleClick}>
      <div ref={canvasRef} className="ring-canvas">
        <svg
          className={`ring-svg${isLoading ? ' is-loading' : ''}`}
          viewBox={VIEWBOX}
          role="group"
          aria-label={label}
          aria-busy={isLoading}
        >
          <RingFrame
            viewModel={viewModel}
            showLabels={showLabels}
            selectedChapterId={selectedChapterId}
            selectedGroupId={selectedGroupId}
            rim={rim}
            onOpenChapter={isAtlas ? onOpenChapter : null}
            onTip={showFrameTip}
          />
          <g
            className="ring-bubbles"
            onKeyDown={handleKeyDown}
            onPointerOver={(event) => {
              const tileId = tileIdOf(event);
              if (tileId) {
                showCardFor(tileId);
              }
            }}
            onPointerLeave={() => setHover(null)}
            onFocus={(event) => {
              const tileId = tileIdOf(event);
              if (tileId) {
                setActiveId(tileId);
                showCardFor(tileId);
              }
            }}
            onBlur={() => setHover(null)}
          >
            {isAtlas && !isCombinationMode ? <RingHitAreas tiles={tiles} /> : null}
            <RingBubbles
              tiles={tiles}
              conceptsById={conceptsById}
              rowsById={rowsById}
              coresById={coresById}
              talliesById={talliesById}
              changedIds={changedIds}
              viewId={viewId}
              isLoading={isLoading}
              isCombinationMode={isCombinationMode}
              hasIntendedUse={hasIntendedUse}
              selectedSet={selectedSet}
              flashingId={flashingId}
              tabStopId={tabStopId}
            />
          </g>
          {coresById ? (
            <RingCores tiles={tiles} rowsById={rowsById} coresById={coresById} viewId={viewId} isCombinationMode={isCombinationMode} hasIntendedUse={hasIntendedUse} />
          ) : null}
          {isLoading ? null : <RingLocalMarks tiles={tiles} rowsById={rowsById} viewId={viewId} isCombinationMode={isCombinationMode} />}
          {viewModel.kind === 'circle-chapter' ? (
            <RingGroupFocus viewModel={viewModel} highlightGroupId={highlightGroupId} selectedGroupId={selectedGroupId} />
          ) : null}
          {changedIds?.size && !isLoading ? (
            <g className="ring-changes" aria-hidden="true">
              {tiles.map((tile) =>
                changedIds.has(tile.concept_id) ? (
                  <g key={tile.id}>
                    <circle className="bubble-change-gap" cx={tile.x} cy={tile.y} r={bubbleRadius(tile) + 3} />
                    <circle className="bubble-change" cx={tile.x} cy={tile.y} r={bubbleRadius(tile) + 3} />
                  </g>
                ) : null
              )}
            </g>
          ) : null}
          <g className="ring-halos" aria-hidden="true">
            {[...new Set([...selectedTileIds, flashingId])].map((tileId) => {
              const tile = tileId ? tilesById.get(tileId) : null;
              if (!tile) {
                return null;
              }
              // Around a changed-from-live ring (preview), the halo sits outside it.
              const isChanged = !isLoading && changedIds?.has(tile.concept_id);
              const radius = bubbleRadius(tile) + HALO_GAP + (isChanged ? CHANGED_HALO_ROOM : 0);
              const isFlashing = tileId === flashingId;
              // A thin white gap, then the 2 px blue ring; after a jump, a ring pings outward from it.
              return (
                <g key={tileId} className={`bubble-halo-group${selectedSet.has(tileId) ? ' is-selected' : ''}${isFlashing ? ' is-flashing' : ''}`}>
                  <circle className="bubble-halo-gap" cx={tile.x} cy={tile.y} r={radius} />
                  <circle className="bubble-halo" cx={tile.x} cy={tile.y} r={radius} />
                  {isFlashing ? <circle key={focusRequest?.token} className="bubble-halo-ping" cx={tile.x} cy={tile.y} r={radius} /> : null}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      {frameTip ? <FrameTip tip={frameTip} /> : null}
      {hover && hoverConcept ? (
        <HoverCard
          concept={hoverConcept}
          row={rowsById.get(hoverTile.concept_id) ?? null}
          tile={hoverTile}
          viewId={viewId}
          statusBands={statusBands}
          position={hover}
          isCombinationMode={isCombinationMode}
          isExpert={isExpert}
          hasIntendedUse={hasIntendedUse}
          isLoading={isLoading}
          core={isLoading ? null : coresById?.get(hoverTile.concept_id) ?? null}
          tally={talliesById?.get(hoverTile.concept_id) ?? null}
          resultFor={resultFor}
        />
      ) : null}
    </div>
  );
}

export default memo(RingView);
