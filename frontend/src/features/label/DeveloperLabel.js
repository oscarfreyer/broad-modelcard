// The model card (once called the "label"): one fixed sheet that summarises a card at a dataset version and
// points back to it. It leads with the tile's snapshot, larger, then the
// Overview distribution, the version and date, the card link as text, the
// demonstration notice, and, in a separate block, what the developer
// declares. One SVG, so the SVG download is this component serialised and
// the PDF embeds the same drawing.
//
// Plain JS (createElement, no JSX) so the node tests can render it.
import { createElement as h } from 'react';
import { BRAND_COLORS, brandBubbles } from '../../design/brandMark.js';
import { StatusMarkShape } from '../../design/StatusMark.js';
import { resultPopulationLabel } from '../../shared/resultPopulation.js';
import CardSnapshot from './CardSnapshot.js';
import { DECLARATIONS_NOTE, LOCAL_LINK_NOTE, labelText, mitigatedNote } from './labelModel.js';
import { textWidth, wrapText } from './textWrap.js';

export const LABEL_WIDTH = 360;
const PAD = 20;
const INNER = LABEL_WIDTH - PAD * 2;
/** The snapshot leads the sheet, centred (the tile's hero, grown up). */
const SNAPSHOT = 232;
const BRAND = 32;
const SNAPSHOT_CAPTION = 'Each bubble is one ICD-11 subchapter, placed as on the card\'s atlas.';
// Wrap widths keep a margin under the estimate: addresses and links run a
// little wider than the system sans's average advances (textWrap.js).
const SLACK = 10;
const BADGE = 'Synthetic data';

/** What the card link says on the model card; its href is the full address. */
export const CARD_LINK_TEXT = 'Open this card';

/** A short, readable form of the card link: host and page, without the query ("127.0.0.1:5173/atlas.html"). */
export function shortLink(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function lines(className, textLines, x, y, lineHeight, extra = {}) {
  return textLines.map((line, index) => h('text', { key: `${className}-${index}-${y}`, className, x, y: y + index * lineHeight, ...extra }, line));
}

/**
 * Lays the label out top to bottom and returns its elements and height.
 * Exported for tests (figures and wording) without a DOM.
 */
export function labelElements(model, geometry = null) {
  const els = [];
  let y = PAD;

  // Brand line: what the sheet is, and at once that its data is synthetic
  // (the full notice closes the sheet).
  const badgeWidth = Math.ceil(textWidth(BADGE, 13, { bold: true })) + 16;
  const brandScale = BRAND / 32;
  els.push(
    h('g', { key: 'brand-mark', className: 'label-brand-mark', transform: `translate(${PAD - 1} ${y - 1}) scale(${brandScale})` },
      ...brandBubbles(BRAND).map(({ cx, cy, r, tone }) => h('circle', { key: `${cx}-${cy}`, cx, cy, r, fill: BRAND_COLORS[tone] }))
    ),
    // What the sheet is, under the product name.
    h('text', { key: 'brand', className: 'label-brand', x: PAD + 40, y: y + 12 }, 'Broad Modelcard'),
    h('text', { key: 'brand-sheet', className: 'label-caption', x: PAD + 40, y: y + 28 }, 'Model card'),
    h('g', { key: 'badge', className: 'label-badge' },
      h('rect', { className: 'label-badge-box', x: LABEL_WIDTH - PAD - badgeWidth, y: y + 5, width: badgeWidth, height: 20, rx: 10 }),
      h('text', { className: 'label-badge-text', x: LABEL_WIDTH - PAD - badgeWidth / 2, y: y + 19, textAnchor: 'middle' }, BADGE)
    )
  );
  y += 42;
  els.push(h('line', { key: 'rule-top', className: 'label-rule', x1: PAD, x2: LABEL_WIDTH - PAD, y1: y, y2: y }));
  y += 30;

  // Identity: the AI system and its function, then the facts.
  const name = wrapText(model.systemName, INNER, 24, { bold: true, maxLines: 2 });
  els.push(...lines('label-title', name, PAD, y + 2, 28));
  y += (name.length - 1) * 28 + 26;
  const fn = wrapText(model.functionName, INNER, 16, { maxLines: 2 });
  els.push(...lines('label-function', fn, PAD, y, 21));
  y += (fn.length - 1) * 21 + 21;
  const factText = [...model.facts, model.release ? `Released ${model.release}` : null].filter(Boolean).join(', ');
  const facts = [
    ...wrapText(factText, INNER, 13, { maxLines: 3 }),
    ...(model.builtOn.length ? wrapText(`Built on ${model.builtOn.join(', ')}`, INNER, 13, { maxLines: 2 }) : []),
    // The deployed configuration (contract v1.14, §28.1): its label and date, one line.
    ...(model.configuration ? wrapText(model.configuration, INNER, 13, { maxLines: 1 }) : [])
  ];
  els.push(...lines('label-fact', facts, PAD, y, 18));
  y += (facts.length - 1) * 18 + 22;

  // The snapshot leads, centred and large: the card's atlas in miniature.
  const snapX = (LABEL_WIDTH - SNAPSHOT) / 2;
  els.push(
    h(CardSnapshot, {
      key: 'snapshot',
      geometry,
      blocks: model.snapshotBlocks,
      hasIntendedUse: model.hasIntendedUse,
      size: SNAPSHOT,
      x: snapX,
      y
    })
  );
  y += SNAPSHOT + 18;
  const caption = wrapText(SNAPSHOT_CAPTION, INNER - SLACK * 4, 13);
  els.push(...lines('label-caption', caption, LABEL_WIDTH / 2, y, 17, { textAnchor: 'middle' }));
  y += (caption.length - 1) * 17 + 32;

  // The Overview distribution, one row per state (mark, word, count, share).
  els.push(
    h('text', { key: 'dist-head', className: 'label-heading', x: PAD, y }, 'Overview'),
    h('text', { key: 'dist-sub', className: 'label-caption', x: LABEL_WIDTH - PAD, y, textAnchor: 'end' }, `${model.total.toLocaleString('en-US')} conditions, all patients`)
  );
  y += 22;
  model.rows.forEach((row) => {
    els.push(
      h('g', { key: `row-${row.status}`, className: 'label-row', 'data-status': row.status, 'data-count': row.count },
        h(StatusMarkShape, { status: row.status, cx: PAD + 5.5, cy: y - 4.5, r: 5.5 }),
        h('text', { className: 'label-row-word', x: PAD + 18, y }, row.label),
        h('text', { className: 'label-figure', x: LABEL_WIDTH - PAD - 44, y, textAnchor: 'end' }, row.count.toLocaleString('en-US')),
        h('text', { className: 'label-share', x: LABEL_WIDTH - PAD, y, textAnchor: 'end' }, row.share)
      )
    );
    y += 19;
  });
  // No statement: said where Out of scope would be counted.
  if (model.noStatement) {
    els.push(h('text', { key: 'no-statement', className: 'label-note', x: PAD, y: y + 1 }, model.noStatement));
    y += 20;
  }
  y += 12;

  // Open safety incidents: only when the data carries them (S3); never a made-up 0.
  if (model.incidents && !model.incidents.open) {
    // None open: one quiet mark and the words, never "0 serious, 0 caution" and never green.
    els.push(
      h('text', { key: 'inc-head', className: 'label-heading', x: PAD, y }, 'Open safety incidents'),
      h('g', { key: 'inc-none', className: 'label-row', 'data-status': 'no_incidents', 'data-count': 0 },
        h(StatusMarkShape, { status: 'no_incidents', cx: PAD + 165.5, cy: y - 4.5, r: 5.5 }),
        h('text', { className: 'label-row-word', x: PAD + 176, y }, 'None open')
      )
    );
    y += 22;
  } else if (model.incidents) {
    const { serious, caution } = model.incidents;
    els.push(h('text', { key: 'inc-head', className: 'label-heading', x: PAD, y }, 'Open safety incidents'));
    const parts = [
      ['serious', serious, 'Serious'],
      ['caution', caution, 'Caution']
    ];
    // Placed by measured width after the heading, or on their own line when
    // larger counts would not fit beside it.
    const widths = parts.map(([, count, word]) => 16 + Math.ceil(textWidth(`${count} ${word.toLowerCase()}`, 13, { bold: true })));
    const besideX = PAD + Math.ceil(textWidth('Open safety incidents', 14, { bold: true })) + 14;
    const fitsBeside = besideX + widths.reduce((sum, width) => sum + width + 14, -14) <= LABEL_WIDTH - PAD;
    let x = fitsBeside ? besideX : PAD;
    if (!fitsBeside) y += 20;
    parts.forEach(([status, count, word]) => {
      const text = `${count} ${word.toLowerCase()}`;
      els.push(
        h('g', { key: `inc-${status}`, className: 'label-row', 'data-status': status, 'data-count': count },
          h(StatusMarkShape, { status: count ? status : 'no_incidents', cx: x + 5.5, cy: y - 4.5, r: 5.5 }),
          h('text', { className: 'label-row-word', x: x + 16, y }, text)
        )
      );
      x += 16 + Math.ceil(textWidth(text, 13, { bold: true })) + 14;
    });
    y += 22;
  }
  // A mitigated incident is not open, but the ring marks it Caution where it applies: say so.
  if (model.incidents?.mitigated) {
    const note = wrapText(mitigatedNote(model.incidents.mitigated), INNER - SLACK, 13);
    els.push(...lines('label-note', note, PAD, y - 2, 17));
    y += note.length * 17 + 4;
  }

  // Version, date, population, and the card link.
  els.push(h('line', { key: 'rule-facts', className: 'label-rule', x1: PAD, x2: LABEL_WIDTH - PAD, y1: y - 6, y2: y - 6 }));
  y += 14;
  const valueX = PAD + 126;
  const valueWidth = LABEL_WIDTH - PAD - valueX - SLACK;
  const factRows = [
    ['Population', resultPopulationLabel(model.lens, model.population, { separator: ', ' })],
    // Only for a label made under a local population: which one, marked synthetic.
    ...(model.prevalence ? [['Prevalence', model.prevalence]] : []),
    // Who runs this copy of Broad Modelcard (§26), when known.
    ...(model.publishedBy ? [['Published by', model.publishedBy]] : []),
    ['Dataset version', model.isPreview ? 'Unpublished preview, not live' : model.datasetVersion],
    ['Card last changed', model.lastChanged ? `${model.lastChanged.date} (version ${model.lastChanged.version})` : 'Not available'],
    ['Card', model.cardUrl]
  ];
  factRows.forEach(([label, value]) => {
    const isLink = label === 'Card';
    // The card link reads "Open this card" over the full address (its href),
    // with the address's host and page under it; the PDF prints the full
    // address under the picture, so a printed model card still leads to its card.
    const valueLines = isLink ? [CARD_LINK_TEXT] : wrapText(value, valueWidth, 13, { maxLines: 4 });
    const valueEls = lines(isLink ? 'label-fact-value label-link' : 'label-fact-value', valueLines, valueX, y, 17);
    els.push(
      h('text', { key: `fact-${label}`, className: 'label-fact-label', x: PAD, y }, label),
      ...(isLink ? [h('a', { key: 'card-link', className: 'label-card-link', href: value, target: '_blank' }, ...valueEls)] : valueEls)
    );
    y += valueLines.length * 17 + 4;
    if (isLink) {
      const where = wrapText(shortLink(value), valueWidth, 13, { maxLines: 2 });
      els.push(...lines('label-note', where, valueX, y, 17));
      y += where.length * 17 + 4;
    }
    if (isLink && model.cardUrlIsLocal) {
      const note = wrapText(LOCAL_LINK_NOTE, valueWidth, 13);
      els.push(...lines('label-note', note, valueX, y, 17));
      y += note.length * 17 + 4;
    }
  });
  y += 12;

  // Declared by the developer: a separate block with its own heading and note.
  const boxTop = y;
  const boxInner = INNER - 28 - SLACK;
  let by = boxTop + 26;
  const boxEls = [h('text', { key: 'decl-head', className: 'label-declared-heading', x: PAD + 14, y: by }, 'Declared by the developer')];
  by += 19;
  const note = wrapText(DECLARATIONS_NOTE, boxInner, 13);
  boxEls.push(...lines('label-note', note, PAD + 14, by, 17));
  by += note.length * 17 + 8;
  if (model.declarations.length) {
    model.declarations.forEach((declaration) => {
      boxEls.push(h('text', { key: `decl-${declaration.key}`, className: 'label-declared-label', x: PAD + 14, y: by }, declaration.label));
      by += 17;
      const value = wrapText(declaration.value, boxInner, 13, { maxLines: 4 });
      boxEls.push(...lines('label-declared-value', value, PAD + 14, by, 17));
      by += value.length * 17 + 6;
    });
  } else {
    boxEls.push(h('text', { key: 'decl-none', className: 'label-declared-value', x: PAD + 14, y: by }, 'Nothing declared.'));
    by += 23;
  }
  // The developer's own model card (§26): one reference line, as unchecked as the declarations.
  if (model.narrowCard) {
    const reference = wrapText(model.narrowCard, boxInner, 13, { maxLines: 3 });
    boxEls.push(...lines('label-note', reference, PAD + 14, by, 17));
    by += reference.length * 17 + 6;
  }
  const boxHeight = by - boxTop + 4;
  els.push(
    h('g', { key: 'declared', className: 'label-declared' },
      h('rect', { className: 'label-declared-box', x: PAD, y: boxTop, width: INNER, height: boxHeight, rx: 12 }),
      ...boxEls
    )
  );
  y = boxTop + boxHeight + 14;

  // The demonstration notice closes the label.
  const notice = wrapText(model.notice, INNER - 24, 13, { bold: true });
  const noticeHeight = notice.length * 17 + 18;
  els.push(
    h('g', { key: 'notice', className: 'label-notice-group' },
      h('rect', { className: 'label-notice-box', x: PAD, y, width: INNER, height: noticeHeight, rx: 10 }),
      ...lines('label-notice', notice, PAD + 12, y + 22, 17)
    )
  );
  y += noticeHeight + PAD;

  return { elements: els, height: Math.ceil(y) };
}

/**
 * @param {object} props
 * @param {ReturnType<import('./labelModel.js').buildLabelModel>} props.model
 * @param {ReturnType<import('./snapshot.js').snapshotGeometry>} [props.geometry] the snapshot geometry (null draws its placeholder)
 * @param {number} [props.scale] rendered size relative to 360 px wide
 * @param {object} [props.svgRef] a ref to the root <svg>, for the downloads
 */
export default function DeveloperLabel({ model, geometry = null, scale = 1, svgRef = null }) {
  const { elements, height } = labelElements(model, geometry);
  // Assistive technology and the SVG file read the whole label as text, not only its name.
  const id = `label-${String(model.cardId ?? 'card').replace(/[^a-zA-Z0-9-]+/g, '-')}`;
  return h(
    'svg',
    {
      ref: svgRef,
      className: 'developer-label',
      xmlns: 'http://www.w3.org/2000/svg',
      width: LABEL_WIDTH * scale,
      height: height * scale,
      viewBox: `0 0 ${LABEL_WIDTH} ${height}`,
      role: 'img',
      'aria-labelledby': `${id}-title ${id}-desc`
    },
    h('title', { id: `${id}-title` }, `Model card for ${model.systemName}, ${model.functionName}, dataset version ${model.datasetVersion}`),
    h('desc', { id: `${id}-desc` }, labelText(model).join(' ')),
    h('rect', { className: 'label-frame', x: 0.5, y: 0.5, width: LABEL_WIDTH - 1, height: height - 1, rx: 20 }),
    ...elements
  );
}
