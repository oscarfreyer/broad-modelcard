// Display words and bubble-size weights for the commonness tier the API serves
// on every condition (`Concept.prevalence_tier`, CONTRACT.md §5). The API
// owns which tier a condition has; chapters and blocks have none.

const PREVALENCE_TIER_LABELS = Object.freeze({
  very_rare: 'Very rare',
  rare: 'Rare',
  uncommon: 'Uncommon',
  common: 'Common',
  very_common: 'Very common'
});

const PREVALENCE_TIER_WEIGHTS = Object.freeze({
  very_rare: 1,
  rare: 2,
  uncommon: 3,
  common: 4,
  very_common: 5
});

/** Rarity weight 1 (very rare) to 5 (very common); 1 when the concept has no tier. */
export function prevalenceTierWeight(concept) {
  return PREVALENCE_TIER_WEIGHTS[concept?.prevalence_tier] ?? 1;
}

/** "Very rare" … "Very common", or null when the concept has no tier. */
export function prevalenceTierLabel(concept) {
  return PREVALENCE_TIER_LABELS[concept?.prevalence_tier] ?? null;
}
