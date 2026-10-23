// The search palette's words (contract v1.13, CONTRACT.md §23). Framework-free,
// so the node tests can check them.

/**
 * The palette's words for the classification on screen (contract v1.13,
 * §23): search runs over that classification's own codes, so its name is the
 * one the field gives. Combinations stay ICD-11 (§8).
 *
 * @param {string} [name] the classification's name, e.g. "MONDO"; ICD-11 by default
 * @param {boolean} [isMultimorbidityMode]
 */
export function searchWords(name = 'ICD-11', isMultimorbidityMode = false) {
  const scheme = name || 'ICD-11';
  const example = scheme === 'ICD-11' ? ' (for example 5A11)' : '';
  return {
    dialog: `Search ${scheme}`,
    field: `Search conditions and ${scheme} codes`,
    hint: isMultimorbidityMode
      ? 'Type a condition name or ICD-11 code to add it to the combination.'
      : `Type ${/^[AEIOU]/i.test(scheme) ? 'an' : 'a'} ${scheme} code${example} or part of a condition name.`,
    empty: `Check the spelling, try a shorter part of the name, or search by ${scheme} code.`
  };
}
