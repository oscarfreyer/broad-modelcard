// The admin page's place, kept in the URL so a reload, the browser's back
// button, and links from the atlas preview ("Back to the update") return to
// the same data set and card (AI system × function). Safety incidents keep
// the card too: the card the incident form and the preview open. Local
// populations keep the population (contract v1.10).

const DATASET_KINDS = Object.freeze(['models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies', 'effects', 'local_metrics']);
/** Without a page in the URL, the Data Library opens on the first data set of the sidebar. */
const FIRST_PAGE = DATASET_KINDS[0];
const POPULATION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Pages that are not data sets (contract v1.13, §26): the workspace choice and the role tools.
const TOOL_VIEWS = Object.freeze(['history', 'workspaces', 'submit', 'review', 'model_cards', 'instance', 'release']);
const PAGES = new Set([...DATASET_KINDS, ...TOOL_VIEWS]);

/**
 * @param {string} search location.search
 * @returns {{ page: string, model: string|null, useCase: string|null, population: string|null, published: number|null }}
 */
export function parseAdminRoute(search) {
  const params = new URLSearchParams(search);
  const set = params.get('set');
  const view = params.get('view');
  const text = (name) => {
    const value = (params.get(name) ?? '').trim();
    return value && value.length <= 200 ? value : null;
  };
  const published = Number(params.get('published'));
  return {
    page: TOOL_VIEWS.includes(view) ? view : PAGES.has(set) ? set : FIRST_PAGE,
    // Whether the URL named a page; without one the Data Library opens on the workspace choice (v1.13).
    explicit: TOOL_VIEWS.includes(view) || PAGES.has(set),
    model: text('model'),
    useCase: text('use_case'),
    population: POPULATION_ID.test(params.get('population') ?? '') ? params.get('population') : null,
    // The version this page just published, so "Restore version N" survives a visit to the atlas.
    published: Number.isInteger(published) && published > 0 ? published : null
  };
}

export function adminRouteSearch({ page, model = null, useCase = null, population = null, published = null }) {
  const params = new URLSearchParams();
  if (TOOL_VIEWS.includes(page)) {
    params.set('view', page);
  } else {
    params.set('set', page);
    if (model) params.set('model', model);
    if (useCase) params.set('use_case', useCase);
    if (population && (page === 'population' || page === 'local_metrics')) params.set('population', population);
    if (published) params.set('published', String(published));
  }
  return `?${params.toString()}`;
}

/**
 * The route after a move within the Data Library: `next` over the current
 * route, on the page shown (`shownPage`, also a workspace's first page when the
 * URL named none), which the URL names from now on. A publish result belongs
 * to its own page and target, so it is dropped unless `next` keeps it.
 */
export function nextAdminRoute(current, shownPage, next) {
  return { ...current, page: shownPage ?? current.page, published: null, explicit: true, ...next };
}
