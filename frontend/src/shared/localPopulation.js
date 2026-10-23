// Local populations in the interface's words (contract v1.10, CONTRACT.md §21). A local population is a named local prevalence set: how common
// each condition is in one region or service. It replaces the default tiers
// for the conditions it lists, so bubble sizes, evidence weighting, and the
// statuses derived from them can differ. Every view that uses one names it,
// next to the synthetic-data notice. The name comes from the data (the demo's
// "Northbridge region (fictional)"); the words here add that the set is
// synthetic and never imply real local data.

/** The id pattern of the contract (`PopulationId`). */
export const POPULATION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const DEFAULT_PREVALENCE = 'Default prevalence';

/** What the default and a local prevalence are, for the switch and the notes. */
export const PREVALENCE_NOTE =
  'How common each condition is. It sizes the bubbles and weighs the evidence, so a local set can change results.';
export const LOCAL_SYNTHETIC_NOTE = 'Local prevalence sets are synthetic demonstration data, like everything here.';

export function isPopulationId(value) {
  return typeof value === 'string' && POPULATION_ID.test(value);
}

/** The population with this id in a `/meta.populations` list, or null. */
export function findPopulation(populations, id) {
  if (!id || !Array.isArray(populations)) {
    return null;
  }
  return populations.find((entry) => entry.id === id) ?? null;
}

/** "Local prevalence: Northbridge region (fictional)", or null for the default. */
export function localPrevalenceTitle(population) {
  return population?.name ? `Local prevalence: ${population.name}` : null;
}

/** "310 conditions" listed by a local set; the rest keep the default tier. */
export function populationCoverage(population) {
  const codes = Number(population?.codes);
  if (!Number.isFinite(codes)) {
    return null;
  }
  return `Local tiers for ${codes.toLocaleString('en-US')} ICD-11 ${codes === 1 ? 'code' : 'codes'}; every other condition keeps the default.`;
}

/**
 * The sentence next to the synthetic-data notice (ring key, label, exports),
 * or null for the default population.
 */
export function localPrevalenceNotice(population) {
  if (!population?.name) {
    return null;
  }
  return `Local prevalence: ${population.name}. A synthetic local prevalence set, not measured data; it sizes the bubbles and weighs the evidence here.`;
}

/**
 * The About sentence of a condition card read under a local population.
 *
 * @param {{ id: string, name: string }|null} population the response's `population`
 * @param {'plain'|'expert'} depth
 */
export function localPrevalenceSentence(population, depth) {
  if (!population?.name) {
    return null;
  }
  return depth === 'expert'
    ? `Prevalence: the local population ${population.name} (${population.id}). Its synthetic tiers replace the default ones for the codes it lists and feed the evidence-grade penalty and rollup weights.`
    : `How common conditions are comes from the local prevalence ${population.name}, a synthetic local set. With the default prevalence this result can differ.`;
}

/** The prevalence line of an export: "Local: Northbridge region (fictional) (northbridge-region), synthetic", or "Default". */
export function prevalenceExportText(population) {
  return population?.name ? `Local: ${population.name} (${population.id}), synthetic local prevalence` : 'Default';
}

/**
 * Where a chosen local population stands against `/meta.populations`:
 * - 'default': none chosen;
 * - 'pending': chosen, but `/meta` has not loaded yet (reads wait);
 * - 'active': listed, with its entry;
 * - 'dropped': not listed (removed meanwhile, or never there): the view goes
 *   back to the default prevalence, and `dropped` says which one and whether
 *   it had been available (`seenNames` holds the populations seen before).
 *
 * @param {string|null} id
 * @param {object[]|null} populations
 * @param {Map<string, string>} [seenNames] id → name of every population seen so far
 */
export function checkPopulation(id, populations, seenNames = new Map()) {
  if (!id) {
    return { status: 'default', entry: null, dropped: null };
  }
  if (!populations) {
    return { status: 'pending', entry: null, dropped: null };
  }
  const entry = findPopulation(populations, id);
  if (entry) {
    return { status: 'active', entry, dropped: null };
  }
  return { status: 'dropped', entry: null, dropped: { id, name: seenNames.get(id) ?? null, wasAvailable: seenNames.has(id) } };
}

/**
 * The population the reads may send for a checked choice, in the same render:
 * - 'default' and 'active': the choice (none, or the listed one), sendable;
 * - 'pending': the choice, not sendable yet (reads wait for `/meta`);
 * - 'dropped': none, sendable at once, so no read goes out with a population
 *   that `/meta` no longer lists (the selection resets itself after the render).
 *
 * @param {string|null} id the chosen population
 * @param {ReturnType<typeof checkPopulation>} check
 * @returns {{ population: string|null, isSendable: boolean }}
 */
export function populationForReads(id, check) {
  if (check.status === 'dropped' || !id) {
    return { population: null, isSendable: true };
  }
  return { population: id, isSendable: check.status === 'active' };
}

/**
 * Why the atlas went back to the default prevalence: the population was
 * removed meanwhile (it had been available), or the link named one this data
 * does not hold.
 *
 * @param {{ id: string, name: string|null, wasAvailable: boolean }} dropped
 */
export function populationFallbackText(dropped) {
  const name = dropped.name ?? dropped.id;
  return dropped.wasAvailable
    ? `The local prevalence ${name} was removed from the data, so the default prevalence is shown again.`
    : `There is no local prevalence called ${name} in this data, so the default prevalence is shown.`;
}
