// The Broad Modelcard mark: the atlas ring in
// its simplest form, a band of bubbles of varied sizes on a circle with an
// open centre, a few in the strong green and the rest in a quiet grey. No
// stroke, no centre dot: nothing about it reads as a target.
//
// The one source of truth. React-free, so the catalogue, the atlas toolbar,
// the Data Library, the live panel (embed/, no React), the model card, and
// the favicons of every page draw the same bubbles. `BrandMark.jsx` renders
// it for React; `brandMarkSvg` is the standalone file the favicons inline
// (a test keeps the pages' data URIs equal to it).

/** The mark's own coordinate system (viewBox 0 0 32 32). */
export const BRAND_VIEWBOX = 32;

/**
 * Fills: the atlas's Strong teal green and the quiet grey of the Safety view's
 * neutral disc (Brand mark). Literal values, because the
 * favicons and the downloaded model card carry no stylesheet;
 * tests/brandMark.test.js keeps them equal to their tokens in
 * styles/tokens.css (the Strong fill and the quiet mark).
 */
export const BRAND_COLORS = Object.freeze({ strong: '#48a08c', quiet: '#d1d1d6' });

const CENTRE = BRAND_VIEWBOX / 2;

/**
 * Bubbles packed around one circle like the atlas packs a chapter: their
 * relative sizes are scaled until they fill the full turn with `gap` between
 * neighbours, from `startAngle` (twelve o'clock is 0) clockwise.
 */
function ringRow(radius, sizes, tones, { startAngle = 0, gap = 0.8 } = {}) {
  const spanFor = (k) => sizes.map((size) => 2 * Math.asin(Math.min(0.99, (size * k + gap / 2) / radius)));
  const total = (k) => spanFor(k).reduce((sum, span) => sum + span, 0);
  let low = 0;
  let high = radius;
  for (let step = 0; step < 40; step += 1) {
    const mid = (low + high) / 2;
    if (total(mid) <= Math.PI * 2) low = mid;
    else high = mid;
  }
  const spans = spanFor(low);
  const round = (value) => Math.round(value * 100) / 100;
  let angle = startAngle;
  return sizes.map((size, index) => {
    const mid = angle + spans[index] / 2;
    angle += spans[index];
    return { cx: round(CENTRE + Math.sin(mid) * radius), cy: round(CENTRE - Math.cos(mid) * radius), r: round(size * low), tone: tones[index] };
  });
}

// Full mark (above 20 px): an outer row of eleven bubbles and an inner row of
// seven smaller ones, packed like the atlas's band around its open centre.
// The green run starts at twelve o'clock, where the atlas starts.
const FULL = Object.freeze([
  ...ringRow(11.6, [1.25, 0.95, 1.15, 0.8, 1.0, 1.2, 0.85, 1.1, 0.8, 1.0, 0.9], ['strong', 'strong', 'strong', 'quiet', 'quiet', 'quiet', 'quiet', 'quiet', 'quiet', 'quiet', 'strong'], { startAngle: 0.1 }),
  ...ringRow(5.9, [1.1, 0.9, 1.0, 0.85, 1.05, 0.9, 1.0], ['strong', 'strong', 'quiet', 'quiet', 'quiet', 'quiet', 'quiet'], { startAngle: 0.35, gap: 1.2 })
]);

// Small mark (favicons, 20 px and under): one row of six bubbles, large
// enough to stay round at 16 px; two of them green.
const SMALL = Object.freeze(
  ringRow(9.9, [1.2, 0.95, 1.05, 0.8, 1.1, 0.85], ['strong', 'strong', 'quiet', 'quiet', 'quiet', 'quiet'], { startAngle: 0.15, gap: 1.1 })
);

/** Below this rendered size (px) the small mark is drawn. */
export const BRAND_SMALL_MAX = 20;

/**
 * The bubbles of the mark for a rendered size.
 *
 * @param {number} [size] rendered px
 * @returns {readonly { cx: number, cy: number, r: number, tone: 'strong'|'quiet' }[]}
 */
export function brandBubbles(size = 32) {
  return size <= BRAND_SMALL_MAX ? SMALL : FULL;
}

/**
 * The mark as a standalone SVG document (favicons, previews).
 *
 * @param {number} [size] rendered px; picks the small or full mark
 */
export function brandMarkSvg(size = 32) {
  const circles = brandBubbles(size)
    .map(({ cx, cy, r, tone }) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${BRAND_COLORS[tone]}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BRAND_VIEWBOX} ${BRAND_VIEWBOX}">${circles}</svg>`;
}

/** The favicon as a data URI (the small mark), as every page's `<link rel="icon">` carries it. */
export function brandFaviconHref() {
  return `data:image/svg+xml,${encodeURIComponent(brandMarkSvg(16))}`;
}
