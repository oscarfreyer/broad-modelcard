// The UI vocabulary for registry entries (CONTRACT.md "Vocabulary", §11.1):
// an entry is an "AI system", tagged Model or Product; a `use_case` is a
// "Function". The contract keys stay as they are; only the words change here.

export const KIND_LABELS = Object.freeze({ model: 'Model', product: 'Product' });

// Mirrors the readable labels of the registry template (backend
// app/schema/templates.py); an unknown code is shown in words.
export const AI_TYPE_LABELS = Object.freeze({
  llm: 'Large language model',
  imaging: 'Imaging model',
  tabular_risk: 'Tabular risk model',
  rule_based: 'Rule-based system',
  hybrid: 'Hybrid'
});

export const FUNCTION_CATEGORY_LABELS = Object.freeze({
  decision_support: 'Decision support',
  documentation: 'Documentation',
  image_analysis: 'Image analysis',
  triage: 'Triage',
  // Contract v1.14.
  patient_communication: 'Patient communication',
  administrative: 'Administrative'
});

function words(code) {
  const text = String(code || '').replace(/_/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

/** `model` or `product`; an entry without `kind` is a model (contract v1.5). */
export function systemKind(entry) {
  return entry?.kind === 'product' ? 'product' : 'model';
}

export function kindLabel(entry) {
  return KIND_LABELS[systemKind(entry)];
}

export function aiTypeLabel(code) {
  return code ? AI_TYPE_LABELS[code] ?? words(code) : null;
}

export function functionCategoryLabel(code) {
  return code ? FUNCTION_CATEGORY_LABELS[code] ?? words(code) : null;
}

// The category inside a sentence ("helps with administrative work"): the label in lower case,
// except where the label is an adjective.
const FUNCTION_CATEGORY_PHRASES = Object.freeze({ administrative: 'administrative work' });

/** A function category as a noun phrase for running text, or null. */
export function functionCategoryPhrase(code) {
  return code ? FUNCTION_CATEGORY_PHRASES[code] ?? functionCategoryLabel(code).toLowerCase() : null;
}

/** The name an AI system is shown by: its display name, else its version id. */
export function systemName(entry, fallback = '') {
  return entry?.display_name || entry?.model_version || fallback;
}

const RELEASE_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "15 April 2024" for an ISO date; null when there is none or it does not parse. */
export function formatReleaseDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return null;
  }
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : RELEASE_DATE.format(date);
}

/**
 * Registry entries as picker options: one plain list while every entry is a
 * model, otherwise two groups, Models then Products, in registry order.
 *
 * @param {object[]} entries listModels().models
 * @returns {{ label: string|null, options: { value: string, label: string }[] }[]}
 */
export function systemOptionGroups(entries = []) {
  const option = (entry) => ({ value: entry.model_version, label: systemName(entry) });
  const products = entries.filter((entry) => systemKind(entry) === 'product');
  if (!products.length) {
    return [{ label: null, options: entries.map(option) }];
  }
  return [
    { label: 'Models', options: entries.filter((entry) => systemKind(entry) === 'model').map(option) },
    { label: 'Products', options: products.map(option) }
  ].filter((group) => group.options.length);
}
