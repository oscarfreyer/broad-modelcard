// Keyboard rules of the code picker's combobox (CodePicker.jsx), kept pure so
// the node tests can check them without a browser.

/** At most this many matches are drawn; the keyboard moves among these only. */
export const SHOWN_MATCHES = 12;

/** The matches the list draws, in order. */
export function shownMatches(matches) {
  return matches.slice(0, SHOWN_MATCHES);
}

/** The highlighted index, kept inside the drawn options (null when none is drawn). */
export function activeIndex(active, shownCount) {
  if (!shownCount) return null;
  return Math.min(Math.max(active, 0), shownCount - 1);
}

/**
 * What a key does in the combobox. Enter never reaches the form: with a drawn
 * option highlighted it picks that option, otherwise it does nothing (a search
 * still pending or without a match must not submit the form for the old code).
 *
 * @param {string} key KeyboardEvent.key
 * @param {{ active: number, shownCount: number, isListShown: boolean }} state
 * @returns {{ preventDefault: boolean, open?: boolean, active?: number, pick?: number }}
 */
export function comboboxKey(key, { active, shownCount, isListShown }) {
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (!shownCount) return { preventDefault: true, open: true };
    const step = key === 'ArrowDown' ? 1 : -1;
    const current = activeIndex(active, shownCount);
    return { preventDefault: true, open: true, active: (current + step + shownCount) % shownCount };
  }
  if (key === 'Enter') {
    const current = activeIndex(active, shownCount);
    return isListShown && current !== null ? { preventDefault: true, pick: current } : { preventDefault: true };
  }
  return { preventDefault: false };
}
