// The "Not directly comparable" line under a row's name (CONTRACT.md §25): the row's own reasons in words. The reasons that hold on
// every row are said once above the table. Plain JS (createElement, no JSX)
// so the node tests can render it.
import { createElement as h } from 'react';
import { NOT_COMPARABLE, reasonText, rowOnlyReasons } from './compareCopy.js';

/**
 * @param {object} props
 * @param {object} props.row a getComparison row
 * @param {object[]} props.cardReasons the answer's card_reasons
 * @param {Map<string, string>} props.names card id → short name
 * @param {number} props.cardCount
 * @param {object[]} [props.cards] the card facts, so a reason can name what differs (v1.14)
 */
export default function ComparisonFlag({ row, cardReasons, names, cardCount, cards = [] }) {
  const reasons = rowOnlyReasons(row, cardReasons);
  if (!reasons.length) {
    return null;
  }
  return h(
    'p',
    { className: 'cmp-flag' },
    h('span', { className: 'cmp-flag-title' }, `${NOT_COMPARABLE}:`),
    ' ',
    reasons.map((reason) => reasonText(reason, names, cardCount, { cards, row })).join('; ')
  );
}
