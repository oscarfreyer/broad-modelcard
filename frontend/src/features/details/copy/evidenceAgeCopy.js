// Evidence age on the condition card and in the Summary (contract v1.14, CONTRACT.md §28.5): which configuration and which
// version of the AI system a result was measured on, beside the card's
// current ones. Information only: no grade, status, warning, or mark follows
// from it. React-free.
import { systemName } from '../../../shared/aiSystem.js';

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The versions an AI system replaces, nearest first (its `replaces` chain,
 * CONTRACT.md §28.2); a loop or a version the registry lacks ends it.
 */
export function replacesChain(entry, registry = []) {
  const known = new Map(registry.map((other) => [other.model_version, other]));
  const chain = [];
  let version = text(entry?.replaces);
  while (version && !chain.includes(version) && version !== entry?.model_version) {
    chain.push(version);
    version = text(known.get(version)?.replaces);
  }
  return chain;
}

/**
 * What the condition card compares a linked study with: the card's AI system,
 * its current configuration id (or null), and its earlier versions.
 *
 * @param {object|null} entry ModelEntry on screen
 * @param {object|null} functionEntry UseCaseEntry on screen
 * @param {object[]} [registry] every ModelEntry
 */
export function evidenceAgeContext(entry, functionEntry, registry = []) {
  if (!entry) return null;
  const known = new Map(registry.map((other) => [other.model_version, other]));
  return {
    modelVersion: entry.model_version,
    configurationId: text(functionEntry?.configuration?.configuration_id) || null,
    earlierVersions: replacesChain(entry, registry),
    nameOf: (version) => systemName(known.get(version) ?? null, version)
  };
}

/**
 * The configuration a study evaluated against the card's current one
 * (CONTRACT.md §28.5): `current`, `earlier`, or `not_stated`, and its words.
 */
export function evaluatedConfiguration(study, context) {
  const evaluated = text(study?.configuration_id);
  const current = context?.configurationId ?? null;
  if (!evaluated) return { state: 'not_stated', text: 'Not stated' };
  if (!current) return { state: 'not_stated', text: `${evaluated} (the card states no current configuration)` };
  if (evaluated === current) return { state: 'current', text: `Current configuration (${evaluated})` };
  return { state: 'earlier', text: `Earlier configuration (${evaluated}; current ${current})` };
}

/**
 * "An earlier version (Vantrel Triage 2.0)" when the study evaluated a version
 * this AI system replaces, the other system's name when it evaluated another
 * one, else null (the same AI system, or none named).
 */
export function measuredOn(study, context) {
  const version = text(study?.model_version);
  if (!version || !context || version === context.modelVersion) return null;
  const name = context.nameOf ? context.nameOf(version) : version;
  return context.earlierVersions?.includes(version) ? `An earlier version (${name})` : name;
}

/**
 * The evidence-age facts of Study quality: Evaluated configuration, and
 * Measured on when the study evaluated another version.
 */
export function evidenceAgeFacts(study, context) {
  if (!study || !context) return [];
  const measured = measuredOn(study, context);
  return [
    { label: 'Evaluated configuration', value: evaluatedConfiguration(study, context).text },
    ...(measured ? [{ label: 'Measured on', value: measured }] : [])
  ];
}

const count = (value) => Number(value).toLocaleString('en-US');

/**
 * The Summary's card on the Evidence view (§28.5), from getMetricSummary's
 * `configuration_counts`, or null when it is absent (no linked graded condition).
 */
export function configurationHighlight(counts) {
  if (!counts) return null;
  const { current = 0, earlier = 0, not_stated: notStated = 0 } = counts;
  const total = current + earlier + notStated;
  if (!total) return null;
  const parts = [
    current ? `${count(current)} on the current configuration` : null,
    earlier ? `${count(earlier)} on an earlier configuration` : null,
    notStated ? `${count(notStated)} not stated` : null
  ].filter(Boolean);
  return {
    id: 'configuration',
    tone: 'info',
    title: earlier ? `Measured on an earlier configuration: ${count(earlier)}` : 'Evaluated configuration',
    text: `Of ${count(total)} ${total === 1 ? 'condition' : 'conditions'} with a study record: ${parts.join(', ')}. Across the card.`,
    targetId: null
  };
}
