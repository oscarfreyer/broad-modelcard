// Links between the three pages: the catalogue (index.html), the
// atlas (atlas.html), and the Data Library (admin.html). No router: each page
// is its own entry point, and links carry their state in the query.
import { atlasHref } from '../../app/startupParams.js';

/**
 * Parameters the atlas reads at startup (app/startupParams.js) or keeps in
 * its URL. `index.html` forwards any URL carrying one of them
 * to `atlas.html`, so links from before the catalogue keep working. The
 * catalogue's own parameters (catalogueState.js) never use these names.
 */
export const ATLAS_PARAMS = Object.freeze([
  'version',
  'model',
  'use_case',
  'view',
  'age',
  'sex',
  'ethnicity',
  'setting',
  'population',
  'ontology',
  'mode',
  'depth',
  'chapter',
  'concept',
  'selected'
]);

export const ATLAS_PAGE = './atlas.html';
export const CATALOGUE_PAGE = './';

/**
 * Where `index.html` should forward to, or null to stay on the catalogue.
 *
 * @param {{ search: string, hash?: string }} location
 * @returns {string|null}
 */
export function atlasForwardHref({ search = '', hash = '' } = {}) {
  const params = new URLSearchParams(search);
  if (!ATLAS_PARAMS.some((name) => params.has(name))) {
    return null;
  }
  return `${ATLAS_PAGE}${search.startsWith('?') ? search : `?${search}`}${hash || ''}`;
}

/**
 * The atlas of one card (a catalogue tile), at the catalogue's version and,
 * when the tile was read for one, its local population (contract v1.10).
 */
export function cardAtlasHref(tile, { version = 'live', population = null } = {}) {
  return atlasHref({ version, model: tile.model_version, useCase: tile.use_case, population });
}

/**
 * The card's atlas as an absolute URL, for the label's link text. Always the
 * live card: a label names its dataset version separately.
 *
 * The link reports figures, so it names the view they come from (`view`):
 * that makes it a state URL (app/profileDefaults.js), which opens under the
 * prevalence it names (the default when none) for every reader, never under
 * a reader's own default population.
 *
 * @param {object} tile catalogue tile
 * @param {string} pageUrl the URL of the page the label is made on (location.href)
 * @param {{ population?: string|null, view?: string }} [options] a label made under a local population links to the card with it;
 *   `view` is the view of the figures (the label's are the overall distribution)
 */
export function cardAbsoluteUrl(tile, pageUrl, { population = null, view = 'overall' } = {}) {
  const relative = atlasHref({ model: tile.model_version, useCase: tile.use_case, view, population });
  try {
    return new URL(relative, pageUrl).href;
  } catch {
    return relative;
  }
}
