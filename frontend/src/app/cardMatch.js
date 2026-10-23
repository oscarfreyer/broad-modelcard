// A card named by a link (useModelSelection.js): links may use the display
// wording of a function, so names match loosely (audit B5).

/** "Clinician-Facing CDSS", "clinician facing cdss" → "clinicianfacingcdss": a link may use the display wording. */
const looseKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The option a requested value means, matched loosely (case, spaces, hyphens), or null. */
export function matchOption(requested, options) {
  if (!requested) {
    return null;
  }
  if (options.includes(requested)) {
    return requested;
  }
  const key = looseKey(requested);
  return options.find((option) => looseKey(option) === key) ?? null;
}
