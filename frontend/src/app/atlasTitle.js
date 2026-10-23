// The atlas tab title (S8b): it names the card, so several open atlases can be
// told apart in the tab bar and in history, and it says when the tab shows an
// unpublished preview. atlas.html starts with "Atlas – Broad Modelcard", which
// this keeps as its ending.

export const ATLAS_TITLE_BASE = 'Atlas – Broad Modelcard';

/**
 * "SynGPT-2.0 – Clinician-Facing CDSS – Atlas – Broad Modelcard"; during a
 * preview it starts with "Preview, not live". Missing parts are left out, so
 * the title is never "undefined" while the registry loads.
 *
 * @param {{ system?: string|null, fn?: string|null, isPreview?: boolean }} parts
 */
export function atlasTitle({ system, fn, isPreview = false } = {}) {
  const parts = [isPreview ? 'Preview, not live' : null, system, system ? fn : null, ATLAS_TITLE_BASE];
  return parts.filter((part) => typeof part === 'string' && part.trim()).map((part) => part.trim()).join(' – ');
}
