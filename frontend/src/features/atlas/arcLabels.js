// Fitting curved labels to their arc: the atlas chapter labels and the
// subchapter labels around a chapter circle, sized from the rendered ring.

// ---------------------------------------------------------------------------
// Atlas chapter labels (S7, critique round 1 R2)
//
// The ring is SVG in a 960-unit viewBox that scales with its pane, so a fixed
// font size in SVG units renders too small on a laptop. A chapter label is
// sized from the ring's rendered scale (CSS px per SVG unit) so that it reads
// at no less than the 13 px floor, and its deliberate short name
// (chapterLabels.js) is chosen to fit its sector's arc at that size. It is
// never shortened with an ellipsis: a name that does not fit on one line
// breaks onto two, and only on a ring too small for either (a phone) does
// the font shrink below the floor.

/** Outer edge of a chapter's clickable rim band, past its label (the viewBox edge is 480). */
export const LABEL_HIT_OUTER = 480;

/**
 * The ring's scale (CSS px per SVG unit), rounded down to steps of 0.005
 * (about 5 px of ring width): resizing re-plans the labels only now and then,
 * and rounding down can only make a label larger, never break the floor.
 */
export function quantizeScale(pxPerUnit) {
  return Number.isFinite(pxPerUnit) && pxPerUnit > 0 ? Math.floor(pxPerUnit * 200) / 200 : null;
}

/** The smallest rendered size of a chapter label, in CSS px (The 13px Floor Rule). */
export const LABEL_MIN_PX = 13;
/** Font size in SVG units on a large ring (the label never gets smaller than the floor). */
export const ATLAS_LABEL_FONT = 17;
/** Centre line of a one-line label (the sectors end at 390, the chapter badges at 427). */
export const ATLAS_LABEL_RADIUS = 458;
/** Centre between the two lines of a two-line label. */
const TWO_LINE_RADIUS = 454;
/** Clear angle at each end of a chapter's arc, so neighbouring labels never touch. */
export const ATLAS_LABEL_PAD = 0.008;
/** Radial room for labels: outside the badges, inside the viewBox (centre 500, edge 480). */
const LABEL_INNER_LIMIT = 429;
const LABEL_OUTER_LIMIT = 479;
/** Half the height of a line of mixed-case text, in em (its ink sits within ±0.5em of its centre line). */
const HALF_LINE = 0.5;
/** Two lines sit this far (in em) from their shared centre. */
const LINE_OFFSET = 0.56;
/** Visual centre of mixed-case text above its baseline, in em. */
const OPTICAL_CENTRE = 0.35;

const NARROW = new Set([...'ijl.,:;\'|! ']);
const SEMI_NARROW = new Set([...'frtI-()']);
const WIDE = new Set([...'mw']);
const WIDE_CAPS = new Set([...'MW']);

/**
 * Estimated advance of a label in em, for the semibold system face of
 * `.ring-curved-label` (600, letter-spacing 0.01em). Calibrated against the
 * widths of every chapter short name as Chrome renders them at 13 px (SF Pro
 * Text): it never underestimates them, and overestimates by 1.5–8.5%.
 */
export function labelEm(text) {
  let width = 0;
  for (const char of String(text)) {
    if (NARROW.has(char)) width += 0.28;
    else if (SEMI_NARROW.has(char)) width += 0.37;
    else if (WIDE.has(char)) width += 0.87;
    else if (WIDE_CAPS.has(char)) width += 0.95;
    else if (char === '&') width += 0.72;
    else if (/[A-Z]/.test(char)) width += 0.68;
    else width += 0.575;
  }
  return width + 0.01 * String(text).length;
}

/** Whether a curved line text is drawn reversed (the lower half reads left to right). */
export function isReversedArc(startAngle, endAngle) {
  const mid = (startAngle + endAngle) / 2;
  return mid > Math.PI / 2 && mid < Math.PI * 1.5;
}

/** The split of a two-word-or-more name into two lines, at the space nearest its middle. */
function twoLines(text) {
  const spaces = [...text.matchAll(/ /g)].map((match) => match.index);
  if (!spaces.length) {
    return null;
  }
  const middle = text.length / 2;
  const at = spaces.reduce((best, index) => (Math.abs(index - middle) < Math.abs(best - middle) ? index : best));
  return [text.slice(0, at), text.slice(at + 1)];
}

/**
 * How one chapter's short label is drawn on the atlas rim: font size (SVG
 * units and rendered px), and one or two lines, each with the radius of its
 * centre line, the radius of its baseline (the path its text follows), and
 * its angular extent.
 *
 * @param {{ short_label: string, startAngle: number, endAngle: number }} region
 * @param {number|null} pxPerUnit CSS px per SVG unit of the rendered ring (null before it is measured)
 * @param {number} [maxFont] a cap on the font size (SVG units), so all labels of a small ring share one size
 * @returns {{ text: string, font: number, px: number|null, reversed: boolean, fitsFloor: boolean,
 *   lines: { text: string, radius: number, baseline: number, start: number, end: number }[] }}
 */
export function planChapterLabel(region, pxPerUnit = null, maxFont = Infinity) {
  const text = String(region.short_label || '').trim();
  const scale = Number.isFinite(pxPerUnit) && pxPerUnit > 0 ? pxPerUnit : null;
  const floorFont = scale ? (LABEL_MIN_PX + 0.05) / scale : 0;
  const preferred = Math.min(Math.max(ATLAS_LABEL_FONT, floorFont), maxFont);
  const span = region.endAngle - region.startAngle - 2 * ATLAS_LABEL_PAD;
  const mid = (region.startAngle + region.endAngle) / 2;
  const reversed = isReversedArc(region.startAngle, region.endAngle);
  const capacity = (radius) => span * radius;

  const layout = (font, texts, radii) => {
    const lines = texts.map((lineText, index) => {
      const radius = radii[index];
      const half = (labelEm(lineText) * font) / 2 / radius;
      // The path is the baseline: the ink sits outward of it on the upper
      // half and inward of it on the reversed lower half.
      const baseline = reversed ? radius + OPTICAL_CENTRE * font : radius - OPTICAL_CENTRE * font;
      return { text: lineText, radius, baseline, start: mid - half, end: mid + half };
    });
    return { text, font, px: scale ? font * scale : null, reversed, fitsFloor: !scale || font * scale >= LABEL_MIN_PX - 1e-9, lines };
  };

  // One line at the preferred size.
  if (labelEm(text) * preferred <= capacity(ATLAS_LABEL_RADIUS)) {
    return layout(preferred, [text], [ATLAS_LABEL_RADIUS]);
  }
  // Two lines, when they fit both the arc and the radial room. Reading
  // order: the first line is the upper one, outward on the upper half of
  // the ring and inward on the reversed lower half.
  const split = twoLines(text);
  const twoLineRadii = (font) => {
    const outer = TWO_LINE_RADIUS + LINE_OFFSET * font;
    const inner = TWO_LINE_RADIUS - LINE_OFFSET * font;
    return reversed ? [inner, outer] : [outer, inner];
  };
  const twoLinesFit = (font) => {
    const radii = twoLineRadii(font);
    const radialFit = Math.max(...radii) + HALF_LINE * font <= LABEL_OUTER_LIMIT && Math.min(...radii) - HALF_LINE * font >= LABEL_INNER_LIMIT;
    return radialFit && split.every((line, index) => labelEm(line) * font <= capacity(radii[index]));
  };
  if (split && twoLinesFit(preferred)) {
    return layout(preferred, split, twoLineRadii(preferred));
  }
  // A ring too small for the floor: the larger of one line shrunk to its
  // arc and two lines shrunk to their room.
  const oneLineFont = capacity(ATLAS_LABEL_RADIUS) / labelEm(text);
  if (split) {
    const radialMax = (LABEL_OUTER_LIMIT - TWO_LINE_RADIUS) / (LINE_OFFSET + HALF_LINE);
    const innerRadius = TWO_LINE_RADIUS - LINE_OFFSET * radialMax;
    const arcMax = Math.min(...split.map((line) => capacity(innerRadius) / labelEm(line)));
    const twoLineFont = Math.min(radialMax, arcMax, preferred);
    if (twoLineFont > oneLineFont && twoLinesFit(twoLineFont)) {
      return layout(twoLineFont, split, twoLineRadii(twoLineFont));
    }
  }
  return layout(oneLineFont, [text], [ATLAS_LABEL_RADIUS]);
}

/**
 * The labels of all chapters. Where every label keeps the floor, each is
 * planned on its own; on a ring too small for that (a phone, a tablet with
 * the results sheet open) they share the size of the one that had to shrink
 * most, so the rim reads as one set instead of a jumble of sizes.
 *
 * @param {{ id: string, short_label: string, startAngle: number, endAngle: number }[]} regions
 * @param {number|null} pxPerUnit
 * @returns {Map<string, ReturnType<typeof planChapterLabel>>} by region id
 */
export function planChapterLabels(regions, pxPerUnit = null) {
  const plans = regions.map((region) => planChapterLabel(region, pxPerUnit));
  if (plans.every((plan) => plan.fitsFloor)) {
    return new Map(regions.map((region, index) => [region.id, plans[index]]));
  }
  const shared = Math.min(...plans.map((plan) => plan.font));
  return new Map(regions.map((region) => [region.id, planChapterLabel(region, pxPerUnit, shared)]));
}

// ---------------------------------------------------------------------------
// Subchapter (block) labels around a chapter circle
//
// One calm size for every block name in every chapter: the size the atlas
// chapter labels take on the same ring (the 13 px floor, at most 23 units,
// the size every atlas label shares on a small ring), never larger. A name
// is never scaled to fill its arc and never cut: a name that does not fit
// its arc at that size is left out (its full title shows on hover and in the
// card), so the short-name table (layout/groupLabels.js) is written to fit.
// tests/chapterGroupLabels.test.js checks size, fit, and the gap to the rim.

/** Radius of a block label's baseline (the circle ends at 390, the rim band starts at 454). */
export const GROUP_LABEL_RADIUS = 414;
/** The chapter switch band around a chapter circle: centre radius and width (RingFrame.jsx). */
export const CHAPTER_RIM_RADIUS = 466;
export const CHAPTER_RIM_WIDTH = 24;
/** Clear angle at each end of a block's arc (at most), so neighbouring names never touch. */
export const GROUP_LABEL_PAD = 0.012;
/** The largest label font in SVG units: the atlas chapter labels' shared size on a small ring. */
export const GROUP_LABEL_MAX_FONT = 23;
/** Below this rendered size the labels are left out (the atlas labels reach about 7.5 px above a tablet's results sheet). */
export const GROUP_LABEL_MIN_PX = 7;

/**
 * The angular extent a block label may use: its arc less a small pad at each
 * end, at most 0.92 rad (radialPaths.circleLabelArcPath draws the same).
 */
export function groupLabelSpan(group) {
  const span = group.endAngle - group.startAngle;
  const pad = Math.min(GROUP_LABEL_PAD, Math.max(0.004, span * 0.08));
  return Math.min(Math.max(0.02, span - 2 * pad), 0.92);
}

/**
 * The one font size (SVG units) of every block label on a ring of this
 * scale: the atlas chapter labels' preferred size, the 13 px floor where the
 * ring allows, capped at the atlas labels' smallest-ring size.
 *
 * @param {number|null} pxPerUnit
 */
export function groupLabelFont(pxPerUnit = null) {
  const scale = Number.isFinite(pxPerUnit) && pxPerUnit > 0 ? pxPerUnit : null;
  const floorFont = scale ? (LABEL_MIN_PX + 0.05) / scale : 0;
  return Math.min(Math.max(ATLAS_LABEL_FONT, floorFont), GROUP_LABEL_MAX_FONT);
}

/**
 * How one block label is drawn, or null when it is left out: it does not
 * fit its arc at the one size, or the ring is too small for legible text.
 *
 * @param {{ label: string, startAngle: number, endAngle: number }} group with `label` already the short name
 * @param {number|null} pxPerUnit
 * @returns {{ text: string, font: number, px: number|null, fitsFloor: boolean }|null}
 */
export function planGroupLabel(group, pxPerUnit = null) {
  const text = String(group.label || '').trim();
  if (!text) {
    return null;
  }
  const scale = Number.isFinite(pxPerUnit) && pxPerUnit > 0 ? pxPerUnit : null;
  const font = groupLabelFont(scale);
  if (labelEm(text) * font > groupLabelSpan(group) * GROUP_LABEL_RADIUS) {
    return null;
  }
  if (scale && font * scale < GROUP_LABEL_MIN_PX) {
    return null;
  }
  return { text, font, px: scale ? font * scale : null, fitsFloor: !scale || font * scale >= LABEL_MIN_PX - 1e-9 };
}
