// The legend tile's entries (RingLegend.jsx), kept apart from the JSX so the
// tests can check them: which marks a view lists, in which order, and the
// one short line that says what an absence or Safety mark means.
import { ABSENCE_MEANING, ALERT_ORDER, SAFETY_MEANING, keysForView } from '../../design/status.js';

/**
 * The legend's entries for the active view: every mark the view can draw,
 * in key order. Overview lists the two incident marks that replace a result
 * first. Zero rows stay (dimmed), so the list never changes length on the
 * same view. Absence marks drawn on the ring that the view's keys do not
 * list (No stored combination) follow; Loading never gets a row (the counts
 * read "–" while they load). In another classification (contract v1.13)
 * every view lists No mapping, last.
 */
export function legendKeys({ viewId, hasIntendedUse = true, absences = [], withMapping = false }) {
  const keys = [...(viewId === 'overall' ? ALERT_ORDER : []), ...keysForView(viewId, { hasIntendedUse, withMapping })];
  return [...keys, ...absences.filter((key) => key !== 'loading' && !keys.includes(key))];
}

/** One short line on what an absence or Safety mark means; null for a result. */
export function legendMeaning(key) {
  return SAFETY_MEANING[key] ?? ABSENCE_MEANING[key] ?? null;
}
