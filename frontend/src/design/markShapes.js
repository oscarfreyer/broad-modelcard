// The geometry of the one mark per state: the
// shapes every status mark is drawn from. React-free, so the embeddable live
// panel (embed/, no React) draws the same marks as the atlas; StatusMark.js
// renders these shapes as React elements. The look lives in styles/marks.css
// and the tokens in styles/tokens.css (--mark-*).
import { displayFor } from './status.js';

/**
 * The shapes of one mark at centre (cx, cy) and radius r, in user units.
 * The first shape is the body (the bubble itself on the ring); the rest are
 * glyphs drawn on top of it and never take pointer events.
 *
 * - fill (Strong, Moderate, Weak, In scope): a disc in its fill with a 1px
 *   darker edge
 * - half (Partly in scope): a pale disc with its edge, the left half filled
 * - outline (No data): a light grey, opaque disc with a solid dark grey 1.5px outline
 * - slashed (No mapping, another ontology, contract v1.13): the No data disc struck
 *   through by a thin dark diagonal, like the empty-set sign ⊘: nothing to map to
 * - barred (Out of scope): a grey disc crossed by a white bar
 * - dot (No stored combination): no disc, a small grey dot in the centre
 * - pale (Loading): a pale disc without an edge
 * - quiet (No reported incidents, Safety view): a light neutral disc
 * - alert (Caution, Serious, Safety view): a fill with its edge and a "!"
 *
 * @param {string} status display key
 * @param {{ cx: number, cy: number, r: number }} geometry
 * @returns {{ type: string, role: 'body'|'glyph', props: object }[]}
 */
export function markShapes(status, { cx, cy, r }) {
  const { form, tone } = displayFor(status);
  const shapes = [
    { type: 'circle', role: 'body', props: { className: `mark mark-${form} tone-${tone}`, cx, cy, r } }
  ];
  if (form === 'barred') {
    const width = r * 1.2;
    const height = Math.max(r * 0.26, 0.6);
    shapes.push({
      type: 'rect',
      role: 'glyph',
      props: { className: 'mark-glyph mark-glyph-bar', x: cx - width / 2, y: cy - height / 2, width, height, rx: height / 2 }
    });
  } else if (form === 'half') {
    shapes.push({
      type: 'path',
      role: 'glyph',
      props: { className: `mark-glyph mark-glyph-half tone-${tone}`, d: `M ${cx} ${cy - r} A ${r} ${r} 0 0 0 ${cx} ${cy + r} Z` }
    });
  } else if (form === 'slashed') {
    const length = r * 1.5;
    const width = Math.max(r * 0.17, 0.45);
    shapes.push({
      type: 'rect',
      role: 'glyph',
      props: {
        className: 'mark-glyph mark-glyph-slash',
        x: cx - length / 2,
        y: cy - width / 2,
        width: length,
        height: width,
        rx: width / 2,
        transform: `rotate(-45 ${cx} ${cy})`
      }
    });
  } else if (form === 'dot') {
    shapes.push({ type: 'circle', role: 'glyph', props: { className: 'mark-glyph mark-glyph-dot', cx, cy, r: Math.max(r * 0.5, 1.2) } });
  } else if (form === 'alert') {
    const stem = r * 0.24;
    shapes.push(
      {
        type: 'rect',
        role: 'glyph',
        props: { className: `mark-glyph mark-glyph-alert tone-${tone}`, x: cx - stem / 2, y: cy - r * 0.6, width: stem, height: r * 0.68, rx: stem / 2 }
      },
      { type: 'circle', role: 'glyph', props: { className: `mark-glyph mark-glyph-alert tone-${tone}`, cx, cy: cy + r * 0.42, r: stem * 0.6 } }
    );
  }
  return shapes;
}
