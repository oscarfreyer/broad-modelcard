// The card's "Safety incidents" section (contract v1.7, CONTRACT.md §18). Plain JS (createElement, no JSX) so the node tests can
// render it at both depths.
import { createElement as h, Fragment } from 'react';
import StatusMark from '../../design/StatusMark.js';
import { DISPLAY } from '../../design/status.js';
import { CLOSED_ONLY_TEXT, NO_INCIDENTS_TEXT, describeIncident, incidentsMarkWord, sortIncidents } from './copy/incidentCopy.js';

/** A status word with its mark, as design/StatusLabel.jsx draws it (toned). */
function markedWord(status, word = null) {
  const display = DISPLAY[status];
  return h(
    'span',
    { className: `status-label status-label-regular is-toned tone-${display.tone}` },
    h(StatusMark, { status, size: 12 }),
    h('span', { className: 'status-word' }, word ?? display.label)
  );
}

function factList(facts) {
  return h(
    'dl',
    { className: 'fact-list incident-facts' },
    facts.map((fact) => h('div', { key: fact.label, className: 'fact-row' }, h('dt', null, fact.label), h('dd', null, fact.value)))
  );
}

/**
 * Incidents that apply to the concept at the lens, Serious first, then
 * Caution, then closed ones, which are listed with a neutral chip and no
 * mark. Plain depth: mark and word, type, the synthetic summary, status and
 * population, what the status means, the source and dates. Expert depth: the
 * same summary with every field as facts (id, codes or chapter, harm, source,
 * dates). With none: the neutral No reported incidents mark, never "safe".
 * With closed ones only: the neutral mark reads No open incidents above them.
 *
 * @param {object} props
 * @param {object[]} props.incidents contract SafetyIncident[]
 * @param {'plain'|'expert'} props.depth
 * @param {(chapterId: string) => string|null} [props.chapterName]
 */
export default function IncidentList({ incidents, depth, chapterName = null }) {
  const isExpert = depth === 'expert';
  if (!incidents?.length) {
    return h(
      'div',
      { className: 'incident-empty' },
      markedWord('no_incidents'),
      h('p', null, isExpert ? NO_INCIDENTS_TEXT.expert : NO_INCIDENTS_TEXT.plain)
    );
  }
  const rows = sortIncidents(incidents).map((incident) => {
    const item = describeIncident(incident, { chapterName });
    const details = isExpert
      ? [factList(item.facts)]
      : [
          h('span', { key: 'scope', className: 'inset-row-scope' }, `${item.status}, ${item.population}`),
          h('span', { key: 'status', className: 'incident-meta' }, item.statusText),
          h(
            'span',
            { key: 'source', className: 'incident-meta' },
            `${item.source}. Reported ${item.reported ?? 'without a date'}${item.updated ? `, updated ${item.updated}` : ''}.`
          )
        ];
    return h(
      'li',
      { key: item.id, className: `inset-row is-static incident-row${item.mark ? '' : ' is-closed'}`, 'data-severity': item.mark ?? 'closed' },
      h(
        'div',
        { className: 'inset-row-button' },
        h(
          'span',
          { className: 'inset-row-main' },
          h(
            'span',
            { className: 'incident-head' },
            item.mark ? markedWord(item.mark) : h('span', { className: 'priority-chip tone-absent' }, item.severityWord),
            h('span', { className: 'inset-row-title' }, item.type)
          ),
          h('span', { className: 'inset-row-text' }, item.summary),
          ...details
        )
      )
    );
  });
  const closedOnly = incidentsMarkWord(incidents);
  return h(
    Fragment,
    null,
    closedOnly
      ? h('div', { className: 'incident-empty' }, markedWord('no_incidents', closedOnly), h('p', null, isExpert ? CLOSED_ONLY_TEXT.expert : CLOSED_ONLY_TEXT.plain))
      : null,
    h('ul', { className: 'inset-list incident-list' }, rows)
  );
}
