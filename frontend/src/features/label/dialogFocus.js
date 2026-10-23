// Focus for a modal <dialog> that React mounts and unmounts: remember the
// control that had focus when the dialog opened and give focus back to it
// when the dialog goes away, so keyboard users land where they started
// (WAI-ARIA dialog pattern) instead of on <body>.

/**
 * Call when the dialog opens; call the returned function when it goes away.
 *
 * @param {Document} doc
 * @returns {() => void} returns focus to the opener, if it is still on the page
 */
export function rememberOpener(doc = globalThis.document) {
  const opener = doc?.activeElement ?? null;
  return () => {
    if (!opener || opener === doc.body || !opener.isConnected || typeof opener.focus !== 'function') {
      return;
    }
    if (doc.activeElement !== opener) {
      opener.focus();
    }
  };
}

const LOCK_CLASS = 'has-modal';
let locks = 0;

/**
 * Keeps the page behind a modal dialog still: the root element gets
 * `has-modal` (overflow hidden, base.css) while at least one dialog holds a
 * lock, so a wheel or swipe over the dialog never scrolls the page behind it.
 * Call when the dialog opens; call the returned function when it goes away.
 *
 * @param {Document} doc
 * @returns {() => void} releases this lock (once)
 */
export function lockPageScroll(doc = globalThis.document) {
  const root = doc?.documentElement;
  if (!root) return () => {};
  locks += 1;
  root.classList.add(LOCK_CLASS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks = Math.max(0, locks - 1);
    if (!locks) root.classList.remove(LOCK_CLASS);
  };
}
