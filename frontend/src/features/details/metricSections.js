// The four metric sections of a condition card (Overview, Performance,
// Evidence, Intended use) from one contract MetricRow: the big figure, the
// range chart, the one-line meaning per depth, and the evidence facts.
import { formatScore, rangeModel } from '../../design/rangeScale.js';
import { DISPLAY, VIEWS, gradeFor, isAbsence, metricRowStatus } from '../../design/status.js';
import { validationTypeLabel } from '../../shared/metricLabels.js';

const fixed = (value, depth) => (depth === 'expert' ? value.toFixed(3) : formatScore(value));
const count = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : 'Not available');

const OVERALL_GAPS = {
  out_of_scope: 'No overall score: the AI system is not meant for this use.',
  no_evidence_data: 'No overall score, because there is no validation evidence.',
  no_performance_data: 'No overall score, because performance was not measured.',
  no_data: 'No overall score: there is no result to grade.'
};

const PERFORMANCE_PLAIN = {
  strong: 'Upper band.',
  moderate: 'Middle band.',
  weak: 'Lower band.',
  no_data: 'Not measured here.'
};

const SCOPE_PLAIN = {
  in_scope: 'Meant for this condition and population.',
  partially_in_scope: 'Meant for only some patients or settings.',
  out_of_scope: 'Not meant for use here.',
  no_data: 'No intended-use statement for this result.'
};

// Overall score terms in CONTRACT.md §4.4 order; the weights come from /meta.
const OVERALL_TERMS = [
  ['performance_grade', 'performance grade'],
  ['perf', 'performance'],
  ['evidence_grade', 'evidence grade'],
  ['intended_use', 'intended-use fit']
];

/**
 * "performance grade 35%, performance 20%, …", or the term names alone
 * without weights. A card without an intended-use statement drops that term
 * and scales the others (`/meta.overall_score_weights_without_intended_use`).
 */
function overallTerms(weights, hasIntendedUse) {
  const terms = hasIntendedUse ? OVERALL_TERMS : OVERALL_TERMS.filter(([key]) => key !== 'intended_use');
  const hasWeights = terms.every(([key]) => Number.isFinite(weights?.[key]));
  if (!hasWeights) {
    return `Combines ${terms.slice(0, -1).map(([, label]) => label).join(', ')}, and ${terms.at(-1)[1]}`;
  }
  return `Weights: ${terms.map(([key, label]) => `${label} ${Math.round(weights[key] * 100)}%`).join(', ')}`;
}

/**
 * The three 0–1 values (score, performance, evidence signal) share one unit
 * pattern (audit A27): the figure, then "of 1.00"; the section's label says
 * which value it is. At expert depth the meaning names the value and its
 * decimals.
 */
const UNIT = 'of 1.00';

function overallSection(row, { depth, statusBands, overallScoreWeights, hasIntendedUse }) {
  const status = metricRowStatus(row, 'overall', { hasIntendedUse });
  const score = row.overall?.score;
  const graded = row.overall?.tier === 'graded' && Number.isFinite(score);
  return {
    figure: graded ? { value: fixed(score, depth), unit: UNIT } : { word: 'No score' },
    chart: rangeModel({ view: 'overall', value: graded ? score : null, statusBands, status }),
    // What the score is made of is the section's help; a gap stays in view.
    meaning: graded
      ? depth === 'expert'
        ? `Score ${score.toFixed(3)}.`
        : null
      : OVERALL_GAPS[hasIntendedUse ? row.overall?.tier : row.overall?.tier === 'out_of_scope' ? 'no_data' : row.overall?.tier] ?? OVERALL_GAPS.no_data,
    help:
      depth === 'expert'
        ? `${overallTerms(overallScoreWeights, hasIntendedUse)}.`
        : hasIntendedUse
          ? 'Performance, evidence, and intended-use fit, combined.'
          : 'Performance and evidence, combined.'
  };
}

function performanceSection(row, { depth, statusBands }) {
  const status = metricRowStatus(row, 'performance');
  const hasValue = Number.isFinite(row.perf);
  const hasCi = hasValue && Number.isFinite(row.ci_low) && Number.isFinite(row.ci_high);
  let meaning = PERFORMANCE_PLAIN[status] ?? PERFORMANCE_PLAIN.no_data;
  if (depth === 'expert') {
    meaning = hasValue
      ? `Performance ${row.perf.toFixed(3)}${hasCi ? `, confidence interval ${row.ci_low.toFixed(3)}–${row.ci_high.toFixed(3)}` : ', no confidence interval'}.`
      : 'No performance value is stored for this row.';
  } else if (hasCi) {
    meaning = `${meaning} Likely ${row.ci_low.toFixed(2)}–${row.ci_high.toFixed(2)}.`;
  }
  return {
    figure: hasValue ? { value: fixed(row.perf, depth), unit: UNIT } : { word: 'Not measured' },
    chart: rangeModel({
      view: 'performance',
      value: hasValue ? row.perf : null,
      ciLow: hasCi ? row.ci_low : null,
      ciHigh: hasCi ? row.ci_high : null,
      statusBands,
      status
    }),
    meaning
  };
}

function evidenceSection(row, { depth, statusBands }) {
  const status = metricRowStatus(row, 'evidence');
  const signal = Number.isFinite(row.evidence_signal) ? row.evidence_signal : null;
  const hasEvidence = Boolean(row.evidence_grade);
  const type = validationTypeLabel(row.validation_type, 'an unspecified validation');
  let meaning;
  if (!hasEvidence) {
    meaning = 'No validation evidence.';
  } else if (depth === 'expert') {
    meaning = signal != null ? `Evidence signal ${signal.toFixed(3)}.` : null;
  } else {
    // The facts below name the validation type and the studies.
    meaning = null;
  }
  return {
    figure: signal != null ? { value: fixed(signal, depth), unit: UNIT } : { word: DISPLAY[status].label },
    chart: rangeModel({ view: 'evidence', value: signal, statusBands, status }),
    meaning,
    help: hasEvidence ? 'The evidence signal is derived from the validation type, study count, sites, peer review, and sample size.' : null,
    facts: hasEvidence
      ? [
          { label: 'Validation', value: validationTypeLabel(row.validation_type, 'Not specified') },
          { label: 'Studies', value: `${count(row.n_studies)} (${count(row.peer_reviewed_studies)} peer reviewed)` },
          { label: 'Samples', value: count(row.n_samples) },
          { label: 'Sites', value: count(row.n_sites) }
        ]
      : []
  };
}

function intendedUseSection(row, { depth, hasIntendedUse }) {
  if (!hasIntendedUse) {
    // No statement, so no scope to place this result in: a
    // neutral "No statement", never the No data mark (audit A3), as the live
    // panel says it.
    return { figure: { word: 'No statement' }, chart: null, meaning: null, status: null, statusWord: 'No statement', noStatement: true };
  }
  const status = metricRowStatus(row, 'intended_use');
  const coverage = Number.isFinite(row.intended_use_coverage) ? row.intended_use_coverage : null;
  return {
    figure: coverage != null ? { value: `${Math.round(coverage * 100)}%`, unit: 'coverage' } : { word: DISPLAY[status].label },
    chart: { kind: 'scope', level: status },
    meaning:
      depth === 'expert'
        ? `Level ${row.intended_use_level ?? 'not stated'}${coverage != null ? `, coverage ${coverage.toFixed(4)}` : ''}.`
        : SCOPE_PLAIN[status]
  };
}

const BUILDERS = {
  overall: overallSection,
  performance: performanceSection,
  evidence: evidenceSection,
  intended_use: intendedUseSection
};

/**
 * @param {object} row contract MetricRow
 * @param {{ depth: 'plain'|'expert', statusBands?: object, overallScoreWeights?: object, hasIntendedUse?: boolean }} options
 *   overallScoreWeights is contract Meta.overall_score_weights, or for a card
 *   without an intended-use statement (`hasIntendedUse` false)
 *   Meta.overall_score_weights_without_intended_use
 * @returns {object[]} one section per view; `isAbsent` marks a section with
 *   no value and an absence status (Out of scope, No data):
 *   its header names the state, so the card shows only its meaning, without
 *   a figure word or an absence row that would name it again (S1a follow-up).
 */
export function metricSections(row, { depth = 'plain', statusBands, overallScoreWeights, hasIntendedUse = true } = {}) {
  return VIEWS.map((view) => {
    const section = {
      viewId: view.id,
      label: view.label,
      status: metricRowStatus(row, view.id, { hasIntendedUse }),
      grade: depth === 'expert' ? gradeFor(row, view.id) : null,
      facts: [],
      ...BUILDERS[view.id](row, { depth, statusBands, overallScoreWeights, hasIntendedUse })
    };
    return { ...section, isAbsent: Boolean(section.noStatement) || (!section.figure.value && isAbsence(section.status)) };
  });
}
