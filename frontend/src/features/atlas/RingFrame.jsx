import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ATLAS_LABEL_PAD, ATLAS_LABEL_RADIUS, CHAPTER_RIM_RADIUS, GROUP_LABEL_RADIUS, LABEL_HIT_OUTER, planChapterLabels, planGroupLabel, quantizeScale } from './arcLabels.js';
import ChapterIcon from './ChapterIcon.jsx';
import { groupShortLabel } from './layout/groupLabels.js';
import { nextChapterId } from './ringKeyboard.js';
import { arcTextPath, atlasIconPoint, circleBandPath, circleLabelArcPath, radialLinePoints, sectorPath } from './radialPaths.js';

/** The chapter badge on the atlas rim and the Healthicons glyph inside it (SVG units; about 17 px at 1280×800). */
const BADGE_RADIUS = 16;
const BADGE_ICON = 26;
/**
 * The chapter switch around a chapter circle: one thick arc per
 * chapter holding its icon, the open chapter in ink. The band runs from 454
 * to 478 (arcLabels CHAPTER_RIM_*), clear of the subchapter labels inside it.
 */
const RIM_RADIUS = CHAPTER_RIM_RADIUS;
const RIM_ICON = 17;
const RIM_GAP = 0.008;

/** A chapter tip's second line: "Chapter 4. Click to open it", or the action alone (MONDO has no chapter numbers, v1.13). */
function chapterMeta(region, action) {
  const number = region.number_label ?? (region.chapter_no ? `Chapter ${Number(region.chapter_no) || region.chapter_no}` : null);
  return number ? `${number}. ${action}` : action;
}

function arcPath(radius, startAngle, endAngle, cx = 500, cy = 500) {
  const point = (angle) => ({ x: cx + Math.sin(angle) * radius, y: cy - Math.cos(angle) * radius });
  const start = point(startAngle);
  const end = point(endAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

const CHAPTERS_LABEL = 'Chapters. Arrow keys move between chapters, Enter opens one.';
const RIM_LABEL = 'Other chapters. Arrow keys move between chapters, Enter opens one.';

/**
 * The atlas rim: 21 chapter sectors with icon badges and curved short labels
 * (R2). Each chapter (its sector, label, and badge) is one target: a click
 * opens it, and the keyboard reaches all chapters through one roving tab
 * stop (arrow keys move, Enter or Space opens), named by the chapter's full
 * name. Without `onOpenChapter` (Multimorbidity stays on the atlas) the rim
 * is a quiet picture again.
 *
 * Only the rim is a target: the band from the sector's outer edge to the
 * labels, plus the label and badge. The wedge inside, where the bubbles
 * are, takes no clicks, so a click between bubbles or on the centre still
 * clears the selection.
 *
 * Label sizes follow the rendered ring, measured here (quantized, so only
 * the frame re-renders, and only every few pixels of resize) so they read
 * at no less than 13 px; short names never end in an ellipsis (arcLabels.js).
 */
function useRenderedScale(nodeRef) {
  const [pxPerUnit, setPxPerUnit] = useState(null);
  useLayoutEffect(() => {
    const svg = nodeRef.current?.ownerSVGElement;
    if (!svg) {
      return undefined;
    }
    // The layout width, not getBoundingClientRect: a chapter circle grows in
    // with a scale transform, and a size measured mid-animation (about 0.3×)
    // made every label several times too large until the next resize.
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

function AtlasFrame({ viewModel, showLabels, selectedChapterId, onOpenChapter, onTip }) {
  const { width, height } = viewModel;
  const regions = viewModel.regions || [];
  const isInteractive = Boolean(onOpenChapter);
  const nodes = useRef(new Map());
  const [activeId, setActiveId] = useState(null);
  const [focus, setFocus] = useState(null); // { id, isVisible }
  const groupRef = useRef(null);
  const pxPerUnit = useRenderedScale(groupRef);
  const plans = useMemo(() => planChapterLabels(regions, pxPerUnit), [regions, pxPerUnit]);
  const ids = regions.map((region) => region.concept_id);
  const tabStopId = ids.includes(activeId) ? activeId : ids.includes(selectedChapterId) ? selectedChapterId : ids[0] ?? null;
  const chapterIdOf = (event) => event.target?.closest?.('[data-chapter-id]')?.getAttribute('data-chapter-id') ?? null;
  const tipFor = (id, source) => {
    const region = regions.find((entry) => entry.concept_id === id);
    return region
      ? {
          key: id,
          angle: (region.startAngle + region.endAngle) / 2,
          radius: ATLAS_LABEL_RADIUS,
          title: region.label_full,
          meta: chapterMeta(region, source === 'focus' ? 'Enter opens it' : 'Click to open it')
        }
      : null;
  };

  const handleKeyDown = (event) => {
    const currentId = chapterIdOf(event);
    if (!currentId) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenChapter(currentId, 'keyboard');
      return;
    }
    const nextId = nextChapterId(ids, currentId, event.key);
    if (nextId) {
      event.preventDefault();
      setActiveId(nextId);
      nodes.current.get(nextId)?.focus({ preventScroll: true });
    }
  };

  const focused = focus ? regions.find((region) => region.concept_id === focus.id) : null;
  return (
    <>
      <defs>
        {regions.flatMap((region) => {
          const plan = plans.get(region.id);
          return plan.lines.map((line, index) => (
            <path
              key={`${region.id}-${index}`}
              id={`${region.id}-label-path-${index}`}
              d={arcTextPath(line.baseline, region.startAngle + ATLAS_LABEL_PAD, region.endAngle - ATLAS_LABEL_PAD, plan.reversed, width, height)}
            />
          ));
        })}
      </defs>
      <g
        ref={groupRef}
        className={`ring-chapters${isInteractive ? ' is-interactive' : ''}`}
        role={isInteractive ? 'group' : undefined}
        aria-label={isInteractive ? CHAPTERS_LABEL : undefined}
        onKeyDown={isInteractive ? handleKeyDown : undefined}
        onFocus={
          isInteractive
            ? (event) => {
                const id = chapterIdOf(event);
                if (!id) return;
                setActiveId(id);
                setFocus({ id, isVisible: event.target.matches?.(':focus-visible') ?? true });
                onTip?.(tipFor(id, 'focus'), 'focus');
              }
            : undefined
        }
        onBlur={
          isInteractive
            ? () => {
                setFocus(null);
                onTip?.(null, 'focus');
              }
            : undefined
        }
      >
        {regions.map((region, index) => {
          const plan = plans.get(region.id);
          const icon = atlasIconPoint(region, width, height);
          const isSelected = region.concept_id === selectedChapterId;
          return (
            <g
              key={region.id}
              ref={(node) => {
                if (node) nodes.current.set(region.concept_id, node);
                else nodes.current.delete(region.concept_id);
              }}
              className={`ring-chapter${isSelected ? ' is-selected' : ''}`}
              data-chapter-id={isInteractive ? region.concept_id : undefined}
              role={isInteractive ? 'button' : undefined}
              tabIndex={isInteractive ? (region.concept_id === tabStopId ? 0 : -1) : undefined}
              aria-label={isInteractive ? region.label_full : undefined}
            >
              <path className={`ring-sector${isSelected ? ' is-selected' : ''}`} d={sectorPath(region, width, height)} />
              {isInteractive ? (
                <path
                  className="ring-chapter-hit"
                  d={sectorPath({ ...region, innerRadius: region.outerRadius, outerRadius: LABEL_HIT_OUTER }, width, height)}
                />
              ) : null}
              {showLabels ? (
                <g
                  className="ring-chapter-label"
                  aria-hidden="true"
                  onPointerEnter={isInteractive ? () => onTip?.(tipFor(region.concept_id, 'hover'), 'hover') : undefined}
                  onPointerLeave={isInteractive ? () => onTip?.(null, 'hover') : undefined}
                >
                  {plan.lines.map((line, lineIndex) => (
                    <text key={lineIndex} className="ring-curved-label" fontSize={plan.font}>
                      <textPath href={`#${region.id}-label-path-${lineIndex}`} startOffset="50%" textAnchor="middle">
                        {line.text}
                      </textPath>
                    </text>
                  ))}
                  <circle className="ring-badge" cx={icon.x} cy={icon.y} r={BADGE_RADIUS} />
                  <ChapterIcon icon={region.icon} cx={icon.x} cy={icon.y} size={BADGE_ICON} />
                  {isInteractive ? null : <title>{region.label_full}</title>}
                </g>
              ) : null}
            </g>
          );
        })}
      </g>
      {focused && focus.isVisible ? <path className="ring-sector-focus" d={sectorPath(focused, width, height)} aria-hidden="true" /> : null}
    </>
  );
}

/**
 * A chapter circle: block sectors (no fill), separators, the
 * blocks' short names on curved paths, and the chapter switch around it.
 *
 * Block names share one calm size per ring, the atlas chapter labels' size
 * (13 px at 1280–1440, never larger); a name that does not fit its arc at
 * that size is left out, never scaled or cut (arcLabels.planGroupLabel,
 * layout/groupLabels.js). Hovering a name, or a
 * chapter on the switch, shows its full title at once (FrameTip in
 * RingView), not after a native tooltip's delay.
 */
function ChapterFrame({ viewModel, showLabels, selectedGroupId, rim, onTip }) {
  const { width, height } = viewModel;
  const circle = viewModel.regions?.[0];
  const groups = viewModel.groups || [];
  const frameRef = useRef(null);
  const pxPerUnit = useRenderedScale(frameRef);
  // The chapter switch is one tab stop (the open chapter, or the last one
  // the arrows reached); arrows move along it, Enter opens a chapter.
  const rimNodes = useRef(new Map());
  const [rimActiveId, setRimActiveId] = useState(null);
  const rimIds = (rim?.regions || []).map((region) => region.concept_id);
  const rimTabStopId = rimIds.includes(rimActiveId) ? rimActiveId : rimIds.includes(rim?.currentChapterId) ? rim.currentChapterId : rimIds[0] ?? null;
  const plans = useMemo(
    () => new Map(groups.map((group) => [group.id, planGroupLabel({ ...group, label: groupShortLabel(group) }, pxPerUnit)])),
    [groups, pxPerUnit]
  );
  if (!circle) {
    return null;
  }
  const groupTip = (group) => ({
    key: group.id,
    angle: (group.startAngle + group.endAngle) / 2,
    radius: GROUP_LABEL_RADIUS,
    title: group.label_full,
    meta: group.id.startsWith('OTHER-') ? 'Smaller subchapters of this chapter, together' : 'Subchapter'
  });
  const rimTip = (region, isCurrent, source = 'hover') => ({
    key: region.concept_id,
    angle: (region.startAngle + region.endAngle) / 2,
    radius: RIM_RADIUS,
    title: region.label_full,
    meta: chapterMeta(region, isCurrent ? 'Open now' : source === 'focus' ? 'Enter opens it' : 'Click to open it')
  });
  return (
    <g ref={frameRef} className="ring-chapter-frame">
      <defs>
        {groups.map((group, index) => (
          <path key={group.id} id={`ring-group-label-${index}`} d={circleLabelArcPath(group, circle)} />
        ))}
      </defs>
      {groups.map((group) => (
        <path
          key={group.id}
          className={`ring-sector${group.id === selectedGroupId ? ' is-selected' : ''}`}
          d={sectorPath({ ...group, innerRadius: circle.innerRadius, outerRadius: circle.outerRadius }, width, height)}
        />
      ))}
      <path className="ring-band-outline" d={circleBandPath(circle)} />
      {(viewModel.separators || []).map((separator) => {
        const points = radialLinePoints(circle, separator.angle);
        return <line key={separator.id} className="ring-separator" x1={points.start.x} y1={points.start.y} x2={points.end.x} y2={points.end.y} />;
      })}
      {showLabels
        ? groups.map((group, index) => {
            const plan = plans.get(group.id);
            return plan ? (
              <text
                key={`${group.id}-label`}
                className="ring-curved-label is-group"
                fontSize={plan.font}
                aria-hidden="true"
                onPointerEnter={() => onTip?.(groupTip(group), 'hover')}
                onPointerLeave={() => onTip?.(null, 'hover')}
              >
                <textPath href={`#ring-group-label-${index}`} startOffset="50%" textAnchor="middle">
                  {plan.text}
                </textPath>
              </text>
            ) : null;
          })
        : null}
      {rim?.regions?.length ? (
        <g
          className="ring-rim"
          role="group"
          aria-label={RIM_LABEL}
          onKeyDown={(event) => {
            const currentId = event.target?.closest?.('[data-rim-id]')?.getAttribute('data-rim-id') ?? null;
            if (!currentId) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              if (currentId !== rim.currentChapterId) {
                onTip?.(null, 'focus');
                rim.onOpenChapter(currentId, 'keyboard');
              }
              return;
            }
            const nextId = nextChapterId(rimIds, currentId, event.key);
            if (nextId) {
              event.preventDefault();
              setRimActiveId(nextId);
              rimNodes.current.get(nextId)?.focus({ preventScroll: true });
            }
          }}
          onBlur={() => onTip?.(null, 'focus')}
        >
          {rim.regions.map((region) => {
            const isCurrent = region.concept_id === rim.currentChapterId;
            const angle = (region.startAngle + region.endAngle) / 2;
            return (
              <g
                key={region.id}
                ref={(node) => {
                  if (node) rimNodes.current.set(region.concept_id, node);
                  else rimNodes.current.delete(region.concept_id);
                }}
                className={`ring-rim-segment${isCurrent ? ' is-current' : ''}`}
                data-rim-id={region.concept_id}
                role="button"
                tabIndex={region.concept_id === rimTabStopId ? 0 : -1}
                aria-label={region.label_full}
                aria-current={isCurrent ? 'page' : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!isCurrent) {
                    onTip?.(null, 'hover');
                    rim.onOpenChapter(region.concept_id);
                  }
                }}
                onFocus={() => {
                  setRimActiveId(region.concept_id);
                  onTip?.(rimTip(region, isCurrent, 'focus'), 'focus');
                }}
                onPointerEnter={() => onTip?.(rimTip(region, isCurrent), 'hover')}
                onPointerLeave={() => onTip?.(null, 'hover')}
              >
                <path className="ring-rim-arc" d={arcPath(RIM_RADIUS, region.startAngle + RIM_GAP, region.endAngle - RIM_GAP)} />
                <ChapterIcon
                  icon={region.icon}
                  cx={500 + Math.sin(angle) * RIM_RADIUS}
                  cy={500 - Math.cos(angle) * RIM_RADIUS}
                  size={RIM_ICON}
                  className="ring-rim-icon"
                />
              </g>
            );
          })}
        </g>
      ) : null}
    </g>
  );
}

/**
 * Everything behind the bubbles. Memoized separately so recolouring the
 * bubbles never re-renders the frame.
 */
function RingFrame({ viewModel, showLabels, selectedChapterId, selectedGroupId, rim, onOpenChapter = null, onTip = null }) {
  return viewModel.kind === 'radial-atlas' ? (
    <AtlasFrame
      viewModel={viewModel}
      showLabels={showLabels}
      selectedChapterId={selectedChapterId}
      onOpenChapter={onOpenChapter}
      onTip={onTip}
    />
  ) : (
    <ChapterFrame viewModel={viewModel} showLabels={showLabels} selectedGroupId={selectedGroupId} rim={rim} onTip={onTip} />
  );
}

export default memo(RingFrame);
