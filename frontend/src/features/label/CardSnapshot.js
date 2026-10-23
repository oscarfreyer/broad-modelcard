// The card snapshot as SVG (snapshot.js): the atlas ring in miniature, one
// bubble per subchapter, each drawn with the one mark of its state
// (StatusMarkShape). The catalogue tile and the model card draw it at two
// sizes. Without the geometry yet (the atlas structure is loading), it draws
// the ring's band as a pale placeholder of the same size, so nothing moves.
//
// Plain JS (createElement, no JSX) so the node tests can render it.
import { createElement as h } from 'react';
import { StatusMarkShape } from '../../design/StatusMark.js';
import { ALERT_ORDER, DISPLAY, SAFETY_ORDER, STATUS_ORDER } from '../../design/status.js';
import { MODELCARD_INNER_RADIUS, MODELCARD_OUTER_RADIUS, MODELCARD_STAGE_SIZE } from '../atlas/layout/atlasGeometry.js';
import { SNAPSHOT_MODES, markCounts, snapshotMarks } from './snapshot.js';

const CENTRE = MODELCARD_STAGE_SIZE / 2;
// An incident mark keeps its subchapter's size, like every other bubble
// (2026-10-15: no enlarged warnings); it is drawn last, over its
// neighbours, and its vivid fill makes it stand out.

function isAlert(status) {
  return ALERT_ORDER.includes(status);
}

function countsText(counts, order) {
  const parts = order
    .filter((key) => (counts[key] ?? 0) > 0)
    .map((key) => `${counts[key].toLocaleString('en-US')} ${DISPLAY[key].label.toLowerCase()}`);
  return parts.join(', ');
}

/** The accessible description of a snapshot: what each subchapter shows, in words. */
export function snapshotDescription(marks, mode) {
  const counts = markCounts(marks);
  if (mode === SNAPSHOT_MODES.safety) {
    return `Safety incidents by ICD-11 subchapter, as on the atlas ring: ${countsText(counts, SAFETY_ORDER) || 'no subchapters'}.`;
  }
  return `Overview by ICD-11 subchapter, as on the atlas ring: ${countsText(counts, ['serious', 'caution', ...STATUS_ORDER]) || 'no subchapters'}.`;
}

/**
 * @param {object} props
 * @param {ReturnType<import('./snapshot.js').snapshotGeometry>} props.geometry null while the structure loads
 * @param {object[]} [props.blocks] tile.snapshot.blocks (CONTRACT.md §17)
 * @param {'overview'|'safety'} [props.mode]
 * @param {boolean} [props.hasIntendedUse] the card has an intended-use statement
 * @param {number} [props.size] rendered px; the geometry scales with it
 * @param {number} [props.x] position inside a parent SVG (the model card)
 * @param {number} [props.y]
 * @param {boolean} [props.decorative] hide from assistive tech (the tile says the counts in text)
 */
export default function CardSnapshot({
  geometry,
  blocks = [],
  mode = SNAPSHOT_MODES.overview,
  hasIntendedUse = true,
  size = 200,
  x,
  y,
  decorative = false
}) {
  const marks = snapshotMarks(blocks, geometry, mode, { hasIntendedUse });
  const extent = geometry?.extent ?? MODELCARD_OUTER_RADIUS + 6;
  const viewBox = geometry?.viewBox ?? `${CENTRE - extent} ${CENTRE - extent} ${extent * 2} ${extent * 2}`;
  let a11y = { 'aria-hidden': 'true', focusable: 'false' };
  if (!decorative) {
    a11y = { role: 'img', 'aria-label': geometry ? snapshotDescription(marks, mode) : 'The card snapshot is loading.' };
  }
  const band = (MODELCARD_OUTER_RADIUS - MODELCARD_INNER_RADIUS) * 0.84;
  return h(
    'svg',
    {
      className: `card-snapshot is-${mode}${geometry ? '' : ' is-loading'}`,
      width: size,
      height: size,
      x,
      y,
      viewBox,
      'data-mode': mode,
      ...a11y
    },
    geometry
      ? [
          ...marks.filter((mark) => !isAlert(mark.status)).map((mark) => h(StatusMarkShape, { key: mark.id, status: mark.status, cx: mark.x, cy: mark.y, r: mark.r })),
          // Incident marks last, over their neighbours, at their own size.
          ...marks
            .filter((mark) => isAlert(mark.status))
            .map((mark) => h(StatusMarkShape, { key: mark.id, status: mark.status, cx: mark.x, cy: mark.y, r: mark.r }))
        ]
      : h('circle', {
          className: 'snapshot-placeholder',
          cx: CENTRE,
          cy: CENTRE,
          r: MODELCARD_INNER_RADIUS + band / 2 + 8,
          strokeWidth: band
        })
  );
}
