// The Data Library's "Local populations" page (contract v1.10, CONTRACT.md §21): which population an update is for, the form fields the
// upload sends, the template links, and the words for the removal. A local
// population is a named local prevalence set in the prevalence template; it
// is aggregate, synthetic demonstration data only.
import { POPULATION_ID } from '../../shared/localPopulation.js';

export const MAX_POPULATION_NAME = 80;
export const NEW_POPULATION = '';

/** A population id suggested from its display name: "Northbridge region (fictional)" → "northbridge-region-fictional". */
export function suggestPopulationId(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * The populations a maintainer can pick: every live one, then each one that
 * exists only as a staged upload (a new population waiting to be published).
 *
 * @param {{ id: string, name: string, codes: number }[]|null} livePopulations `/meta.populations` (live)
 * @param {object[]} stagedUploads the data set's staged uploads (getUpload)
 * @returns {{ id: string, name: string, codes: number|null, isLive: boolean, upload: object|null }[]}
 */
export function populationChoices(livePopulations, stagedUploads = []) {
  const byId = new Map();
  (livePopulations ?? []).forEach((entry) => {
    byId.set(entry.id, { id: entry.id, name: entry.name, codes: entry.codes ?? null, isLive: true, upload: null });
  });
  stagedUploads.forEach((upload) => {
    const id = upload?.target?.population_id;
    if (!id) return;
    const known = byId.get(id);
    if (known) {
      byId.set(id, { ...known, upload });
    } else {
      byId.set(id, { id, name: upload.target.population_name ?? id, codes: null, isLive: false, upload });
    }
  });
  return [...byId.values()];
}

/**
 * The live populations without one just removed on this page: `/meta` still
 * lists it until it is read again, but it is no longer a choice.
 *
 * @param {object[]|null} livePopulations `/meta.populations` (live)
 * @param {string|null} removedId
 */
export function withoutRemoved(livePopulations, removedId) {
  if (!livePopulations || !removedId) {
    return livePopulations;
  }
  return livePopulations.filter((entry) => entry.id !== removedId);
}

/**
 * The population the page is on: the chosen one while it is a choice (or a
 * new one being named), or the one the page's staged upload is for (a new
 * population's first upload, before the staged list is read again);
 * otherwise, e.g. a stale `?population=` link or a population just removed,
 * the first choice, else a new one. While `/meta` loads, the chosen one or null.
 *
 * @param {string|null} choice the chosen id, NEW_POPULATION, or null (not chosen yet)
 * @param {ReturnType<typeof populationChoices>} choices
 * @param {{ isLoaded: boolean, stagedId?: string|null }} options
 */
export function shownPopulationChoice(choice, choices, { isLoaded, stagedId = null }) {
  if (!isLoaded) {
    return choice ?? null;
  }
  if (choice === NEW_POPULATION) {
    return NEW_POPULATION;
  }
  if (choice != null && (choice === stagedId || choices.some((entry) => entry.id === choice))) {
    return choice;
  }
  return choices[0]?.id ?? NEW_POPULATION;
}

/**
 * What is wrong with a new population's id and name, field by field (null
 * when nothing): the contract's id pattern, a name of at most 80 characters,
 * and an id no live population uses.
 *
 * @param {{ id: string, name: string }} draft
 * @param {string[]} takenIds ids of the live populations
 */
export function draftProblems(draft, takenIds = []) {
  const id = (draft?.id ?? '').trim();
  const name = (draft?.name ?? '').trim();
  let idProblem = null;
  if (!id) {
    idProblem = 'Give the population a short id, for example northbridge-region.';
  } else if (!POPULATION_ID.test(id)) {
    idProblem = 'Use lowercase letters, digits, and hyphens only, starting with a letter or digit, at most 40 characters.';
  } else if (takenIds.includes(id)) {
    idProblem = 'A local population with this id exists. Choose it above to replace its list, or pick another id.';
  }
  let nameProblem = null;
  if (!name) {
    nameProblem = 'Give the population a name readers will see, for example “Northbridge region (fictional)”.';
  } else if (name.length > MAX_POPULATION_NAME) {
    nameProblem = `Keep the name to ${MAX_POPULATION_NAME} characters.`;
  }
  return { id: idProblem, name: nameProblem };
}

/**
 * The population an update on the page is for, or null while a new one's
 * id or name is not valid yet.
 *
 * @param {{ choice: string, draft: { id: string, name: string }, rename?: string }} state
 *   choice: the chosen population id, or NEW_POPULATION for a new one
 * @param {ReturnType<typeof populationChoices>} choices
 * @returns {{ populationId: string, populationName: string, isNew: boolean, isLive: boolean, liveName: string|null }|null}
 */
export function populationTarget({ choice, draft }, choices) {
  if (choice !== NEW_POPULATION) {
    const known = choices.find((entry) => entry.id === choice);
    return known
      ? { populationId: known.id, populationName: known.name, isNew: !known.isLive, isLive: known.isLive, liveName: known.isLive ? known.name : null }
      : null;
  }
  const takenIds = choices.filter((entry) => entry.isLive).map((entry) => entry.id);
  const problems = draftProblems(draft, takenIds);
  if (problems.id || problems.name) {
    return null;
  }
  return { populationId: draft.id.trim(), populationName: draft.name.trim(), isNew: true, isLive: false, liveName: null };
}

/**
 * The upload's form fields (createUpload): the id always; the name for a new
 * population (required by the contract) and never for a live one, whose name
 * stays as it is.
 */
export function populationUploadFields(target) {
  if (!target) {
    return {};
  }
  return target.isLive ? { populationId: target.populationId } : { populationId: target.populationId, populationName: target.populationName };
}

/**
 * Template downloads: a live population's own list, or for a new one the
 * default tiers to edit into it (CONTRACT.md §21). The empty template is the
 * prevalence template either way.
 */
export function populationTemplateParams(target) {
  return target?.isLive ? { populationId: target.populationId } : {};
}

/** "Northbridge region (fictional) (northbridge-region)" */
export function populationLabel(target) {
  if (!target) return '';
  return `${target.populationName} (${target.populationId})`;
}

/** The sentence the remove sheet starts with. */
export function removalText(population, nextVersion) {
  return `${population.name} (${population.id}) leaves the live data as version ${nextVersion ?? 'N'}. Views that use it go back to the default prevalence. History keeps it: restoring an earlier version of Local populations brings it back.`;
}
