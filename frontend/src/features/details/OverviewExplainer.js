// "What is behind this mark?" on the condition card: the
// Overview rule applied to this condition step by step, the deciding step
// marked. Plain JS (createElement) so the node tests render it; the rule is
// applied by design/status.js `overviewDecision` through copy/overviewRule.js,
// the same content source as "How the Overview works".
import { createElement as h, useMemo, useState } from 'react';
import StatusMark from '../../design/StatusMark.js';
import { EXPLAINER_TITLE, explainOverview } from './copy/overviewRule.js';

const STATE_WORDS = { decided: 'Decides the mark', passed: 'Does not apply', not_reached: 'Not reached' };

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

/** The steps as an ordered list (the card's explainer). */
export function OverviewSteps({ steps }) {
  return h(
    'ol',
    { className: 'overview-steps' },
    steps.map((step, index) =>
      h(
        'li',
        { key: step.id, className: `overview-step is-${step.state}`, 'aria-current': step.state === 'decided' ? 'step' : undefined },
        h('span', { className: 'overview-step-index', 'aria-hidden': 'true' }, String(index + 1)),
        h(
          'span',
          { className: 'overview-step-main' },
          h(
            'span',
            { className: 'overview-step-title' },
            step.title,
            h('span', { className: 'overview-step-state' }, STATE_WORDS[step.state])
          ),
          h(
            'span',
            { className: 'overview-step-result' },
            step.status ? h(StatusMark, { status: step.status, size: 12 }) : null,
            h('span', null, step.result)
          )
        )
      )
    )
  );
}

/**
 * @param {object} props
 * @param {object|null} props.row contract MetricRow
 * @param {object[]} [props.incidents]
 * @param {boolean} [props.hasIntendedUse]
 * @param {'plain'|'expert'} props.depth
 * @param {object|null} [props.weights] the overall score weights for this card
 * @param {boolean} [props.defaultOpen]
 * @param {(() => void)|null} [props.onOpenRule] opens "How the Overview works"
 */
export function OverviewExplainer({ row, incidents = [], hasIntendedUse = true, depth, weights = null, defaultOpen = false, onOpenRule = null }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const explained = useMemo(
    () => explainOverview({ row, incidents, hasIntendedUse, depth, weights }),
    [row, incidents, hasIntendedUse, depth, weights]
  );
  return h(
    'section',
    { className: 'overview-explainer', 'aria-label': EXPLAINER_TITLE },
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
            'aria-controls': 'detail-overview-explainer',
            onClick: () => setIsOpen((open) => !open)
          },
          h('span', { className: 'inset-row-title' }, EXPLAINER_TITLE),
          chevron(isOpen)
        ),
        isOpen
          ? h(
              'div',
              { id: 'detail-overview-explainer', className: 'assessment-body' },
              h('p', null, 'The Overview takes the first step that applies, for this condition and population.'),
              h(OverviewSteps, { steps: explained.steps }),
              onOpenRule
                ? h('button', { type: 'button', className: 'button-plain overview-rule-link', onClick: onOpenRule }, 'How the Overview works')
                : null
            )
          : null
      )
    )
  );
}

