// The Overview rule in words (E5): one content source for
// "How the Overview works" (legend and catalogue) and the condition card's
// "What is behind this mark?". The rule itself is applied in one place,
// design/status.js `overviewDecision`; this module only words it, so the
// explainer can never disagree with the ring. React-free.
import { DISPLAY, OVERVIEW_STEPS, metricRowStatus, overviewDecision, presentedRow } from '../../../design/status.js';
import { intendedUseLabel } from '../../../shared/metricLabels.js';
import { incidentMark, incidentsMark } from './incidentCopy.js';

export const OVERVIEW_SHEET_TITLE = 'How the Overview works';
export const EXPLAINER_TITLE = 'What is behind this mark?';

/** The four steps, in order; the first that applies decides the mark. */
export const OVERVIEW_RULE = Object.freeze([
  {
    id: 'incident',
    title: 'Safety incident',
    marks: ['serious', 'caution'],
    plain: 'An open or mitigated incident for this population shows first.',
    expert: 'The worst open or mitigated incident at the lens: Serious, else Caution. It changes the mark only, never a grade.'
  },
  {
    id: 'scope',
    title: 'Intended use',
    marks: ['out_of_scope'],
    plain: 'Outside what the AI system is meant for: Out of scope. Only on cards that state an intended use.',
    expert: 'Tier out_of_scope (level out of scope, or not in intended use), only on a card with an intended-use statement.'
  },
  {
    id: 'grade',
    title: 'Performance and evidence',
    marks: ['strong', 'moderate', 'weak'],
    plain: 'How well it performs and how strong the evidence is, combined.',
    expert: 'The overall score banded into Strong, Moderate, or Weak (CONTRACT.md §4.4–4.5).'
  },
  {
    id: 'no_data',
    title: 'No data',
    marks: ['no_data'],
    plain: 'None of the above: no graded result.',
    expert: 'No row, no performance value, or no validation evidence.'
  }
]);

if (OVERVIEW_RULE.map((step) => step.id).join() !== OVERVIEW_STEPS.join()) {
  throw new Error('overviewRule.js and status.js OVERVIEW_STEPS disagree');
}

export const OVERVIEW_SHEET_LEAD = 'Each condition gets one mark. The first step that applies decides it.';
export const OVERVIEW_SHEET_NOTE = 'Grades and bands are prototype heuristics on synthetic data.';

const TIER_GAPS = {
  no_evidence_data: 'no validation evidence',
  no_performance_data: 'performance not measured',
  no_data: 'no result',
  out_of_scope: 'no result'
};

const OVERALL_TERMS = [
  ['performance_grade', 'performance grade'],
  ['perf', 'performance'],
  ['evidence_grade', 'evidence grade'],
  ['intended_use', 'intended-use fit']
];

function weightsText(weights) {
  const terms = OVERALL_TERMS.filter(([key]) => Number.isFinite(weights?.[key]));
  return terms.length ? `Weights: ${terms.map(([key, label]) => `${label} ${Math.round(weights[key] * 100)}%`).join(', ')}.` : null;
}

const word = (status) => DISPLAY[status]?.label ?? DISPLAY.no_data.label;

/**
 * The Overview rule applied to one condition card read, step by step.
 *
 * @param {object} input
 * @param {object|null} input.row contract MetricRow (null without a result)
 * @param {object[]} [input.incidents] contract SafetyIncident[] at the lens
 * @param {boolean} [input.hasIntendedUse] the card has an intended-use statement
 * @param {'plain'|'expert'} [input.depth]
 * @param {object|null} [input.weights] the overall score weights from /meta for this card
 * @returns {{ status: string, decidingStep: string, steps: Array<{ id: string, title: string, state: 'decided'|'passed'|'not_reached', status: string|null, result: string }> }}
 */
export function explainOverview({ row, incidents = [], hasIntendedUse = true, depth = 'plain', weights = null }) {
  const presented = presentedRow(row);
  const mark = incidentsMark(incidents);
  const decision = overviewDecision({ safety: mark, overallStatus: presented?.status?.overall ?? null, hasIntendedUse });
  const decidedAt = OVERVIEW_STEPS.indexOf(decision.step);
  const stateOf = (index) => (index === decidedAt ? 'decided' : index < decidedAt ? 'passed' : 'not_reached');
  const expert = depth === 'expert';

  const marked = incidents.filter((incident) => incidentMark(incident));
  const incidentResult =
    mark === 'no_incidents'
      ? 'None for this population.'
      : `${word(mark)}: ${marked.length} ${marked.length === 1 ? 'incident' : 'incidents'} open or mitigated.`;

  let scopeResult;
  if (!hasIntendedUse) {
    scopeResult = 'No intended-use statement, so nothing is out of scope.';
  } else if (decision.step === 'scope') {
    scopeResult = 'Out of scope.';
  } else if (presented?.intended_use_level) {
    scopeResult = `${intendedUseLabel(presented.intended_use_level)}.`;
  } else {
    scopeResult = 'No intended-use value for this result.';
  }

  // The combined grade underneath, also when an incident shows instead of it.
  const underneath = metricRowStatus(row, 'overall', { hasIntendedUse });
  const performance = metricRowStatus(row, 'performance');
  const evidence = metricRowStatus(row, 'evidence');
  const isGraded = ['strong', 'moderate', 'weak'].includes(underneath);
  let gradeResult;
  if (isGraded) {
    gradeResult = `Performance ${word(performance)} and evidence ${word(evidence)}: ${word(underneath)}.`;
    if (expert && Number.isFinite(presented?.overall?.score)) {
      gradeResult = `${gradeResult} Score ${presented.overall.score.toFixed(3)}, grade ${presented.overall.grade ?? '–'}. ${weightsText(weights) ?? ''}`.trim();
    }
    if (decision.step === 'incident') {
      gradeResult = `Underneath the incident: ${gradeResult}`;
    }
  } else {
    const tier = presented?.overall?.tier ?? 'no_data';
    gradeResult = `No combined grade: ${TIER_GAPS[tier] ?? TIER_GAPS.no_data}.`;
  }

  const results = {
    incident: incidentResult,
    scope: scopeResult,
    grade: gradeResult,
    no_data: decision.step === 'no_data' ? 'No data.' : 'Not needed.'
  };
  const statuses = {
    incident: mark === 'no_incidents' ? null : mark,
    scope: decision.step === 'scope' ? 'out_of_scope' : null,
    grade: isGraded ? underneath : null,
    no_data: decision.step === 'no_data' ? 'no_data' : null
  };
  return {
    status: decision.status,
    decidingStep: decision.step,
    steps: OVERVIEW_RULE.map((step, index) => ({
      id: step.id,
      title: step.title,
      state: stateOf(index),
      status: statuses[step.id],
      result: results[step.id]
    }))
  };
}
