import { BRAND_COLORS, BRAND_VIEWBOX, brandBubbles } from './brandMark.js';

/**
 * The Broad Modelcard mark (brandMark.js): a ring of bubbles, as on the atlas.
 * Decorative by default; pass `label` where the mark stands alone for the name.
 *
 * @param {{ size?: number, className?: string, label?: string|null }} props
 */
export default function BrandMark({ size = 26, className = '', label = null }) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true', focusable: 'false' };
  return (
    <svg className={`brand-mark ${className}`.trim()} width={size} height={size} viewBox={`0 0 ${BRAND_VIEWBOX} ${BRAND_VIEWBOX}`} {...a11y}>
      {brandBubbles(size).map(({ cx, cy, r, tone }) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill={BRAND_COLORS[tone]} />
      ))}
    </svg>
  );
}
