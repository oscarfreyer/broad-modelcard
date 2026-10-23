// Where the focus goes after an action in the Data Library: the element that
// now says what happened (a result notice, the page title, a form's first
// field), scrolled into view without motion for readers who reduce it.
// React-free, so the tests can drive it with a stub document.

const reducedMotion = (win) => Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Focuses `node`, making it focusable from script first (tabIndex -1) when it
 * is not, e.g. a heading or a status line. `scroll` brings it into view first.
 *
 * @param {HTMLElement|null|undefined} node
 * @param {{ scroll?: boolean, win?: Window }} [options]
 * @returns {boolean} whether there was a node to focus
 */
export function focusNode(node, { scroll = false, win = globalThis.window } = {}) {
  if (!node) return false;
  if (!node.hasAttribute?.('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(node.tagName ?? '')) {
    node.setAttribute?.('tabindex', '-1');
  }
  if (scroll) {
    node.scrollIntoView?.({ block: 'center', behavior: win && reducedMotion(win) ? 'auto' : 'smooth' });
  }
  node.focus?.({ preventScroll: scroll });
  return true;
}

/**
 * After the next render: scroll the first match of `selector` into view and
 * focus it (Edit in a stored list: the form's "Editing …" line; Start the form
 * again: its first field).
 */
export function revealAndFocus(selector, { win = globalThis.window } = {}) {
  win.setTimeout(() => focusNode(win.document.querySelector(selector), { scroll: true, win }), 0);
}

/** After the next render: focus the page's title (the h1 of the Data Library's main column). */
export function focusPageTitle({ win = globalThis.window } = {}) {
  win.setTimeout(() => focusNode(win.document.querySelector('.admin-main h1'), { win }), 0);
}
