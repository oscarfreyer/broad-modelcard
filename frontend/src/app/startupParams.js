// The atlas state in its URL. The atlas writes what is on
// screen into the query (useAtlasUrlState.js), so a copied URL reopens the
// same view; the admin page links here the same way, e.g. to preview a staged
// update (`?version=staged:<upload_id>`) on its AI system and function.
//
// Parameters (all optional; unknown or malformed values are ignored and the
// app's own defaults win):
//   version    `staged:<upload_id>` for a preview; absent for the live data
//   model      AI system (registry `model_version`)
//   use_case   function of that AI system
//   view       overall | performance | evidence | intended_use | safety
//   age, sex, ethnicity   demographic lens; absent means "All …"
//   setting    a care setting's code (contract v1.14, e.g. emergency_department); absent: Any setting
//   population a local population id (contract v1.10); absent: the default prevalence
//   ontology   the classification (contract v1.13): icd10cm or mondo; absent: ICD-11
//   mode       focused | multimorbidity (a link with the retired `detailed` opens focused)
//   depth      plain | expert, only when it is not plain
//   chapter    the open chapter of the classification (absent at atlas level)
//   concept    the selected chapter, subchapter, or condition
//   selected   multimorbidity selection, comma-separated condition ids
// Values that need the data (an unknown AI system, a concept that does not
// exist) are checked by the atlas once its data has loaded.

import { isPopulationId } from '../shared/localPopulation.js';
import { isOntologyId, otherOntology } from '../shared/ontology.js';
import { depthOf } from '../shared/depth.js';
import { codeOfSetting, settingOfCode } from '../shared/careSetting.js';

const STAGED_VERSION = /^staged:([A-Za-z0-9_-]{1,64})$/;
const VIEWS = new Set(['overall', 'performance', 'evidence', 'intended_use', 'safety']);
const MODES = new Set(['focused', 'detailed', 'multimorbidity']);
// Concept ids of every classification: ICD-11 (5A11, BLK-05-BlockL1-5A0),
// ICD-10-CM (E11.9, CM-BLK-E08-E13), and MONDO (MONDO:0005148), v1.13.
const CONCEPT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_SELECTED = 32;

/** The lens values that mean "no filter"; they stay out of the URL. */
export const ALL_LENS = Object.freeze({ age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' });
const LENS_AXES = Object.keys(ALL_LENS);

const conceptId = (value) => (value && CONCEPT_ID.test(value) ? value : null);

/**
 * The parameters that carry the atlas's own state: everything except the
 * card (`model`, `use_case`). A URL that carries any of them reopens what its
 * sender saw, for every reader (profileDefaults.js).
 */
export const STATE_PARAMS = Object.freeze([
  'version', 'view', 'age', 'sex', 'ethnicity', 'setting', 'population', 'ontology', 'mode', 'depth', 'chapter', 'concept', 'selected'
]);

/**
 * @param {string} search location.search
 * @returns {{
 *   version: string, previewUploadId: string|null, model: string|null, useCase: string|null,
 *   view: string|null, mode: string|null, depth: string|null,
 *   lens: { age: string|null, sex: string|null, ethnicity: string|null }, setting: string|null,
 *   population: string|null, ontology: string|null,
 *   chapterId: string|null, conceptId: string|null, selectedIds: string[],
 *   stateParams: string[]
 * }}
 * `stateParams` names the STATE_PARAMS the query carries (non-empty, valid or not).
 */
export function parseStartupParams(search) {
  const params = new URLSearchParams(search);
  const staged = STAGED_VERSION.exec(params.get('version') ?? '');
  const text = (name) => {
    const value = (params.get(name) ?? '').trim();
    return value && value.length <= 200 ? value : null;
  };
  const oneOf = (name, allowed) => (allowed.has(params.get(name)) ? params.get(name) : null);
  const selectedIds = [
    ...new Set((params.get('selected') ?? '').split(',').map((id) => id.trim()).filter((id) => CONCEPT_ID.test(id)))
  ].slice(0, MAX_SELECTED);
  return {
    version: staged ? staged[0] : 'live',
    previewUploadId: staged ? staged[1] : null,
    model: text('model'),
    useCase: text('use_case'),
    view: oneOf('view', VIEWS),
    mode: oneOf('mode', MODES),
    depth: depthOf(params.get('depth')),
    lens: Object.fromEntries(LENS_AXES.map((axis) => [axis, text(axis)])),
    // The axis value of a specific care setting (v1.14); an unknown code reads as Any setting.
    setting: settingOfCode(params.get('setting')),
    population: isPopulationId(params.get('population')) ? params.get('population') : null,
    // ICD-11 is the default: an explicit `ontology=icd11` reads as no choice.
    ontology: isOntologyId(params.get('ontology')) ? otherOntology(params.get('ontology')) : null,
    chapterId: conceptId(params.get('chapter')),
    conceptId: conceptId(params.get('concept')),
    selectedIds,
    stateParams: STATE_PARAMS.filter((name) => (params.get(name) ?? '').trim() !== '')
  };
}

/**
 * The query string (`?…`, or '' when empty) for the given atlas state. Takes
 * the names `parseStartupParams` returns (`setting` as its axis value, written as its code); lens values equal to "All …" and
 * empty values are left out.
 */
export function atlasSearch({ version, model, useCase, view, lens, setting, population, ontology, mode, depth, chapterId, conceptId: concept, selectedIds } = {}) {
  const params = new URLSearchParams();
  if (version && version !== 'live') params.set('version', version);
  if (model) params.set('model', model);
  if (useCase) params.set('use_case', useCase);
  if (view) params.set('view', view);
  LENS_AXES.forEach((axis) => {
    const value = lens?.[axis];
    if (value && value !== ALL_LENS[axis]) params.set(axis, value);
  });
  // A specific care setting by its code (v1.14); Any setting is left out.
  if (codeOfSetting(setting)) params.set('setting', codeOfSetting(setting));
  if (population) params.set('population', population);
  if (otherOntology(ontology)) params.set('ontology', ontology);
  if (mode) params.set('mode', mode);
  if (depth) params.set('depth', depth);
  if (chapterId) params.set('chapter', chapterId);
  if (concept) params.set('concept', concept);
  if (selectedIds?.length) params.set('selected', selectedIds.join(','));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * The same query with commas and colons unescaped (both are legal in a
 * query), so the URL the atlas writes stays legible when shared, e.g.
 * `?version=staged:abc&selected=5A11,5B81`. Parses to the same values.
 */
export function readableSearch(search) {
  return search.replace(/%2C/g, ',').replace(/%3A/g, ':');
}

/**
 * Atlas URL for the given state (relative to the app's base), e.g.
 * `./atlas.html?version=staged:abc&model=SynGPT-2.0`. The atlas is its own
 * page since the catalogue took index.html.
 */
export function atlasHref(state = {}) {
  return `./atlas.html${atlasSearch(state)}`;
}
