// The atlas preview of a staged update: which concepts on screen differ from
// the live data, why a preview ended, and the way back to the admin page.

/** Admin page for the data set of a preview (same tab, so the update is restored there). */
export function adminHref(upload) {
  const params = new URLSearchParams();
  if (upload?.kind) params.set('set', upload.kind);
  if (upload?.target?.population_id) {
    // A local population update (contract v1.10) returns to its population.
    params.set('population', upload.target.population_id);
  } else if (upload?.target) {
    params.set('model', upload.target.model_version);
    params.set('use_case', upload.target.use_case);
  }
  const query = params.toString();
  return `./admin.html${query ? `?${query}` : ''}`;
}

function sameRow(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!Object.is(a[key] ?? null, b[key] ?? null)) {
      return false;
    }
  }
  return true;
}

/**
 * The staged and live metric maps for the same filters and scope, compared
 * row by row over every column: exact for every view and lens, unlike the
 * change summary's samples.
 *
 * @param {Map<string, object>} stagedRows decoded staged map rows
 * @param {Map<string, object>} liveRows decoded live map rows
 * @returns {Set<string>} concept ids whose row was added, removed, or changed
 */
export function changedConceptIds(stagedRows, liveRows) {
  const changed = new Set();
  stagedRows.forEach((row, conceptId) => {
    const live = liveRows.get(conceptId);
    if (!live || !sameRow(row, live)) {
      changed.add(conceptId);
    }
  });
  liveRows.forEach((_row, conceptId) => {
    if (!stagedRows.has(conceptId)) {
      changed.add(conceptId);
    }
  });
  return changed;
}

/** The local population a preview stages (contract v1.10), or null for any other preview. */
export function previewedPopulationId(upload) {
  return upload?.kind === 'population' ? upload?.target?.population_id ?? null : null;
}

/**
 * The filters of the live comparison behind the changed-from-live halo. A
 * local population preview compares its own population with the default
 * prevalence, like its change summary (CONTRACT.md §21): a new population has
 * no live answer yet. Only the previewed population is dropped; any other
 * population on screen is read live as it is, and every other preview
 * compares the same filters.
 *
 * @param {object|null} filters the staged reads' filters
 * @param {string|null} previewedPopulation previewedPopulationId(upload)
 */
export function liveComparisonFilters(filters, previewedPopulation) {
  if (!filters || !previewedPopulation || filters.population !== previewedPopulation) {
    return filters;
  }
  const { population: _previewed, ...rest } = filters;
  return rest;
}

export const DATASET_TITLES = Object.freeze({
  models: 'AI systems & functions',
  metrics: 'Performance metrics',
  multimorbidity: 'Multimorbidity',
  prevalence: 'Prevalence',
  safety: 'Safety incidents',
  population: 'Local population',
  studies: 'Studies'
});

/** Why a preview cannot be shown, in plain words, from the upload's status. */
export function previewEndedReason(upload) {
  switch (upload?.status) {
    case 'published':
      return 'It has been published, so the live data shows it now.';
    case 'superseded':
      return 'A newer file replaced it on the admin page.';
    case 'discarded':
      return 'It was discarded on the admin page.';
    case 'invalid':
      return 'Its check found problems, so it cannot be shown on the atlas.';
    case 'checking':
      return 'It is still being checked. This page tries again when the check is done.';
    default:
      return 'The staged update no longer exists.';
  }
}
