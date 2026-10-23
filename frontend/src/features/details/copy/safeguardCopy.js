// User-facing copy for safeguard ids (CONTRACT.md §4.6). The API decides which
// safeguards apply and their priority; the frontend owns the words.

const SAFEGUARD_COPY = Object.freeze({
  'scope-stop': {
    title: 'Block unsupported use',
    patientSummary: 'Do not use this AI system for this scenario.',
    expertSummary: 'Disable inference in this cohort and require formal approval before any exception pathway.',
    actions: [
      'Add hard eligibility checks in UI and API.',
      'Route out-of-scope requests to manual clinical review.',
      'Document exceptions in governance logs.'
    ]
  },
  'scope-partial': {
    title: 'Use with eligibility checks',
    patientSummary: "Only some patients match the AI system's intended use.",
    expertSummary: 'Enforce inclusion criteria before displaying output and flag partial-fit patients for additional review.',
    actions: [
      'Apply rule-based checks before output display.',
      'Require clinician attestation for borderline cases.',
      'Track partial-fit usage monthly.'
    ]
  },
  'perf-missing': {
    title: 'Collect local performance evidence',
    patientSummary: 'Performance has not been measured in this setting yet.',
    expertSummary: 'Treat outputs as experimental until representative local performance and uncertainty are established.',
    actions: [
      'Run a shadow-mode validation cohort.',
      'Compute sensitivity/specificity and confidence intervals.',
      'Approve deployment only after target thresholds are met.'
    ]
  },
  'perf-low': {
    title: 'Require human confirmation before action',
    patientSummary: 'A clinician should double-check this output every time.',
    expertSummary: 'Set workflow to advisory-only and require explicit human confirmation before downstream actions.',
    actions: ['Use conservative alert thresholds.', 'Require structured clinician sign-off.', 'Audit disagreement cases weekly.']
  },
  'ci-wide': {
    title: 'Tighten uncertainty monitoring',
    patientSummary: 'Result certainty is broad, so extra checks are needed.',
    expertSummary: 'Wide confidence intervals indicate instability; increase sample coverage before scaling use.',
    actions: ['Expand evaluation sample size.', 'Monitor per-subgroup calibration drift.', 'Escalate outlier cases to specialist review.']
  },
  'evidence-weak': {
    title: 'Strengthen validation depth',
    patientSummary: 'Evidence is limited and should be improved.',
    expertSummary: 'Prioritize external or prospective validation before broadening clinical reliance on this AI system.',
    actions: [
      'Plan multisite or prospective validation.',
      'Publish validation protocol and endpoints.',
      'Update risk controls after each evidence milestone.'
    ]
  },
  'evidence-missing': {
    title: 'Validate before relying on it',
    patientSummary: 'Performance was measured, but no validation study backs it up yet.',
    expertSummary:
      'A performance estimate exists without an evidence grade (validation type, samples, or sites are missing), so the result is not graded and reads No data.',
    actions: [
      'Run an external or prospective validation for this condition.',
      'Record validation type, sample size, and sites with the result.',
      'Keep outputs advisory until an evidence grade is available.'
    ]
  },
  'overall-weak': {
    title: 'Review before relying on it',
    patientSummary: 'The combined result is weak, so a clinician should check outputs carefully.',
    expertSummary:
      'The overall score falls in the Weak band although no single performance, evidence, or scope rule applies; review all three before use.',
    actions: [
      'Require clinician confirmation of outputs.',
      'Compare with other AI systems or functions for this condition.',
      'Reassess after new performance or validation evidence is added.'
    ]
  },
  'cdss-governance': {
    title: 'Maintain clinician-in-the-loop governance',
    patientSummary: 'Decisions should always be made by clinicians, not the AI system alone.',
    expertSummary: 'Keep all outputs as decision support and enforce clinician accountability with clear override logging.',
    actions: [
      "Show the AI system's output as a recommendation only.",
      'Capture reasons for acceptance/rejection.',
      'Review governance logs in safety meetings.'
    ]
  },
  'standard-monitoring': {
    title: 'Continue standard monitoring',
    patientSummary: 'Current profile is stable; continue routine quality checks.',
    expertSummary: 'Maintain drift, performance, and safety surveillance on the standard review cadence.',
    actions: [
      'Track monthly performance trends.',
      'Monitor subgroup disparities.',
      'Revalidate after major changes to the AI system or the workflow.'
    ]
  }
});

/** Contract safeguards with copy, in the order the API returns them. */
export function describeSafeguards(safeguards) {
  return (safeguards || [])
    .filter((safeguard) => SAFEGUARD_COPY[safeguard.id])
    .map((safeguard) => ({ ...safeguard, ...SAFEGUARD_COPY[safeguard.id] }));
}
