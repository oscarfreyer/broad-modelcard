// Who a result is for, named beside every result: the
// demographic lens in the lens words the toolbar uses ("All patients",
// "Age 65+, Female") and the prevalence the read used (the default, or a
// local population by name). One formatter for the condition card, hover card,
// Summary, exports, the model card, and the live panel, so they never word it
// differently. React-free: the panel bundle imports it.
import { populationWords } from './format.js';
import { specificSetting } from './careSetting.js';

export const DEFAULT_PREVALENCE_WORDS = 'default prevalence';

/**
 * The two parts: the patient group and the prevalence.
 *
 * @param {{ age?: string, sex?: string, ethnicity?: string }|null} lens contract Lens (missing axes read "All …")
 * @param {{ id: string, name: string }|null} [population] the local population the read used; null: the default
 * @returns {{ group: string, prevalence: string, isLocal: boolean, isAllPatients: boolean }}
 */
export function resultPopulationParts(lens, population = null) {
  const group = populationWords(lens);
  const isLocal = Boolean(population?.name);
  return {
    group,
    prevalence: isLocal ? population.name : DEFAULT_PREVALENCE_WORDS,
    isLocal,
    isAllPatients: group === 'All patients'
  };
}

/**
 * "All patients, default prevalence", "Age 65+, Female, Northbridge region (fictional)", with a specific
 * care setting (contract v1.14, §29) after the group: "All patients, Emergency department, default
 * prevalence" (Any setting is not named: it is what every result was before settings), and with another
 * classification on screen (contract v1.13, §23) its name last: "All patients, default prevalence, MONDO"
 * (no dot separators).
 *
 * @param {object|null} lens
 * @param {{ id: string, name: string }|null} [population]
 * @param {{ separator?: string, ontology?: { id: string, name: string }|null, setting?: string|null }} [options]
 *   `separator` between the parts (default ", "); `ontology` the response's `ontology` (absent or ICD-11:
 *   not named); `setting` the care setting's axis value (absent or Clinical: not named)
 */
export function resultPopulationLabel(lens, population = null, { separator = ', ', ontology = null, setting = null } = {}) {
  const { group, prevalence } = resultPopulationParts(lens, population);
  const classification = ontology?.name && ontology.id !== 'icd11' ? `${separator}${ontology.name}` : '';
  const careSetting = specificSetting(setting) ? `${separator}${setting}` : '';
  return `${group}${careSetting}${separator}${prevalence}${classification}`;
}

/** The lens of a filters object (the atlas's `{ age, sex, ethnicity, … }`). */
export function lensOfFilters(filters) {
  return filters ? { age: filters.age, sex: filters.sex, ethnicity: filters.ethnicity } : null;
}

/**
 * A file-name part for the lens, care setting (v1.14), and population, or '' for all patients in Any
 * setting at the default prevalence.
 */
export function resultPopulationSlug(lens, population = null, setting = null) {
  const { group, isLocal, isAllPatients } = resultPopulationParts(lens, population);
  const parts = [isAllPatients ? null : group, specificSetting(setting), isLocal ? population.id : null].filter(Boolean);
  return parts
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
