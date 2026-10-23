// The one mark per state. Every status dot,
// ring bubble, subchapter centre, key entry, and range-chart absence row
// draws its state through this module, so each state looks the same at
// every size and on every surface. The look lives in styles/marks.css and
// the tokens in styles/tokens.css (--mark-*).
//
// Plain JS (createElement, no JSX) so the node tests can render it.
import { createElement as h, Fragment } from 'react';
import { markShapes } from './markShapes.js';

export { markShapes };

/**
 * A mark inside an SVG: the ring bubble, a subchapter centre, a key sample.
 * `bodyProps` go onto the body circle (a ref, role, tabIndex, data-*,
 * aria-*), and `className` is added to its class.
 *
 * @param {object} props
 * @param {string} props.status display key
 * @param {number} props.cx
 * @param {number} props.cy
 * @param {number} props.r
 * @param {string} [props.className]
 * @param {object} [props.bodyProps]
 */
export function StatusMarkShape({ status, cx, cy, r, className = '', bodyProps = null }) {
  const shapes = markShapes(status, { cx, cy, r });
  return h(
    Fragment,
    null,
    ...shapes.map((shape, index) => {
      if (shape.role === 'body') {
        return h(shape.type, {
          key: index,
          ...bodyProps,
          ...shape.props,
          className: className ? `${shape.props.className} ${className}` : shape.props.className,
          'data-status': status
        });
      }
      return h(shape.type, { key: index, ...shape.props, 'aria-hidden': 'true' });
    })
  );
}

/**
 * A mark as an inline icon in HTML text: status labels, the centre counts,
 * the key, Summary, the candidate list, the change summary, range charts.
 *
 * @param {object} props
 * @param {string} props.status display key
 * @param {number} [props.size] px, 12 by default
 */
export default function StatusMark({ status, size = 12 }) {
  const half = size / 2;
  return h(
    'svg',
    {
      className: 'status-mark',
      width: size,
      height: size,
      viewBox: `0 0 ${size} ${size}`,
      'aria-hidden': 'true',
      focusable: 'false',
      'data-status': status
    },
    h(StatusMarkShape, { status, cx: half, cy: half, r: half - 1 })
  );
}
