// "Built on" on the condition card (contract v1.14, release 0.5 phase Q4): for a product built on a model of the registry, the base
// model's result and intended use at the same condition, lens, population,
// and classification, beside this card's. Information only: it never changes
// a grade, a status, or a mark. React-free, so the node tests read it.
import { displayFor, hasIntendedUseStatement, metricRowStatus, overviewStatus } from '../../../design/status.js';
import { formatScore } from '../../../design/rangeScale.js';
import { functionCategoryLabel, systemName } from '../../../shared/aiSystem.js';
import { displayUseCase } from '../../../shared/format.js';
import { intendedUseLabel } from '../../../shared/metricLabels.js';
import { incidentsMark } from './incidentCopy.js';

/** How the base model's card was chosen (the lead names it). */
export const BASE_CARD_REASONS = Object.freeze({ same_category: 'same_category', default: 'default', first: 'first' });

/** The levels a card marks as inside its intended use. */
const IN_SCOPE = new Set(['in_scope', 'partially_in_scope']);

export const SCOPE_CONFLICT_WORDS = Object.freeze({
  not_stated: 'The model it is built on is not stated for this use.',
  out_of_scope: 'The model it is built on marks this condition out of scope.'
});

export const BUILT_ON_NOTE = 'Information only: this card’s own results and grades stand.';

/**
 * The base model's card to show: the one with the same function
 * category as this card, else the base's default card, else its first.
 *
 * @param {object|null} baseEntry ModelEntry of the base model
 * @param {string|null} functionCategory this card's function category
 * @returns {{ useCase: string, functionEntry: object, reason: string }|null} null when the base has no card
 */
export function baseCardChoice(baseEntry, functionCategory) {
  const cards = Array.isArray(baseEntry?.use_cases) ? baseEntry.use_cases : [];
  if (!cards.length) return null;
  const same = functionCategory ? cards.find((card) => card.function_category === functionCategory) : null;
  if (same) return { useCase: same.use_case, functionEntry: same, reason: BASE_CARD_REASONS.same_category };
  const fallback = baseEntry.default_use_case ? cards.find((card) => card.use_case === baseEntry.default_use_case) : null;
  if (fallback) return { useCase: fallback.use_case, functionEntry: fallback, reason: BASE_CARD_REASONS.default };
  return { useCase: cards[0].use_case, functionEntry: cards[0], reason: BASE_CARD_REASONS.first };
}

/**
 * The base models of the card on screen, in `built_on` order, each with the
 * card to read, or none when the base is not in the registry.
 *
 * @param {object|null} entry ModelEntry on screen
 * @param {object|null} functionEntry UseCaseEntry on screen
 * @param {object[]} registry every ModelEntry
 * @returns {{ version: string, label: string, entry: object|null, choice: object|null }[]}
 */
export function builtOnBases(entry, functionEntry, registry = []) {
  const known = new Map(registry.map((other) => [other.model_version, other]));
  const versions = (Array.isArray(entry?.built_on) ? entry.built_on : []).filter((version) => typeof version === 'string' && version.trim());
  return versions.map((version) => {
    const base = known.get(version) ?? null;
    return { version, label: systemName(base, version), entry: base, choice: base ? baseCardChoice(base, functionEntry?.function_category ?? null) : null };
  });
}

/**
 * Whether the base model is not stated for, or excludes, a condition this
 * card marks in scope. Null otherwise, also when this card has
 * no intended-use statement or marks the condition out of scope itself.
 */
export function scopeConflict({ row, hasIntendedUse = true, baseRow, baseHasIntendedUse = true }) {
  if (!hasIntendedUse || !IN_SCOPE.has(row?.intended_use_level)) return null;
  if (!baseHasIntendedUse) return 'not_stated';
  if (baseRow?.intended_use_level === 'out_of_scope') return 'out_of_scope';
  return null;
}

/** "In scope", "Out of scope", "No statement" (the card has none), or "Not stated" (none for this condition). */
export function intendedUseWords(row, hasIntendedUse) {
  if (!hasIntendedUse) return 'No statement';
  if (!row?.intended_use_level) return 'Not stated';
  return intendedUseLabel(row.intended_use_level);
}

function performance(row, depth) {
  if (row?.perf == null) return null;
  const value = formatScore(row.perf);
  const ci = row.ci_low != null && row.ci_high != null ? ` (${formatScore(row.ci_low)}–${formatScore(row.ci_high)})` : '';
  return depth === 'expert' && row.performance_grade ? `${value}${ci} (${row.performance_grade})` : `${value}${ci}`;
}

/** One side of the table: the status word and mark, and the figure, per view. */
function side(details, { depth, hasIntendedUse }) {
  const row = details?.metrics ?? null;
  const overall = overviewStatus(row, incidentsMark(details?.incidents ?? []), { hasIntendedUse });
  const performanceStatus = row ? metricRowStatus(row, 'performance', { hasIntendedUse }) : 'no_data';
  const evidenceStatus = row ? metricRowStatus(row, 'evidence', { hasIntendedUse }) : 'no_data';
  return {
    overall: { status: overall, word: displayFor(overall).label, figure: null },
    performance: { status: performanceStatus, word: displayFor(performanceStatus).label, figure: performance(row, depth) },
    evidence: { status: evidenceStatus, word: displayFor(evidenceStatus).label, figure: depth === 'expert' && row?.evidence_grade ? row.evidence_grade : null },
    intended_use: { status: null, word: intendedUseWords(row, hasIntendedUse), figure: null }
  };
}

const ROWS = [
  ['overall', 'Overview'],
  ['performance', 'Performance'],
  ['evidence', 'Evidence'],
  ['intended_use', 'Intended use']
];

function leadFor(base, functionEntry) {
  const card = displayUseCase(base.choice.useCase);
  if (base.choice.reason === BASE_CARD_REASONS.same_category) {
    return `Built on ${base.label}. Its ${card} card, the same kind of function, at this condition:`;
  }
  const kind = functionCategoryLabel(functionEntry?.function_category);
  const missing = kind ? `It has no ${kind.toLowerCase()} card, so this is` : 'This is';
  const which = base.choice.reason === BASE_CARD_REASONS.default ? 'its default card' : 'its first card';
  return `Built on ${base.label}. ${missing} ${which}, ${card}, at this condition:`;
}

/**
 * What the Built on section shows for one base model.
 *
 * @param {object} input
 * @param {object} input.base an entry of builtOnBases()
 * @param {object|null} input.functionEntry this card's UseCaseEntry
 * @param {object} input.details this card's ConceptMetrics
 * @param {object|null} input.baseDetails the base card's ConceptMetrics (null while loading or on failure)
 * @param {'plain'|'expert'} input.depth
 * @param {boolean} [input.hasIntendedUse] this card has an intended-use statement
 * @returns {{ lead: string, rows: object[]|null, conflict: string|null, baseName: string }}
 */
export function builtOnContent({ base, functionEntry, details, baseDetails, depth = 'plain', hasIntendedUse = true }) {
  if (!base.choice) {
    return { lead: `Built on ${base.label}, which has no card here.`, rows: null, conflict: null, baseName: base.label };
  }
  const baseHasIntendedUse = hasIntendedUseStatement(base.choice.functionEntry);
  const lead = leadFor(base, functionEntry);
  if (!baseDetails) {
    return { lead, rows: null, conflict: null, baseName: base.label };
  }
  const own = side(details, { depth, hasIntendedUse });
  const theirs = side(baseDetails, { depth, hasIntendedUse: baseHasIntendedUse });
  const conflict = scopeConflict({ row: details?.metrics, hasIntendedUse, baseRow: baseDetails.metrics, baseHasIntendedUse });
  return {
    lead,
    rows: ROWS.map(([view, label]) => ({ view, label, own: own[view], base: theirs[view] })),
    conflict: conflict ? SCOPE_CONFLICT_WORDS[conflict] : null,
    baseName: base.label
  };
}
