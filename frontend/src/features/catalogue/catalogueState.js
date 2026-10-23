// The catalogue's view state (tab, filters, sort) and its URL. The state lives
// in the query of index.html, so a shared URL reopens the same view. Names
// never collide with the atlas's parameters (pageLinks.js ATLAS_PARAMS), which
// make index.html forward to the atlas. Defaults are left out of the URL.
import { parseCards } from '../compare/compareState.js';

export const TABS = Object.freeze({ performance: 'performance', safety: 'safety', mine: 'mine' });
export const DEFAULT_TAB = TABS.performance;

export const SORTS = Object.freeze({
  name: 'name',
  release: 'release',
  updated: 'updated',
  incidents: 'incidents'
});
export const DEFAULT_SORT = SORTS.name;

/**
 * The sort a tab opens with until the reader chooses one: Safety leads with
 * the most open incidents (when the catalogue offers that sort), every other
 * tab with the name. A sort the reader chose is kept across tabs.
 *
 * @param {string} tab
 * @param {string[]} [sorts] the sorts on offer (availableSorts)
 */
export function defaultSortFor(tab, sorts = Object.values(SORTS)) {
  return tab === TABS.safety && sorts.includes(SORTS.incidents) ? SORTS.incidents : DEFAULT_SORT;
}

/** The URL parameter of the text search (never an atlas parameter). */
export const QUERY_PARAM = 'q';
const MAX_QUERY = 120;

/** Filter fields, in display order: state key → URL parameter. */
export const FILTER_PARAMS = Object.freeze({
  system: 'system',
  functionName: 'function',
  // The function category (contract v1.5, §11.1; Patient communication and Administrative since v1.14).
  category: 'category',
  kind: 'kind',
  aiType: 'ai_type',
  developer: 'developer',
  status: 'status'
});
export const FILTER_KEYS = Object.freeze(Object.keys(FILTER_PARAMS));

const KINDS = new Set(['model', 'product']);
const STATUSES = new Set(['ACTIVE', 'EXPERIMENTAL']);
const AI_TYPE = /^[a-z_]{1,40}$/;
const CATEGORY = /^[a-z_]{1,40}$/;
// A staged preview of the catalogue: `?preview=staged:<upload_id>`. Not
// `version`, which is an atlas parameter and would forward to the atlas.
const STAGED_VERSION = /^staged:[A-Za-z0-9_-]{1,64}$/;

/** The cards chosen for a comparison (never an atlas parameter). */
export const COMPARE_PARAM = 'compare';

/** "Newest versions only" (contract v1.14, §28.2): `newest=1` hides AI systems another version replaces. */
export const NEWEST_PARAM = 'newest';

export const EMPTY_FILTERS = Object.freeze(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])));

function text(value) {
  const trimmed = (value ?? '').trim();
  return trimmed && trimmed.length <= 200 ? trimmed : null;
}

/**
 * `sort` is null when the URL names none: the tab's own default applies
 * (defaultSortFor) until the reader picks one.
 *
 * @param {string} search location.search of index.html
 * @returns {{ tab: string, sort: string|null, query: string, filters: Record<string, string|null>, newest: boolean, version: string, compare: string[] }}
 */
export function parseCatalogueState(search) {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  const sort = params.get('sort');
  const kind = params.get(FILTER_PARAMS.kind);
  const status = (params.get(FILTER_PARAMS.status) ?? '').toUpperCase();
  const aiType = params.get(FILTER_PARAMS.aiType);
  const category = params.get(FILTER_PARAMS.category);
  const preview = params.get('preview') ?? '';
  return {
    tab: Object.values(TABS).includes(tab) ? tab : DEFAULT_TAB,
    sort: Object.values(SORTS).includes(sort) ? sort : null,
    query: (params.get(QUERY_PARAM) ?? '').trim().slice(0, MAX_QUERY),
    filters: {
      system: text(params.get(FILTER_PARAMS.system)),
      functionName: text(params.get(FILTER_PARAMS.functionName)),
      category: category && CATEGORY.test(category) ? category : null,
      kind: KINDS.has(kind) ? kind : null,
      aiType: aiType && AI_TYPE.test(aiType) ? aiType : null,
      developer: text(params.get(FILTER_PARAMS.developer)),
      status: STATUSES.has(status) ? status : null
    },
    newest: params.get(NEWEST_PARAM) === '1',
    version: STAGED_VERSION.test(preview) ? preview : 'live',
    // The cards chosen for a comparison: `compare=<card_id>,…`, at most four.
    compare: parseCards(params.get(COMPARE_PARAM))
  };
}

/**
 * The query string for a state, without defaults ('' for the default view).
 * A sort is written only when the reader chose it and it differs from the
 * tab's default.
 *
 * @param {{ tab?: string, sort?: string|null, query?: string, filters?: Record<string, string|null>, newest?: boolean, version?: string }} state
 */
export function catalogueSearch({ tab = DEFAULT_TAB, sort = null, query = '', filters = EMPTY_FILTERS, newest = false, version = 'live', compare = [] } = {}) {
  const params = new URLSearchParams();
  if (version && version !== 'live') params.set('preview', version);
  if (tab !== DEFAULT_TAB) params.set('tab', tab);
  const text = (query ?? '').trim();
  if (text) params.set(QUERY_PARAM, text.slice(0, MAX_QUERY));
  for (const key of FILTER_KEYS) {
    if (filters[key]) params.set(FILTER_PARAMS[key], filters[key]);
  }
  if (newest) params.set(NEWEST_PARAM, '1');
  if (sort && sort !== defaultSortFor(tab)) params.set('sort', sort);
  if (compare?.length) params.set(COMPARE_PARAM, compare.join(','));
  const written = params.toString();
  return written ? `?${written}` : '';
}

export function activeFilterCount(filters) {
  return FILTER_KEYS.filter((key) => filters[key]).length;
}
