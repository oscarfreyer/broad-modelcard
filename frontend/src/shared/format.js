// Value formatting for panels and exports.

export function formatMaybeNumber(value, digits = 3) {
  if (!Number.isFinite(value)) {
    return 'Not available';
  }
  return Number(value).toFixed(digits);
}

export function formatMaybeInt(value) {
  if (!Number.isFinite(value)) {
    return 'Not available';
  }
  return String(Math.round(value));
}

export function formatConfidenceInterval(low, high) {
  return Number.isFinite(low) && Number.isFinite(high)
    ? `${formatMaybeNumber(low)} to ${formatMaybeNumber(high)}`
    : 'Not available';
}

/** "Age … | Sex … | Ethnicity …" for a contract Lens. */
export function formatPopulation(lens) {
  return [lens?.age, lens?.sex, lens?.ethnicity].filter(Boolean).join(' | ') || 'Not available';
}

/** "All patients", or the specific lenses in words: "Age 65+, Female, Asian". */
export function populationWords(lens) {
  const parts = [];
  if (lens?.age && lens.age !== 'All ages') parts.push(lens.age.replace(/(\d)-(\d)/, '$1–$2'));
  if (lens?.sex && lens.sex !== 'All sexes') parts.push(lens.sex.replace(/^Sex\s+/, ''));
  if (lens?.ethnicity && lens.ethnicity !== 'All ethnicities') parts.push(lens.ethnicity.replace(/^Ethnicity\s+/, ''));
  return parts.length ? parts.join(', ') : 'All patients';
}

/**
 * One lens value under a labelled Age, Sex, or Ethnicity control: the
 * dimension is the label, so the option drops it ("Sex Female" → "Female",
 * "Age 0-17" → "0–17"); "All ages" and the like stay whole.
 */
export function lensValueWords(value) {
  const text = String(value ?? '');
  if (/^All\s/.test(text)) return text;
  return text.replace(/^(Age|Sex|Ethnicity)\s+/, '').replace(/(\d)-(\d)/, '$1–$2');
}

/** A lens axis as select options: the contract value, in lensValueWords. */
export function lensOptions(values) {
  return (values ?? []).map((value) => ({ value, label: lensValueWords(value) }));
}

export function displayUseCase(value) {
  return String(value || '').replace('Clinician Facing', 'Clinician-Facing').trim();
}

export function slugify(value) {
  const slug = String(value || 'model-card')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'model-card';
}
