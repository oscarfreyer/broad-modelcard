// Display values of one contract MetricRow for the condition card exports
// (JSON and PDF). Data exports keep the raw A–F grades beside the statuses.
import { DISPLAY, isRollupWithoutChildren, metricRowStatus } from '../../design/status.js';
import { formatConfidenceInterval, formatMaybeInt, formatMaybeNumber } from '../../shared/format.js';
import { intendedUseLabel, validationTypeLabel } from '../../shared/metricLabels.js';

/** What the card says in place of an intended-use level when it has no statement (contract v1.11). */
export const NO_STATEMENT_LABEL = 'No statement';

/** Grade letter, or "N" when there is no grade. */
export function gradeLetter(grade) {
  return typeof grade === 'string' && /^[A-F]$/.test(grade.trim().toUpperCase()) ? grade.trim().toUpperCase() : 'N';
}

/**
 * The words and figures of a row as the condition card shows them. A card
 * without an intended-use statement reads No data where the served Overview
 * says Out of scope, and "No statement" for intended use, as on the card.
 *
 * @param {object|null} metricRow contract MetricRow (null: no result)
 * @param {{ hasIntendedUse?: boolean }} [options]
 */
export function summarizeMetricRow(metricRow, { hasIntendedUse = true } = {}) {
  const row = metricRow ?? {};
  let intendedUse = DISPLAY.no_data.label;
  if (!hasIntendedUse) {
    intendedUse = NO_STATEMENT_LABEL;
  } else if (row.intended_use_level && !isRollupWithoutChildren(row)) {
    // A row without a level is No data, as on the ring (one rule for "no row"),
    // and so is a rollup without children (CONTRACT.md §6, V1).
    intendedUse = intendedUseLabel(row.intended_use_level);
  }
  return {
    overallGrade: gradeLetter(row.overall?.grade),
    overallScore: row.overall?.score ?? null,
    performanceGrade: gradeLetter(row.performance_grade),
    evidenceGrade: gradeLetter(row.evidence_grade),
    intendedUse,
    statuses: {
      overall: DISPLAY[metricRowStatus(metricRow, 'overall', { hasIntendedUse })].label,
      performance: DISPLAY[metricRowStatus(metricRow, 'performance')].label,
      evidence: DISPLAY[metricRowStatus(metricRow, 'evidence')].label
    },
    validationType: validationTypeLabel(row.validation_type),
    perfLabel: formatMaybeNumber(row.perf),
    ciLabel: formatConfidenceInterval(row.ci_low, row.ci_high),
    studiesLabel: formatMaybeInt(row.n_studies),
    peerReviewedLabel: formatMaybeInt(row.peer_reviewed_studies),
    samplesLabel: formatMaybeInt(row.n_samples),
    sitesLabel: formatMaybeInt(row.n_sites)
  };
}
