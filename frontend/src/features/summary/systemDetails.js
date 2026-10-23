// "About this AI system" and "Declared by the developer" (CONTRACT.md §11.1) as plain values. Registry facts and the developer's
// declarations stay in two separate lists, and nothing here says a
// declaration was checked: Broad Modelcard never verifies them. Since
// contract v1.14 (§28) also the card's configuration, what its figures
// measure, and its versions (Replaces, Replaced by).
import { aiTypeLabel, formatReleaseDate, functionCategoryLabel, kindLabel, systemKind, systemName } from '../../shared/aiSystem.js';
import { displayUseCase } from '../../shared/format.js';
import { hasIntendedUseStatement } from '../../design/status.js';

export const DECLARATIONS_NOTE = 'The developer’s own statements, not checked.';

const DECLARATION_FIELDS = [
  { id: 'declared_intended_purpose', label: 'Intended purpose' },
  { id: 'declared_regulatory_status', label: 'Regulatory status' },
  { id: 'declared_contact', label: 'Contact' },
  { id: 'declared_documentation_url', label: 'Documentation', isLink: true },
  // Data protection (contract v1.14): declared, never verified.
  { id: 'declared_data_use', label: 'Data use' },
  { id: 'declared_data_location', label: 'Data location' },
  { id: 'declared_retention', label: 'Retention' },
  { id: 'declared_privacy_contact', label: 'Privacy contact' }
];

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** A link only for http and https addresses; anything else stays plain text. */
function safeHref(value) {
  return /^https?:\/\/[^\s]+$/i.test(value) ? value : null;
}

/** "developer.example/docs" for a link's visible text. */
function linkText(href) {
  try {
    const url = new URL(href);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return href;
  }
}

/**
 * The developer's declarations for one card, or null when none is given.
 *
 * @param {object|null} declarations UseCaseEntry.declarations
 * @returns {{ items: { id: string, label: string, value: string, href: string|null }[], note: string } | null}
 */
export function declarationItems(declarations) {
  const items = DECLARATION_FIELDS.flatMap((field) => {
    const value = text(declarations?.[field.id]);
    if (!value) {
      return [];
    }
    const href = field.isLink ? safeHref(value) : null;
    return [{ id: field.id, label: field.label, value: href ? linkText(href) : value, href }];
  });
  return items.length ? { items, note: DECLARATIONS_NOTE } : null;
}

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** "temperature 0.2, top-p 0.9, up to 800 tokens", or '' when no sampling setting is given. */
export function samplingText(record) {
  const temperature = number(record?.sampling_temperature);
  const topP = number(record?.sampling_top_p);
  const tokens = number(record?.sampling_max_output_tokens);
  return [
    temperature !== null ? `temperature ${temperature}` : null,
    topP !== null ? `top-p ${topP}` : null,
    tokens !== null ? `up to ${tokens.toLocaleString('en-US')} tokens` : null
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * The card's configuration (contract v1.14, CONTRACT.md §28.1) and what its
 * figures measure, or null when the card gives neither. `label`, `date`, and
 * the one-line `summary` are for plain depth; `items` hold every field for
 * expert depth. The developer states these; nothing here checks them.
 *
 * @param {object|null} functionEntry UseCaseEntry of the card
 */
export function configurationDetails(functionEntry) {
  const record = functionEntry?.configuration ?? null;
  const measure = [
    { id: 'performance_measure', label: 'Figures measure', value: text(functionEntry?.performance_measure) },
    { id: 'reference_standard', label: 'Measured against', value: text(functionEntry?.reference_standard) }
  ].filter((item) => item.value);
  if (!record && !measure.length) {
    return null;
  }
  const tools = Array.isArray(record?.tools) ? record.tools.filter((tool) => text(tool)) : [];
  const checksum = text(record?.prompt_sha256);
  const items = record
    ? [
        { id: 'prompt_summary', label: 'Prompt summary', value: text(record.prompt_summary) },
        { id: 'retrieval', label: 'Retrieval', value: text(record.retrieval) },
        { id: 'tools', label: 'Tools', value: tools.join(', ') },
        { id: 'sampling', label: 'Sampling', value: samplingText(record) },
        { id: 'fine_tuning', label: 'Fine-tuning', value: text(record.fine_tuning) },
        { id: 'prompt_sha256', label: 'Prompt checksum', value: checksum ? `SHA-256 ${checksum.slice(0, 12)}…` : '', title: checksum || null }
      ].filter((item) => item.value)
    : [];
  return {
    hasRecord: Boolean(record),
    label: text(record?.configuration_id) || null,
    date: formatReleaseDate(record?.configuration_date),
    // One line at plain depth: what the system is told to do, else how it was adapted.
    summary: text(record?.prompt_summary) || text(record?.fine_tuning) || null,
    items,
    measure
  };
}

/**
 * The card of `other` that belongs with the one on screen: the same
 * function, else the same function category, else its first card.
 */
function matchingCard(other, functionEntry) {
  const cards = Array.isArray(other?.use_cases) ? other.use_cases : [];
  const category = functionEntry?.function_category ?? null;
  const match =
    cards.find((card) => card.use_case === functionEntry?.use_case) ??
    (category ? cards.find((card) => card.function_category === category) : null) ??
    cards[0];
  return match ? { modelVersion: other.model_version, useCase: match.use_case } : null;
}

/**
 * The versions of an AI system (contract v1.14, CONTRACT.md §28.2): the one
 * it replaces and those that replace it, each with the card to open (the
 * same function where that system has it), or null without lineage.
 * `previous` is the card "Compare with previous version" puts beside this one.
 *
 * @param {object|null} entry ModelEntry
 * @param {object|null} functionEntry UseCaseEntry on screen
 * @param {object[]} [registry] every ModelEntry
 */
export function lineageDetails(entry, functionEntry, registry = []) {
  const known = new Map(registry.map((other) => [other.model_version, other]));
  const link = (version) => {
    const other = known.get(version) ?? null;
    const card = other ? matchingCard(other, functionEntry) : null;
    return { version, label: systemName(other, version), canOpen: Boolean(card), card };
  };
  const replaces = text(entry?.replaces) ? link(text(entry.replaces)) : null;
  const replacedBy = (Array.isArray(entry?.replaced_by) ? entry.replaced_by : []).filter((version) => text(version)).map(link);
  if (!replaces && !replacedBy.length) {
    return null;
  }
  return { replaces, replacedBy, previous: replaces?.card ?? null };
}

/**
 * Everything the atlas shows about the selected AI system and function.
 * Empty fields are left out; `hasDetails` is false for an entry with none of
 * the v1.5 or v1.14 fields (the seed), so the atlas shows no empty block for it.
 *
 * @param {object|null} entry ModelEntry
 * @param {object|null} functionEntry UseCaseEntry of the selected function
 * @param {object[]} [registry] every ModelEntry, to tell which "built on" entries can be opened
 */
export function systemDetails(entry, functionEntry, registry = []) {
  if (!entry) {
    return null;
  }
  const known = new Map(registry.map((other) => [other.model_version, other]));
  const builtOn = (Array.isArray(entry.built_on) ? entry.built_on : [])
    .filter((version) => text(version))
    .map((version) => ({ version, label: systemName(known.get(version), version), canOpen: known.has(version) }));
  const aiType = aiTypeLabel(entry.ai_type);
  const description = text(entry.description) || null;
  const category = functionCategoryLabel(functionEntry?.function_category);
  const facts = [
    { id: 'developer', label: 'Developer', value: text(entry.developer) },
    { id: 'released', label: 'Released', value: formatReleaseDate(entry.release_date) },
    { id: 'function', label: 'Function', value: functionEntry ? displayUseCase(functionEntry.use_case) : '' },
    { id: 'function_category', label: 'Function category', value: category },
    // A card without a statement says so instead of any scope wording.
    { id: 'intended_use', label: 'Intended use', value: functionEntry && !hasIntendedUseStatement(functionEntry) ? 'No intended-use statement' : '' }
  ];
  const configuration = configurationDetails(functionEntry);
  const lineage = lineageDetails(entry, functionEntry, registry);
  const hasDetails = Boolean(
    aiType || description || builtOn.length || category || facts[0].value || facts[1].value || facts[4].value || configuration || lineage
  );
  return {
    name: systemName(entry),
    kind: { id: systemKind(entry), label: kindLabel(entry) },
    aiType,
    description,
    facts: facts.filter((fact) => fact.value),
    builtOn,
    configuration,
    lineage,
    hasDetails,
    declarations: declarationItems(functionEntry?.declarations)
  };
}
