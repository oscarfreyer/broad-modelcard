// The comparison page's state in its URL: compare.html
// writes what is on screen into the query, so a copied URL reopens the same
// comparison. Framework-free, so the node tests can read it.
//
// Parameters (all optional; unknown or malformed values are ignored):
//   cards      2 to 4 card ids, comma-separated: `<model_version>|<use_case>`
//   chapter    the chapter the rows drill into (absent: one row per chapter)
//   age, sex, ethnicity   the demographic lens; absent means "All …"
//   setting    a care setting's code (contract v1.14, e.g. emergency_department); absent: Any setting
//   population a local population id (contract v1.10); absent: the default prevalence
//   ontology   the classification (contract v1.13): icd10cm or mondo; absent: ICD-11
//   show       comparable | flagged (absent: all rows)
//   sort       difference (absent: atlas order)
//   depth      plain | expert (absent: the reader's default depth, else plain);
//              written when it is expert or differs from the reader's default
//   view       the atlas view the links back open (overall | performance | …;
//              absent: Overview); the table always shows the Overview mark
import { isPopulationId } from '../../shared/localPopulation.js';
import { isOntologyId, otherOntology } from '../../shared/ontology.js';
import { ALL_LENS } from '../../app/startupParams.js';
import { depthOf } from '../../shared/depth.js';
import { codeOfSetting, settingOfCode } from '../../shared/careSetting.js';

export const MIN_CARDS = 2;
export const MAX_CARDS = 4;
export const COMPARE_PAGE = './compare.html';

export const SHOW = Object.freeze({ all: 'all', comparable: 'comparable', flagged: 'flagged' });
export const SORTS = Object.freeze({ atlas: 'atlas', difference: 'difference' });

const LENS_AXES = Object.keys(ALL_LENS);
const CONCEPT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const VIEWS = new Set(['overall', 'performance', 'evidence', 'intended_use', 'safety']);
const MAX_CARD_ID = 300;

/** Whether a string is a card id: `<model_version>|<use_case>`, both parts present, one `|`. */
export function isCardId(value) {
  if (typeof value !== 'string' || value.length > MAX_CARD_ID || value.includes(',')) {
    return false;
  }
  const parts = value.split('|');
  return parts.length === 2 && parts[0].trim() !== '' && parts[1].trim() !== '';
}

/** The card id of a model version and function. */
export function cardIdOf(modelVersion, useCase) {
  return `${modelVersion}|${useCase}`;
}

/** `{ modelVersion, useCase }` of a card id. */
export function splitCardId(cardId) {
  const [modelVersion, useCase] = String(cardId).split('|');
  return { modelVersion, useCase };
}

/** Distinct valid card ids from a `cards` value, in order, at most MAX_CARDS. */
export function parseCards(value) {
  const seen = [];
  for (const part of String(value ?? '').split(',')) {
    const id = part.trim();
    if (isCardId(id) && !seen.includes(id)) seen.push(id);
  }
  return seen.slice(0, MAX_CARDS);
}

/**
 * Adds a card. Refused, with the reason, when the comparison holds MAX_CARDS
 * already or the card is in it.
 *
 * @returns {{ cards: string[], refused: null|'full'|'duplicate'|'invalid' }}
 */
export function addCard(cards, cardId) {
  if (!isCardId(cardId)) return { cards, refused: 'invalid' };
  if (cards.includes(cardId)) return { cards, refused: 'duplicate' };
  if (cards.length >= MAX_CARDS) return { cards, refused: 'full' };
  return { cards: [...cards, cardId], refused: null };
}

export function removeCard(cards, cardId) {
  return cards.filter((id) => id !== cardId);
}

/** A comparison can be read once it holds MIN_CARDS. */
export function isComparable(cards) {
  return cards.length >= MIN_CARDS && cards.length <= MAX_CARDS;
}

/**
 * @param {string} search location.search of compare.html
 */
export function parseCompareState(search) {
  const params = new URLSearchParams(search);
  const text = (name) => {
    const value = (params.get(name) ?? '').trim();
    return value && value.length <= 200 ? value : null;
  };
  const chapter = params.get('chapter');
  const show = params.get('show');
  const sort = params.get('sort');
  return {
    cards: parseCards(params.get('cards')),
    chapterId: chapter && CONCEPT_ID.test(chapter) ? chapter : null,
    lens: Object.fromEntries(LENS_AXES.map((axis) => [axis, text(axis) ?? ALL_LENS[axis]])),
    // The axis value of a specific care setting (v1.14), or null for Any setting.
    setting: settingOfCode(params.get('setting')),
    population: isPopulationId(params.get('population')) ? params.get('population') : null,
    ontology: isOntologyId(params.get('ontology')) ? otherOntology(params.get('ontology')) : null,
    show: Object.values(SHOW).includes(show) ? show : SHOW.all,
    sort: Object.values(SORTS).includes(sort) ? sort : SORTS.atlas,
    // null: the URL names none, so the reader's default applies (compareMain.jsx).
    depth: depthOf(params.get('depth')),
    view: VIEWS.has(params.get('view')) && params.get('view') !== 'overall' ? params.get('view') : null
  };
}

/**
 * The query (`?…`, or '') for a state; defaults are left out, and commas,
 * colons, and pipes stay legible, so a shared URL reads as what it names.
 */
export function compareSearch({ cards = [], chapterId = null, lens = ALL_LENS, setting = null, population = null, ontology = null, show = SHOW.all, sort = SORTS.atlas, depth = null, view = null } = {}) {
  const params = new URLSearchParams();
  if (cards.length) params.set('cards', cards.join(','));
  if (chapterId) params.set('chapter', chapterId);
  LENS_AXES.forEach((axis) => {
    const value = lens?.[axis];
    if (value && value !== ALL_LENS[axis]) params.set(axis, value);
  });
  if (codeOfSetting(setting)) params.set('setting', codeOfSetting(setting));
  if (population) params.set('population', population);
  if (otherOntology(ontology)) params.set('ontology', ontology);
  if (show && show !== SHOW.all) params.set('show', show);
  if (sort && sort !== SORTS.atlas) params.set('sort', sort);
  // The caller decides whether plain is worth naming (it differs from the reader's default).
  if (depthOf(depth)) params.set('depth', depth);
  if (VIEWS.has(view) && view !== 'overall') params.set('view', view);
  const query = params.toString().replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%7C/g, '|');
  return query ? `?${query}` : '';
}

/**
 * The depth a comparison URL names: Expert always, Plain only for a reader
 * whose own default is Expert, so a plain URL reopens plain for that reader
 * while it stays out of the URL for everyone else.
 */
export function urlDepth(depth, readerDepth = null) {
  if (depth === 'expert') return 'expert';
  return readerDepth === 'expert' && depth === 'plain' ? 'plain' : null;
}

/** The comparison page for a state, relative to the app's base. */
export function compareHref(state = {}) {
  return `${COMPARE_PAGE}${compareSearch(state)}`;
}
