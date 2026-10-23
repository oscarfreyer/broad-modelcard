// Links from the admin page to the atlas (atlas.html, same tab).
import { atlasHref } from '../../app/startupParams.js';

function targetParams(kind, target, upload = null) {
  return {
    model: target?.model ?? null,
    useCase: target?.useCase ?? null,
    mode: kind === 'multimorbidity' ? 'multimorbidity' : null,
    // Safety incidents are read on the atlas's Safety view (contract v1.7).
    view: kind === 'safety' ? 'safety' : null,
    // A local population is read with its id (contract v1.10): its staged
    // version with `version=staged:<id>&population=<id>`, its live one with the id.
    population:
      kind === 'population'
        ? target?.populationId ?? upload?.target?.population_id ?? null
        : kind === 'local_metrics'
          ? target?.localPopulationId ?? upload?.target?.population_id ?? null
          : null
  };
}

/**
 * The atlas showing a staged upload over the live data (an unpublished
 * preview). `lens` opens a population group, e.g. the one an incident names.
 */
export function previewHref(upload, { kind, target, view = null, conceptId = null, lens = null, setting = null } = {}) {
  const params = targetParams(kind ?? upload.kind, target, upload);
  // `setting` (contract v1.14) opens a care setting, e.g. the only one a metrics update touches.
  return atlasHref({ version: `staged:${upload.upload_id}`, ...params, view: view ?? params.view, conceptId, lens, setting });
}

/** The live atlas, opened on the data set's card when it has one. */
export function liveAtlasHref(kind, target) {
  return atlasHref(targetParams(kind, target));
}

/**
 * Where to look at a safety update. A form entry names one card, so the
 * preview opens its first incident's condition and population there
 * (rows.samples of the change summary, v1.7). A file may name incidents of
 * many cards, and its first sample can belong to another card than the one
 * picked, so a file's preview opens the picked card's Safety view without a
 * condition or population.
 */
/**
 * Where to look at an effects update (contract v1.13, §27): the form's card
 * (for a file, none) and the first effect's condition, whose card lists it.
 */
export function effectsPreviewHref(upload, { target, changes = null } = {}) {
  const samples = changes?.rows?.samples;
  const first = [...(samples?.added ?? []), ...(samples?.changed ?? []), ...(samples?.removed ?? [])][0] ?? null;
  return previewHref(upload, { kind: 'effects', target, conceptId: target ? first?.concept_id ?? null : null });
}

export function safetyPreviewHref(upload, { target, changes = null } = {}) {
  if (upload.origin !== 'records') {
    return previewHref(upload, { kind: 'safety', target });
  }
  const samples = changes?.rows?.samples;
  const first = [...(samples?.added ?? []), ...(samples?.changed ?? []), ...(samples?.removed ?? [])][0] ?? null;
  return previewHref(upload, { kind: 'safety', target, conceptId: first?.concept_id ?? null, lens: first?.lens ?? null });
}
