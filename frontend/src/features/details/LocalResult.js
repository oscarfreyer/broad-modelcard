// "Local and public" on the condition card (contract v1.13, CONTRACT.md §26).
// Plain JS (createElement, no JSX) so the node tests can render it; the copy
// is in copy/localCopy.js.
import { createElement as h } from 'react';
import StatusMark from '../../design/StatusMark.js';
import { localComparison } from './copy/localCopy.js';

function valueCell(entry) {
  return h(
    'td',
    null,
    h(
      'span',
      { className: 'local-compare-value' },
      entry.status ? h(StatusMark, { status: entry.status, size: 12 }) : null,
      h('span', null, entry.word),
      entry.figure ? h('span', { className: 'local-compare-figure' }, entry.figure) : null
    )
  );
}

function facts(title, list) {
  if (!list.length) return null;
  return h(
    'div',
    { className: 'local-compare-source' },
    h('h4', { className: 'local-compare-source-title' }, title),
    h(
      'dl',
      { className: 'fact-list' },
      list.map((fact) => h('div', { key: fact.label, className: 'fact-row' }, h('dt', null, fact.label), h('dd', null, fact.value)))
    )
  );
}

/**
 * The local result beside the public one: shown only when the card's result
 * is local (`provenance.layer` local), right under the result it explains.
 *
 * @param {{ details: object, depth: 'plain'|'expert', hasIntendedUse?: boolean }} props
 */
export function LocalAndPublic({ details, depth, hasIntendedUse = true }) {
  const content = localComparison(details, depth, { hasIntendedUse });
  if (!content) return null;
  return h(
    'section',
    { className: 'local-compare', 'aria-labelledby': 'detail-local' },
    h('h3', { id: 'detail-local', className: 'group-heading' }, 'Local and public'),
    h('p', { className: 'local-compare-lead' }, content.lead),
    h(
      'div',
      { className: 'inset-list local-compare-card' },
      h(
        'table',
        { className: 'local-compare-table' },
        h('caption', { className: 'visually-hidden' }, 'The local result and the public result, by view'),
        h(
          'thead',
          null,
          h('tr', null, h('td', null), h('th', { scope: 'col' }, h('span', { className: 'local-dot', 'aria-hidden': 'true' }), 'Local'), h('th', { scope: 'col' }, 'Public'))
        ),
        h(
          'tbody',
          null,
          content.rows.map((row) => h('tr', { key: row.view }, h('th', { scope: 'row' }, row.label), valueCell(row.local), valueCell(row.public)))
        )
      ),
      facts('Local evaluation', content.local),
      facts('Public result', content.public)
    )
  );
}
