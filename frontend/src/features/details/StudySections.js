// "How was this assessed?" and "Study quality" on the condition card (contract v1.13, CONTRACT.md §22). Plain JS (createElement, no JSX) so the
// node tests can render both at both depths; the copy is in copy/studyCopy.js.
import { createElement as h, useMemo, useState } from 'react';
import { withHelp } from '../../design/HelpTip.js';
import { assessment, studyQuality } from './copy/studyCopy.js';

function factList(facts, className = 'fact-list') {
  if (!facts.length) return null;
  return h(
    'dl',
    { className },
    facts.map((fact) => h('div', { key: fact.label, className: 'fact-row' }, h('dt', null, fact.label), h('dd', null, fact.value)))
  );
}

/** The disclosure chevron, drawn as design/Icon.jsx draws `chevronDown`. */
function chevron(isOpen) {
  return h(
    'svg',
    {
      className: `icon disclosure${isOpen ? ' is-open' : ''}`,
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.75',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false'
    },
    h('path', { d: 'm6.5 9.5 5.5 5.5 5.5-5.5' })
  );
}

/**
 * "How was this assessed?": a disclosure under the metric sections. Plain
 * depth says in words which study the result comes from; expert depth adds
 * the evidence signal's terms with their weights from /meta and the study
 * record. Without `appraisal` it says that no study record is linked (seed
 * rows, or the static demo).
 *
 * @param {object} props
 * @param {object} props.row contract MetricRow
 * @param {'plain'|'expert'} props.depth
 * @param {object|null} [props.weights] /meta evidence_signal_weights
 * @param {object|null} [props.adjustments] /meta evidence_study_adjustments
 * @param {boolean} [props.defaultOpen] open on first render (tests)
 */
export function AssessmentDisclosure({ row, depth, weights = null, adjustments = null, defaultOpen = false }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const content = useMemo(() => assessment({ row, depth, weights, adjustments }), [row, depth, weights, adjustments]);
  return h(
    'section',
    { className: 'assessment', 'aria-label': 'How was this assessed?' },
    h(
      'div',
      { className: 'inset-list' },
      h(
        'div',
        { className: 'inset-row' },
        h(
          'button',
          {
            type: 'button',
            className: 'inset-row-button assessment-toggle',
            'aria-expanded': isOpen,
            'aria-controls': 'detail-assessment-body',
            onClick: () => setIsOpen((open) => !open)
          },
          h('span', { className: 'inset-row-title' }, 'How was this assessed?'),
          chevron(isOpen)
        ),
        isOpen
          ? h(
              'div',
              { id: 'detail-assessment-body', className: 'assessment-body' },
              content.lines.map((line) => h('p', { key: line }, line)),
              factList(content.facts, 'fact-list assessment-terms'),
              factList(content.record, 'fact-list assessment-record')
            )
          : null
      )
    )
  );
}

/**
 * Study quality: the linked study's risk of bias, reporting guideline, and
 * who ran it. Its own labelled section, worded about the underlying study, so
 * it is never read as a difference between patient groups. `ageContext` (contract v1.14,
 * §28.5) adds the evaluated configuration and version against the card's.
 */
export function StudyQuality({ row, depth, hideFacts = false, ageContext = null }) {
  const quality = useMemo(() => studyQuality(row, depth, ageContext), [row, depth, ageContext]);
  return h(
    'section',
    { 'aria-labelledby': 'detail-study-quality' },
    withHelp(h('h3', { id: 'detail-study-quality', className: 'group-heading' }, 'Study quality'), [quality.help], 'About Study quality'),
    h('div', { className: 'study-quality' }, quality.lead ? h('p', { className: 'study-quality-lead' }, quality.lead) : null, hideFacts ? null : factList(quality.facts))
  );
}
