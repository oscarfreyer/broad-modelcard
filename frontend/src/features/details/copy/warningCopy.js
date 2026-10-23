// User-facing copy for warning codes (CONTRACT.md §4.6: the API returns codes
// and relevance; the frontend owns the words).

const RELEVANCE_RANK = Object.freeze({ High: 0, Medium: 1, Low: 2 });

const WARNING_COPY = Object.freeze({
  out_of_scope_group: {
    title: 'Outside intended use',
    patientSummary: 'This AI system is being used in a setting it was not designed for.',
    expertSummary: 'Intended-use coverage indicates the selected cohort is partially or fully out of scope.',
    detail:
      'Limit use to approved indications and run a dedicated local validation before applying outputs to care decisions.'
  },
  clinician_review_required: {
    title: 'Clinician review required',
    patientSummary: 'A clinician must confirm results before any action is taken.',
    expertSummary: 'Workflow policy requires physician sign-off for this function.',
    detail:
      'Ensure results are advisory-only in the interface and require documented clinician acknowledgement before downstream action.'
  },
  performance_below_target: {
    title: 'Performance below target',
    patientSummary: "The AI system's accuracy is below the preferred threshold.",
    expertSummary: 'Observed performance is below the deployment threshold for this context.',
    detail:
      'Use conservative thresholds, enforce human review, and monitor false negatives/positives until performance improves.'
  },
  no_performance_data: {
    title: 'Performance data unavailable',
    patientSummary: 'There is no measured performance data for this setting.',
    expertSummary: 'No validated performance estimate is available for this configuration.',
    detail:
      'Do not rely on the outputs until a representative performance evaluation has been completed.'
  },
  no_validation_data: {
    title: 'Validation evidence unavailable',
    patientSummary: 'No validation evidence is available for this result.',
    expertSummary: 'Validation metadata is missing for this AI system, function, and population.',
    detail:
      'Collect validation documentation (study design, sample size, sites) before allowing production deployment.'
  },
  wide_confidence_interval: {
    title: 'High uncertainty',
    patientSummary: 'The result range is wide, so certainty is lower than desired.',
    expertSummary: 'Confidence interval width indicates unstable performance estimates.',
    detail:
      'Increase evaluation sample size and monitor drift by subgroup to reduce uncertainty before broad rollout.'
  },
  limited_validation_depth: {
    title: 'Limited validation depth',
    patientSummary: 'The supporting evidence is still limited.',
    expertSummary: 'Evidence grade is weak, indicating limited breadth/quality of validation studies.',
    detail:
      'Prioritize prospective or multisite validation and document limitations prominently in the clinical workflow.'
  },
  rare_condition_low_support: {
    title: 'Limited support for rare conditions',
    patientSummary: 'There is limited data for rare conditions in this area.',
    expertSummary: 'Low prevalence context reduces statistical support for stable estimates.',
    detail:
      'Use as a triage aid only, add secondary checks, and track outcomes for rare-condition cohorts separately.'
  },
  mental_disorders_high_variance: {
    title: 'Higher variance in this chapter',
    patientSummary: 'Results vary more in this chapter than average.',
    expertSummary: 'Chapter-specific variance suggests less stable behavior across subgroups.',
    detail:
      'Apply stricter review thresholds, add subgroup QA checks, and reassess calibration regularly for this chapter.'
  },
  conservative_rollup_p20: {
    title: 'Conservative aggregate estimate',
    patientSummary: 'The shown summary is intentionally conservative for safety.',
    expertSummary: 'Rollup uses conservative aggregation to avoid overstating performance.',
    detail:
      'Interpret this as a lower-bound summary; inspect condition-level cards when planning deployment decisions.'
  },
  multimorbidity_synthetic_demo: {
    title: 'Synthetic multimorbidity data',
    patientSummary: 'This combination is backed by synthetic prototype data.',
    expertSummary: 'The multimorbidity row is synthetic demonstration data, not clinical validation evidence.',
    detail:
      'Use this only to evaluate the prototype workflow and data contract; replace with real cohort evidence before clinical use.'
  },
  limited_multimorbidity_evidence: {
    title: 'Limited multimorbidity evidence',
    patientSummary: 'Evidence for this combination is limited.',
    expertSummary: 'Validation depth for this multimorbidity cohort is below the preferred level.',
    detail:
      'Prioritize representative multimorbid validation cohorts before relying on the AI system for this combination.'
  },
  multimorbidity_validation_gap: {
    title: 'Higher-order combination gap',
    patientSummary: 'This larger disease combination needs extra validation.',
    expertSummary: 'Higher-order multimorbidity combinations require dedicated evidence beyond pair-level validation.',
    detail:
      'Track performance separately by combination depth and require clinician review for higher-order multimorbidity use.'
  }
});

function warningCopy(code) {
  if (WARNING_COPY[code]) {
    return WARNING_COPY[code];
  }
  const friendlyTitle = String(code || 'Warning')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
  return {
    title: friendlyTitle || 'Warning',
    patientSummary: 'Additional caution is advised for this condition.',
    expertSummary: 'Additional review is recommended for this warning condition.',
    detail: 'Inspect configuration and subgroup behavior before broad deployment.'
  };
}

/**
 * The warning that states a policy of the function rather than a finding about this
 * result. The card shows it once, under the title, instead of in the list.
 */
export const USE_CASE_REQUIREMENT = 'clinician_review_required';

/**
 * Where an aggregated row's warning applies (contract v1.4 `Warning.share`):
 * "In 1 of 2 conditions" on a rollup, "In 2 of 6 population groups" on a
 * demographic fallback. Null on stored rows, without a share, or for a
 * single aggregated row.
 *
 * @param {{ share?: { count: number, total: number } }} warning
 * @param {string} [source] the row's `provenance.source`
 */
export function warningScope(warning, source) {
  const share = warning?.share;
  if (!share || !Number.isFinite(share.count) || !Number.isFinite(share.total) || share.total < 2) {
    return null;
  }
  const unit = source === 'rollup' ? 'conditions' : 'population groups';
  if (share.count >= share.total) {
    return share.total === 2 ? `In both ${unit}` : `In all ${share.total} ${unit}`;
  }
  return `In ${share.count} of ${share.total} ${unit}`;
}

/**
 * Split a row's warnings into the function's requirement (shown once, under
 * the title, by every card: single conditions, subchapters, chapters, and
 * combinations) and the findings listed under Warnings.
 *
 * @returns {{ requirement: object|null, findings: object[] }} requirement with its copy
 */
export function splitRequirement(warnings) {
  const list = warnings || [];
  const requirement = list.find((warning) => warning.code === USE_CASE_REQUIREMENT);
  return {
    requirement: requirement ? rankWarnings([requirement])[0] : null,
    findings: list.filter((warning) => warning.code !== USE_CASE_REQUIREMENT)
  };
}

/** High-relevance warnings that are findings about this result (not the function's policy). */
export function highWarningCount(warnings) {
  return (warnings || []).filter((warning) => warning.relevance === 'High' && warning.code !== USE_CASE_REQUIREMENT).length;
}

/** Contract warnings with copy, ordered by relevance and then title. */
export function rankWarnings(warnings) {
  return (warnings || [])
    .map((warning) => ({ ...warning, ...warningCopy(warning.code) }))
    .sort((a, b) => (RELEVANCE_RANK[a.relevance] ?? 99) - (RELEVANCE_RANK[b.relevance] ?? 99) || a.title.localeCompare(b.title));
}
