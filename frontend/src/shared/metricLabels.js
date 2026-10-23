// Display labels for contract values that are not statuses.

const INTENDED_USE_LABELS = Object.freeze({
  in_scope: 'In scope',
  partially_in_scope: 'Partially in scope',
  out_of_scope: 'Out of scope'
});

const VALIDATION_TYPE_LABELS = Object.freeze({
  clinical_study_multisite: 'Clinical study (multisite)',
  clinical_study_single_site: 'Clinical study (single site)',
  benchmark: 'Benchmark study',
  vignette_study: 'Vignette study',
  simulation_study: 'Simulation study',
  internal_test: 'Internal test'
});

/** Missing or unknown levels read as out of scope, as on the ring. */
export function intendedUseLabel(level) {
  return INTENDED_USE_LABELS[level] || INTENDED_USE_LABELS.out_of_scope;
}

export function validationTypeLabel(validationType, fallback = 'Not available') {
  return validationType ? VALIDATION_TYPE_LABELS[validationType] || validationType : fallback;
}
