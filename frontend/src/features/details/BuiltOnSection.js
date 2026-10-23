// "Built on" on the condition card (contract v1.14, release 0.5 phase Q4). Plain JS (createElement, no JSX) so the node tests can
// render it; the words are in copy/builtOnCopy.js. Information only.
import { createElement as h } from 'react';
import StatusMark from '../../design/StatusMark.js';
import { BUILT_ON_NOTE, builtOnContent } from './copy/builtOnCopy.js';

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

function BaseModel({ entry, functionEntry, details, depth, hasIntendedUse }) {
  const content = builtOnContent({ base: entry.base, functionEntry, details, baseDetails: entry.details, depth, hasIntendedUse });
  let body = null;
  if (content.rows) {
    body = h(
      'div',
      { className: 'inset-list local-compare-card' },
      h(
        'table',
        { className: 'local-compare-table' },
        h('caption', { className: 'visually-hidden' }, `This card and ${content.baseName}, by view, at this condition`),
        h('thead', null, h('tr', null, h('td', null), h('th', { scope: 'col' }, 'This card'), h('th', { scope: 'col' }, content.baseName))),
        h(
          'tbody',
          null,
          content.rows.map((row) => h('tr', { key: row.view }, h('th', { scope: 'row' }, row.label), valueCell(row.own), valueCell(row.base)))
        )
      )
    );
  } else if (entry.base.choice && entry.error) {
    body = h('p', { className: 'built-on-status' }, `The result of ${content.baseName} could not be loaded.`);
  } else if (entry.base.choice) {
    body = h('p', { className: 'built-on-status', role: 'status' }, `Loading the result of ${content.baseName}…`);
  }
  return h(
    'div',
    { className: 'built-on-base' },
    h('p', { className: 'local-compare-lead' }, content.lead),
    body,
    content.conflict ? h('p', { className: 'built-on-conflict' }, content.conflict) : null,
    entry.compareHref ? h('a', { className: 'built-on-compare', href: entry.compareHref }, 'Compare with the base model') : null
  );
}

/**
 * The Built on section: one block per base model in `built_on` order.
 *
 * @param {object} props
 * @param {{ base: object, details: object|null, error: object|null, compareHref: string|null }[]} props.bases
 * @param {object|null} props.functionEntry this card's UseCaseEntry
 * @param {object} props.details this card's ConceptMetrics
 * @param {'plain'|'expert'} props.depth
 * @param {boolean} [props.hasIntendedUse]
 */
export function BuiltOn({ bases, functionEntry, details, depth, hasIntendedUse = true }) {
  if (!bases?.length) return null;
  return h(
    'section',
    { className: 'local-compare built-on', 'aria-labelledby': 'detail-built-on' },
    h('h3', { id: 'detail-built-on', className: 'group-heading' }, 'Built on'),
    bases.map((entry) =>
      h(BaseModel, { key: entry.base.version, entry, functionEntry, details, depth, hasIntendedUse })
    ),
    h('p', { className: 'built-on-note' }, BUILT_ON_NOTE)
  );
}
