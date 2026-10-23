// "Your defaults" in words and options: what the
// sheet offers and how the catalogue and atlas describe the defaults set.
// Framework-free so the node tests can check it.
import { systemName } from '../../shared/aiSystem.js';
import { displayUseCase, populationWords } from '../../shared/format.js';
import { findPopulation } from '../../shared/localPopulation.js';
import { AUDIENCES, audienceLabel, audiencePreset } from './audience.js';
import { normalizeDefaults } from './profile.js';

export const DEFAULTS_TITLE = 'Settings';
/** The header's Settings button (AppHeader.jsx). */
export const SETTINGS_TITLE = DEFAULTS_TITLE;
/** The synthetic-data badge's help: the sentence the page banners used to carry. */
export const SYNTHETIC_HELP = 'All data here is synthetic, for demonstration only. It is not evidence about any real AI system.';
export const DEFAULTS_INTRO =
  'What a card opens with when you come from the catalogue, or from a link that names only the card. A link copied from the atlas, a model card, or the live interaction panel still opens exactly what it shows, for every reader.';

/** What the depth choice does, in words (the segments' tooltips are not enough). */
export const DEPTH_HELP =
  'How much a card explains. Plain uses everyday words; Expert adds thresholds, A–F grades, and safeguard actions.';

/**
 * The sheet reads `/meta` and the registry at the live version, also inside a
 * staged preview, so an unpublished population or AI system is never offered
 * as a default (its own query keys keep these apart from the preview's reads).
 */
export const LIVE_META_KEY = 'meta|live';
export const LIVE_MODELS_KEY = 'models|live';
export const readLiveMeta = (client, options = {}) => client.getMeta({}, { ...options, version: 'live' });
export const readLiveModels = (client, options = {}) => client.listModels({}, { ...options, version: 'live' });

/**
 * Plain is the default (no stored choice); a stored 'plain' reads the same.
 * The retired "By mode" choice (Expert in Detailed mode) is gone,
 * so a profile without a depth opens in plain words everywhere.
 */
export const DEPTH_CHOICES = Object.freeze([
  { value: '', label: 'Plain', title: 'Plain-language explanations' },
  { value: 'expert', label: 'Expert', title: 'Technical detail and A–F grades' }
]);

/** The depth choice a stored default shows as. */
export function depthChoice(depth, audience = null) {
  const effective = depth ?? audiencePreset(audience)?.depth ?? null;
  return effective === 'expert' ? 'expert' : '';
}

/**
 * The depth to store when the reader picks one in the sheet (choice '' is
 * plain): nothing when it equals what the audience preset gives anyway, so
 * the preset keeps deciding; else the explicit choice, which wins over it.
 */
export function depthToStore(choice, audience = null) {
  const picked = choice === 'expert' ? 'expert' : 'plain';
  const preset = audiencePreset(audience)?.depth ?? 'plain';
  return picked === preset ? null : picked;
}

/** The audience choices of the sheet: none, then the five presets. */
export const AUDIENCE_CHOICES = Object.freeze([
  { value: '', label: 'No preference' },
  ...AUDIENCES.map((audience) => ({ value: audience.id, label: audience.label }))
]);

/** What the chosen audience does, in one line (the sheet's help under the select). */
export function audienceHelp(audience) {
  return AUDIENCES.find((entry) => entry.id === audience)?.help ?? 'Cards open with plain words and their usual order.';
}

/** AI systems for the card picker: [{ value, label }] from listModels().models. */
export function systemChoices(models) {
  return (models ?? []).map((entry) => ({ value: entry.model_version, label: systemName(entry, entry.model_version) }));
}

/** The functions of one AI system: [{ value, label }]. */
export function functionChoices(models, modelVersion) {
  const entry = (models ?? []).find((candidate) => candidate.model_version === modelVersion);
  return (entry?.use_cases ?? []).map((useCase) => ({ value: useCase.use_case, label: displayUseCase(useCase.use_case) }));
}

/** The card after choosing an AI system: its default function, or its first. */
export function cardForSystem(models, modelVersion) {
  if (!modelVersion) {
    return null;
  }
  const entry = (models ?? []).find((candidate) => candidate.model_version === modelVersion);
  if (!entry) {
    return null;
  }
  const useCases = entry.use_cases.map((useCase) => useCase.use_case);
  const useCase = useCases.includes(entry.default_use_case) ? entry.default_use_case : useCases[0];
  return useCase ? { model: modelVersion, useCase } : null;
}

/**
 * The defaults as short phrases, in a fixed order (card, lens, depth,
 * prevalence), for the catalogue's line and the sheet's summary. A default
 * the data no longer offers is named and marked.
 *
 * @param {object} rawDefaults
 * @param {{ models?: object[]|null, populations?: object[]|null, ontologies?: object[]|null }} [data]
 * @returns {string[]}
 */
export function defaultsPhrases(rawDefaults, { models = null, populations = null, ontologies = null } = {}) {
  const defaults = normalizeDefaults(rawDefaults);
  const phrases = [];
  if (defaults.audience) {
    phrases.push(`Reading as ${audienceLabel(defaults.audience)}`);
  }
  if (defaults.card) {
    const entry = models?.find((candidate) => candidate.model_version === defaults.card.model) ?? null;
    const name = entry ? systemName(entry, defaults.card.model) : defaults.card.model;
    phrases.push(`${name}, ${displayUseCase(defaults.card.useCase)}`);
  }
  if (defaults.lens) {
    phrases.push(populationWords({ age: defaults.lens.age ?? 'All ages', sex: defaults.lens.sex ?? 'All sexes', ethnicity: defaults.lens.ethnicity ?? 'All ethnicities' }));
  }
  if (defaults.depth) {
    phrases.push(defaults.depth === 'expert' ? 'Expert depth' : 'Plain depth');
  }
  if (defaults.population) {
    const population = findPopulation(populations, defaults.population);
    if (population) {
      phrases.push(`Local prevalence: ${population.name}`);
    } else if (populations) {
      phrases.push(`Local prevalence ${defaults.population} (no longer in the data)`);
    } else {
      phrases.push(`Local prevalence ${defaults.population}`);
    }
  }
  if (defaults.ontology) {
    const entry = ontologies?.find((candidate) => candidate.id === defaults.ontology) ?? null;
    phrases.push(entry ? `Classification: ${entry.name}` : ontologies ? `Classification ${defaults.ontology} (not in this data)` : `Classification ${defaults.ontology}`);
  }
  return phrases;
}

/**
 * The atlas state as defaults ("Use what is on screen"): the card, the lens
 * axes that are not "All …", the depth, the local population, and the
 * classification (contract v1.13).
 *
 * @param {{ model: string, useCase: string, age: string, sex: string, ethnicity: string, population?: string, ontology?: string }|null} filters
 * @param {'plain'|'expert'|null} depth
 * @param {object[]|null} [livePopulations] the live `/meta.populations`; when given, a population it does not
 *   list (a staged one being previewed) is not taken over
 */
export function defaultsFromView(filters, depth, livePopulations = null) {
  if (!filters) {
    return {};
  }
  const population = filters.population && (!livePopulations || findPopulation(livePopulations, filters.population)) ? filters.population : undefined;
  return normalizeDefaults({
    card: { model: filters.model, useCase: filters.useCase },
    lens: { age: filters.age, sex: filters.sex, ethnicity: filters.ethnicity },
    depth: depth ?? undefined,
    population,
    ontology: filters.ontology
  });
}
