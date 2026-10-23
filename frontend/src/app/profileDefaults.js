// "Your defaults" at the atlas's startup: the
// profile fills what an entry link leaves open; a shared link means the same
// for every reader.
//
// - An entry link names at most the AI system and function (`model`,
//   `use_case`), or nothing: "Open the atlas", a catalogue tile. The profile
//   fills the rest: the default card when no AI system is named, and the
//   default lens, depth, local population, and classification.
// - Any other URL is atlas state (`isStateUrl`): it carries one of
//   STATE_PARAMS (`view`, `mode`, `chapter`, `concept`, `selected`, a lens
//   axis, `population`, `depth`, or `version`). It opens exactly what it
//   names, with no default at all, so the same link shows the same figures to
//   every reader: the default prevalence when it names no population, all
//   groups when it names no lens. The atlas writes `view` and `mode` into
//   every URL it shows, and links that report figures (a lookup's card links,
//   the label's card link) always write `view`, so they are state URLs too.
//   A staged preview (`version=staged:…`) is one as well: it shows the update
//   as linked.
// - An audience preset (features/profile/audience.js) is a
//   default too: on an entry link it sets the starting depth and view, below
//   an explicit depth default of this browser. `audience` is passed on either
//   way, since it only decides which card sections open first.
import { audiencePreset } from '../features/profile/audience.js';
import { normalizeDefaults } from '../features/profile/profile.js';

/** True when the URL carries the atlas's own state (any of STATE_PARAMS in startupParams.js). */
export function isStateUrl(startup) {
  return (startup?.stateParams?.length ?? 0) > 0;
}

/**
 * The startup parameters with the profile's defaults filled in.
 *
 * @param {ReturnType<import('./startupParams.js').parseStartupParams>} startup
 * @param {object} rawDefaults the profile's `defaults`
 * @returns {ReturnType<import('./startupParams.js').parseStartupParams> & { audience: string|null, appliedDefaults: string[] }}
 */
export function withProfileDefaults(startup, rawDefaults) {
  const defaults = normalizeDefaults(rawDefaults);
  if (isStateUrl(startup) || startup.version !== 'live') {
    return { ...startup, audience: defaults.audience ?? null, appliedDefaults: [] };
  }
  const applied = [];
  const next = { ...startup };
  if (!startup.model && defaults.card) {
    next.model = defaults.card.model;
    next.useCase = defaults.card.useCase;
    applied.push('card');
  }
  if (defaults.lens) {
    next.lens = { age: defaults.lens.age ?? null, sex: defaults.lens.sex ?? null, ethnicity: defaults.lens.ethnicity ?? null };
    applied.push('lens');
  }
  if (defaults.depth) {
    next.depth = defaults.depth;
    applied.push('depth');
  }
  const preset = audiencePreset(defaults.audience);
  if (preset) {
    if (!defaults.depth) {
      next.depth = preset.depth;
    }
    next.view = startup.view ?? preset.view;
    applied.push('audience');
  }
  if (defaults.population) {
    next.population = defaults.population;
    applied.push('population');
  }
  if (defaults.ontology) {
    next.ontology = defaults.ontology;
    applied.push('ontology');
  }
  return { ...next, audience: defaults.audience ?? null, appliedDefaults: applied };
}

/** The comparison parameters that name what the results are for; a URL with any of them opens exactly that. */
// The care setting (v1.14) has no profile default: few cards store a specific one, so a
// default would open most cards on No data. A URL that names one opens exactly that.
const COMPARE_CONTEXT_PARAMS = Object.freeze(['age', 'sex', 'ethnicity', 'setting', 'population', 'ontology', 'chapter']);

/**
 * The comparison's state with the reader's defaults filled in, as the atlas
 * does for an entry link: a URL that names only the cards (the catalogue's
 * Compare, the navigation) takes this browser's default lens, local
 * population, and classification; a URL that names any of them, or a
 * chapter, opens exactly what it names.
 *
 * @param {ReturnType<import('../features/compare/compareState.js').parseCompareState>} state
 * @param {string} search location.search of compare.html
 * @param {object} rawDefaults the profile's `defaults`
 */
export function withCompareDefaults(state, search, rawDefaults) {
  const params = new URLSearchParams(search);
  if (COMPARE_CONTEXT_PARAMS.some((name) => (params.get(name) ?? '').trim() !== '')) {
    return state;
  }
  const defaults = normalizeDefaults(rawDefaults);
  return {
    ...state,
    lens: defaults.lens ? { ...state.lens, ...defaults.lens } : state.lens,
    population: defaults.population ?? state.population,
    ontology: defaults.ontology ?? state.ontology
  };
}

/**
 * The reader's starting depth where a page names none (the comparison): this
 * browser's depth default, else the audience preset's, else null (plain).
 */
export function defaultDepth(rawDefaults) {
  const defaults = normalizeDefaults(rawDefaults);
  return defaults.depth ?? audiencePreset(defaults.audience)?.depth ?? null;
}
