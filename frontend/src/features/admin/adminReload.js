// When the Data Library reads its overview again on window focus (useAdminData):
// not within a few seconds of the last read, so switching windows back and
// forth does not refetch every data set, the registry, and History each time.

export const FOCUS_RELOAD_GAP_MS = 10_000;

/** Whether a window focus at `now` reads the overview again, the last read having started at `lastLoad` (ms). */
export function shouldReloadOnFocus(lastLoad, now, gap = FOCUS_RELOAD_GAP_MS) {
  return !lastLoad || now - lastLoad >= gap;
}
