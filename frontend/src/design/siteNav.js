// The pages of the shared navigation (SiteNav.jsx), React-free so the tests can read them.
import { IS_STATIC_BUILD } from '../shared/staticBuild.js';

/**
 * The surfaces and their one shared navigation (audit A12): the same
 * items in the same order on the catalogue, the atlas, the Data Library, and
 * the live interaction page. The current page is named, not linked.
 */
export const SITE_PAGES = Object.freeze([
  { id: 'catalogue', label: 'AI systems', href: './' },
  // The comparison page; the static build records it too (R7).
  { id: 'compare', label: 'Compare', href: './compare.html' },
  { id: 'admin', label: 'Data Library', href: './admin.html' },
  { id: 'plugin', label: 'Live interaction', href: './plugin.html' }
]);

/** The pages the static build holds (R7): the catalogue and the comparison, no Data Library, no live interaction. */
export const STATIC_SITE_PAGE_IDS = Object.freeze(['catalogue', 'compare']);

/**
 * The pages a surface links to, in the shared order, with the current one
 * marked. `hrefs` replaces a page's link where the surface carries state to
 * it (the comparison links back to the catalogue with its cards chosen).
 */
export function siteNavItems(current, { isStatic = IS_STATIC_BUILD, hrefs = null } = {}) {
  const pages = isStatic ? SITE_PAGES.filter((page) => STATIC_SITE_PAGE_IDS.includes(page.id)) : SITE_PAGES;
  return pages.map((page) => ({ ...page, href: hrefs?.[page.id] ?? page.href, isCurrent: page.id === current }));
}
