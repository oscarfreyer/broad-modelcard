// "Effects on outcomes" on the condition card (contract v1.13, CONTRACT.md §27). Plain JS (createElement, no JSX) so the node tests can
// render it at both depths; the words and the plot geometry are in
// copy/effectCopy.js. It looks unlike the predictive results on purpose: no
// Strong / Moderate / Weak zones, no status colour, a square estimate on a
// hairline axis around the no-effect line (the forest-plot convention), and
// the fixed line that it is not part of any grade.
import { createElement as h, useMemo } from 'react';
import { EFFECTS_LEAD, EFFECTS_NOT_GRADED, EFFECTS_TITLE, effectsModel } from './copy/effectCopy.js';

function infoIcon() {
  return h(
    'svg',
    {
      className: 'icon effects-note-icon',
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
    h('circle', { cx: 12, cy: 12, r: 8.25 }),
    h('path', { d: 'M12 11v5.25M12 7.75v.01' })
  );
}

/** The effect plot: no effect in the middle, the interval as a line with caps, the estimate as a square. */
function EffectPlot({ entry, depth }) {
  const { plot } = entry;
  const betterLeft = plot.betterSide === 'left';
  return h(
    'div',
    { className: 'effect-plot', role: 'img', 'aria-label': entry.plotLabel },
    h(
      'div',
      { className: 'effect-plot-track', 'aria-hidden': 'true' },
      h('span', { className: `effect-plot-better is-${plot.betterSide}` }),
      h('span', { className: 'effect-plot-axis' }),
      h('span', { className: 'effect-plot-null', style: { left: `${plot.nullPct}%` } }),
      h('span', {
        className: 'effect-plot-ci',
        style: { left: `${plot.ciStartPct}%`, width: `${Math.max(0, plot.ciEndPct - plot.ciStartPct)}%` }
      }),
      h('span', { className: 'effect-plot-estimate', style: { left: `${plot.estimatePct}%` } })
    ),
    h(
      'div',
      { className: 'effect-plot-scale', 'aria-hidden': 'true' },
      h('span', { className: betterLeft ? 'is-better' : null }, betterLeft ? 'Better with AI' : 'Better without'),
      h('span', { className: 'effect-plot-null-label' }, depth === 'expert' ? `No effect (${entry.nullText})` : 'No effect'),
      h('span', { className: betterLeft ? null : 'is-better' }, betterLeft ? 'Better without' : 'Better with AI')
    )
  );
}

function factList(facts) {
  if (!facts.length) return null;
  return h(
    'dl',
    { className: 'fact-list effect-facts' },
    facts.map((fact) => h('div', { key: fact.label, className: 'fact-row' }, h('dt', null, fact.label), h('dd', null, fact.value)))
  );
}

function EffectRow({ entry, depth }) {
  return h(
    'li',
    { className: 'effect-row' },
    h(
      'div',
      { className: 'effect-head' },
      h('h4', { className: 'effect-outcome' }, entry.outcome),
      h('span', { className: 'effect-type' }, entry.outcomeType)
    ),
    h('p', { className: 'effect-sentence' }, entry.sentence),
    h(EffectPlot, { entry, depth }),
    depth === 'expert'
      ? factList(entry.facts)
      : h('p', { className: 'effect-source' }, `${entry.appraisal}. ${entry.study}.`)
  );
}

/**
 * Effects on outcomes: one row per effect of the card that concerns the
 * condition (`details.effects`), shown only when there are any.
 *
 * @param {object} props
 * @param {object[]} props.effects contract Effect objects
 * @param {'plain'|'expert'} props.depth
 */
export function EffectsOnOutcomes({ effects, depth }) {
  const entries = useMemo(() => effectsModel(effects, depth), [effects, depth]);
  if (!entries.length) return null;
  return h(
    'section',
    { className: 'effects', 'aria-labelledby': 'detail-effects' },
    h('h3', { id: 'detail-effects', className: 'group-heading' }, EFFECTS_TITLE),
    h(
      'div',
      { className: 'effects-card' },
      h('p', { className: 'effects-lead' }, EFFECTS_LEAD),
      h('ul', { className: 'effect-list' }, entries.map((entry) => h(EffectRow, { key: entry.id, entry, depth }))),
      h('p', { className: 'effects-note' }, infoIcon(), h('span', null, EFFECTS_NOT_GRADED))
    )
  );
}
