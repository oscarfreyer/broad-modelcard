// The status vocabulary (CONTRACT.md §4.5) as the interface shows it: a word
// and one mark. Performance levels are three fills; each absence state has
// its own shape (outline, barred, dot, pale), in one grey family, never a
// colour alone.

/** Metric views in display order. `id` is the contract MetricView. */
export const VIEWS = Object.freeze([
  { id: 'overall', label: 'Overview', noun: 'overview' },
  { id: 'performance', label: 'Performance', noun: 'performance' },
  { id: 'evidence', label: 'Evidence', noun: 'evidence' },
  { id: 'intended_use', label: 'Intended use', noun: 'intended-use fit' }
]);

/**
 * The Safety view (contract v1.7, CONTRACT.md §18). Not a
 * metric: it marks the conditions with an open or mitigated safety incident,
 * like a warning, and leaves every other condition neutral. It never changes
 * a result on the four metric views.
 */
export const SAFETY_VIEW = Object.freeze({ id: 'safety', label: 'Safety', noun: 'safety incidents' });

/** The atlas's views: the four metric views, then Safety. */
export const ATLAS_VIEWS = Object.freeze([...VIEWS, SAFETY_VIEW]);

export function viewLabel(viewId) {
  return ATLAS_VIEWS.find((view) => view.id === viewId)?.label ?? viewId;
}

export function isSafetyView(viewId) {
  return viewId === SAFETY_VIEW.id;
}

/** Why the Intended use view is off for a card without a statement. */
export const NO_STATEMENT_TEXT = 'This card has no intended-use statement.';

/**
 * Whether a card (a registry function entry or a catalogue tile) has an
 * intended-use statement: contract v1.11 `intended_use_defined`, absent = true.
 */
export function hasIntendedUseStatement(entry) {
  return entry?.intended_use_defined !== false;
}

/**
 * Display keys: the contract statuses, the two intended-use levels that are
 * not statuses, and the interface-only states (No stored combination,
 * Loading, and the Safety view's three marks). `form` names the one mark that
 * draws the key everywhere (StatusMark.js, styles/marks.css); `tone` names the
 * colour family of the word (CSS --tone-*).
 *
 * Absence forms ("The Shape Carries Absence Rule"),
 * one grey family for every missing state:
 *   outline  No data                light grey disc, solid dark grey outline
 *   barred   Out of scope           dark grey disc crossed by a white bar
 *   slashed  No mapping             the No data disc struck through by a thin diagonal, ⊘ (contract v1.13)
 *   dot      No stored combination  a small grey dot, no disc
 *   pale     Loading                pale disc, no edge
 *
 * "Not validated" is not a state any more: a result without
 * validation evidence reads No data like every other missing result.
 */
export const DISPLAY = Object.freeze({
  strong: { label: 'Strong', form: 'fill', tone: 'strong' },
  moderate: { label: 'Moderate', form: 'fill', tone: 'moderate' },
  weak: { label: 'Weak', form: 'fill', tone: 'weak' },
  out_of_scope: { label: 'Out of scope', form: 'barred', tone: 'absent' },
  no_data: { label: 'No data', form: 'outline', tone: 'absent' },
  // Another ontology only (contract v1.13, CONTRACT.md §23): the condition has
  // no ICD-11 counterpart, so no result can be shown. Never a guessed result.
  no_mapping: { label: 'No mapping', form: 'slashed', tone: 'absent' },
  // Intended use has its own scale (audit A22): scope is a statement, not a
  // performance level, so it never borrows Strong green or Moderate amber.
  in_scope: { label: 'In scope', form: 'fill', tone: 'scope' },
  partially_in_scope: { label: 'Partly in scope', form: 'half', tone: 'scope' },
  // Multimorbidity mode only: the condition cannot start or extend the combination.
  no_combination: { label: 'No stored combination', form: 'dot', tone: 'absent' },
  // Metrics not loaded yet.
  loading: { label: 'Loading', form: 'pale', tone: 'absent' },
  // Safety view: neutral when nothing is reported, never green and never
  // "safe"; Caution and Serious add a warning glyph (CONTRACT.md §18).
  no_incidents: { label: 'No reported incidents', form: 'quiet', tone: 'absent' },
  caution: { label: 'Caution', form: 'alert', tone: 'moderate' },
  serious: { label: 'Serious', form: 'alert', tone: 'weak' }
});

/**
 * The one place where a status the API serves becomes a display key. Until
 * contract v1.11 the API still serves `not_validated` (a result
 * without validation evidence); it reads No data.
 */
export function normalizeStatus(value) {
  return value === 'not_validated' ? 'no_data' : value;
}

/** Status counts (StatusCounts, a distribution) with a `not_validated` count folded into No data. */
export function normalizeCounts(counts) {
  if (!counts || !Object.hasOwn(counts, 'not_validated')) {
    return counts;
  }
  const { not_validated: notValidated, ...rest } = counts;
  return { ...rest, no_data: (rest.no_data ?? 0) + (notValidated ?? 0) };
}

/** States without a result, in the order the key explains them. */
export const ABSENCE_ORDER = Object.freeze(['out_of_scope', 'no_data', 'no_mapping', 'no_combination', 'loading']);

/** Plain meaning of each absence mark, for the ring key. */
export const ABSENCE_MEANING = Object.freeze({
  out_of_scope: 'the AI system is not meant for it',
  no_data: 'no graded result is stored',
  no_mapping: 'no ICD-11 match, so no result',
  no_combination: 'cannot join the combination',
  loading: 'the results are loading'
});

/**
 * Whether a decoded map row or a concept read belongs to a condition of
 * another ontology without an ICD-11 mapping (contract v1.13: the map's
 * `mapping` column, the concept read's `mapping.kind`).
 */
export function isUnmapped(row) {
  return row?.mapping === 'none' || row?.mapping?.kind === 'none';
}

/** Safety marks, worst first, in the order the key and counts list them. */
export const SAFETY_ORDER = Object.freeze(['serious', 'caution', 'no_incidents']);

/**
 * Plain meaning of each Safety mark, one short line for the legend
 *: Serious is an open incident in which harm occurred
 * or could have, or a recall or safety notice; Caution is any other open
 * incident, or a mitigated one. The condition card names the incident itself.
 */
export const SAFETY_MEANING = Object.freeze({
  serious: 'harm or risk of harm, or a recall',
  caution: 'other open or mitigated incident',
  no_incidents: 'this does not mean safe'
});

/** The Safety marks that also show on Overview, worst first. */
export const ALERT_ORDER = Object.freeze(['serious', 'caution']);

/** The Safety mark of a contract `safety` value (map column, incident severity). */
export function safetyKey(value) {
  return value === 'serious' || value === 'caution' ? value : 'no_incidents';
}

export function isAbsence(key) {
  return ABSENCE_ORDER.includes(key);
}

/** Overview keys: the catalogue's and model card's distribution order too. */
export const STATUS_ORDER = Object.freeze(['strong', 'moderate', 'weak', 'out_of_scope', 'no_data']);
/** Performance and Evidence ignore scope: no Out of scope. */
const GRADED_ORDER = Object.freeze(['strong', 'moderate', 'weak', 'no_data']);
/** Intended-use levels a row can carry. */
export const INTENDED_USE_LEVELS = Object.freeze(['in_scope', 'partially_in_scope', 'out_of_scope']);
/** Intended-use display keys: the three levels, then No data for conditions without a row. */
export const INTENDED_USE_ORDER = Object.freeze([...INTENDED_USE_LEVELS, 'no_data']);

/**
 * Keys in the order the key, counts, and strips list them, per view. On
 * Overview a card without an intended-use statement never shows Out of
 * scope, so its keys leave it out.
 *
 * In another ontology (contract v1.13) every view also lists No mapping,
 * last: an unmapped condition reads it on every view, Safety included.
 *
 * @param {string} viewId
 * @param {{ hasIntendedUse?: boolean, withMapping?: boolean }} [options]
 */
export function keysForView(viewId, { hasIntendedUse = true, withMapping = false } = {}) {
  let keys;
  if (viewId === 'intended_use') {
    keys = INTENDED_USE_ORDER;
  } else if (isSafetyView(viewId)) {
    keys = SAFETY_ORDER;
  } else {
    keys = viewId === 'overall' && hasIntendedUse ? STATUS_ORDER : GRADED_ORDER;
  }
  return withMapping ? [...keys, 'no_mapping'] : keys;
}

export function displayFor(key) {
  return DISPLAY[normalizeStatus(key)] ?? DISPLAY.no_data;
}

/** A served status as a display key: a known key, else No data. */
function servedStatus(value) {
  const key = normalizeStatus(value);
  return key && DISPLAY[key] ? key : 'no_data';
}

/**
 * One rule for "no row" on every view, including Intended use: a condition
 * without a row (or a row without an intended-use level) is No data. Out of
 * scope means the data says so (CONTRACT.md §4.5 and §13).
 */
function intendedUseKey(row) {
  return INTENDED_USE_LEVELS.includes(row?.intended_use_level) ? row.intended_use_level : 'no_data';
}

/**
 * A block or chapter rollup without children for the lens (CONTRACT.md §6,
 * §13, V1): no condition under it has a row. The API serves it as out of
 * scope for parity (`out_of_scope_group`, `scope-stop`), but that describes
 * scope, which the data does not say; the interface presents it as No data.
 * Reads a decoded map row (`child_count`, v1.10) and a contract MetricRow
 * (`provenance.rollup.child_count`) alike.
 */
export function isRollupWithoutChildren(row) {
  return row?.child_count === 0 || row?.provenance?.rollup?.child_count === 0;
}

/** The row the interface presents: none for a rollup without children (the no-row rule). */
export function presentedRow(row) {
  return isRollupWithoutChildren(row) ? null : row ?? null;
}

/**
 * The steps of the Overview rule, in order: the first that
 * applies decides the mark. "How the Overview works" and the condition card's
 * "What is behind this mark?" name these steps; `overviewDecision` is the one
 * place that applies them, for the ring and the explainer alike.
 */
export const OVERVIEW_STEPS = Object.freeze(['incident', 'scope', 'grade', 'no_data']);

const GRADED_STATUSES = Object.freeze(['strong', 'moderate', 'weak']);

/**
 * Overview, per condition, first match wins: (a) an open or
 * mitigated safety incident at the lens (the map's `safety` column, as on the
 * Safety view; a subchapter takes its worst condition's): Serious or Caution;
 * (b) the card has an intended-use statement and the condition is out of
 * scope: Out of scope; (c) the combined performance and evidence grade:
 * Strong, Moderate, or Weak; (d) otherwise No data. Incidents change only the
 * mark: grades and scores stay as they are (CONTRACT.md §18).
 *
 * @param {object} input
 * @param {string|null} [input.safety] the worst incident mark at the lens ('serious', 'caution', else none)
 * @param {string|null} [input.overallStatus] the served overall status (null without a result)
 * @param {boolean} [input.hasIntendedUse] the card has an intended-use statement
 * @returns {{ step: 'incident'|'scope'|'grade'|'no_data', status: string }}
 */
export function overviewDecision({ safety = null, overallStatus = null, hasIntendedUse = true } = {}) {
  const alert = safetyKey(safety);
  if (alert !== 'no_incidents') {
    return { step: 'incident', status: alert };
  }
  const status = servedStatus(overallStatus);
  // A card without a statement has no scope, so nothing on it is out of scope.
  if (status === 'out_of_scope') {
    return hasIntendedUse ? { step: 'scope', status } : { step: 'no_data', status: 'no_data' };
  }
  if (GRADED_STATUSES.includes(status)) {
    return { step: 'grade', status };
  }
  return { step: 'no_data', status: 'no_data' };
}

function overviewKey(row, { hasIntendedUse = true, withSafety = true } = {}) {
  if (!row) {
    return 'no_data';
  }
  return overviewDecision({ safety: withSafety ? row.safety : null, overallStatus: row.overall_status, hasIntendedUse }).status;
}

/**
 * Display key of a decoded metric map row for one view.
 *
 * @param {object|null} mapRow
 * @param {string} viewId
 * @param {{ hasIntendedUse?: boolean, withSafety?: boolean }} [options]
 *   hasIntendedUse: the card has an intended-use statement
 *   (`hasIntendedUseStatement`); withSafety: Overview draws open incidents
 *   (false reads the result underneath)
 */
export function mapRowStatus(mapRow, viewId, options = {}) {
  if (isUnmapped(mapRow)) {
    return 'no_mapping';
  }
  const row = presentedRow(mapRow);
  if (isSafetyView(viewId)) {
    return safetyKey(row?.safety);
  }
  if (viewId === 'intended_use') {
    return intendedUseKey(row);
  }
  if (viewId === 'overall') {
    return overviewKey(row, options);
  }
  return row ? servedStatus(row[`${viewId}_status`]) : 'no_data';
}

/**
 * Display key of a ring bubble: the map row's status, Loading before the
 * metrics arrive, and in Multimorbidity mode No stored combination for a
 * condition without a display row. A combination's result has no incidents
 * of its own, so Overview draws its grade there. The ring, the hover card,
 * and the candidate list all read it here.
 */
export function ringStatus(row, viewId, { isCombinationMode = false, isLoading = false, hasIntendedUse = true } = {}) {
  if (isLoading) {
    return 'loading';
  }
  if (isCombinationMode && !row) {
    return 'no_combination';
  }
  return mapRowStatus(row, viewId, { hasIntendedUse, withSafety: !isCombinationMode });
}

/**
 * Display key of a full contract MetricRow for one view. A MetricRow carries
 * no safety mark (incidents come with the concept read, `incidentsMark`), so
 * the Safety view reads No reported incidents here and Overview reads the
 * result (`overviewStatus` adds the incidents).
 */
export function metricRowStatus(metricRow, viewId, { hasIntendedUse = true } = {}) {
  const row = presentedRow(metricRow);
  if (isSafetyView(viewId)) {
    return 'no_incidents';
  }
  if (viewId === 'intended_use') {
    return intendedUseKey(row);
  }
  const status = servedStatus(row?.status?.[viewId]);
  return viewId === 'overall' && status === 'out_of_scope' && !hasIntendedUse ? 'no_data' : status;
}

/**
 * The Overview mark of a concept read (the detail card header):
 * an open or mitigated incident's mark first, else its Overview result.
 *
 * @param {object|null} metricRow contract MetricRow
 * @param {string} incidentMark the worst incident mark ('serious', 'caution', 'no_incidents')
 */
export function overviewStatus(metricRow, incidentMark, { hasIntendedUse = true } = {}) {
  return overviewDecision({ safety: incidentMark, overallStatus: presentedRow(metricRow)?.status?.overall ?? null, hasIntendedUse }).status;
}

/** Grade letter for a view (expert depth only), or null. */
export function gradeFor(row, viewId) {
  if (!row) {
    return null;
  }
  if (viewId === 'overall') {
    return row.overall?.grade ?? row.overall_grade ?? null;
  }
  if (viewId === 'performance') {
    return row.performance_grade ?? null;
  }
  if (viewId === 'evidence') {
    return row.evidence_grade ?? null;
  }
  return null;
}

/** Count display keys over rows for one view (options as `mapRowStatus`). */
export function countStatuses(rows, viewId, options = {}) {
  const counts = Object.fromEntries(keysForView(viewId, options).map((key) => [key, 0]));
  for (const row of rows) {
    const key = mapRowStatus(row, viewId, options);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const ABSENCE_KEYS = Object.freeze(['out_of_scope', 'no_data', 'no_mapping']);

/**
 * The share of rows without a result for a view, and the most common kind of
 * absence. On the Intended use view a subchapter bubble draws this share as a
 * centre in that absence's shape (`subchapterCore`). Null when every row has
 * a result. Incidents are not results: on Overview it counts the results
 * underneath them.
 *
 * @param {(object|null)[]} rows decoded map rows of the subchapter's conditions
 * @param {string} viewId
 * @param {{ hasIntendedUse?: boolean }} [options]
 * @returns {{ share: number, status: string, count: number, total: number }|null}
 */
export function absenceCore(rows, viewId, { hasIntendedUse = true } = {}) {
  if (!rows.length) {
    return null;
  }
  const counts = countStatuses(rows, viewId, { hasIntendedUse, withSafety: false });
  const absent = ABSENCE_KEYS.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  if (!absent) {
    return null;
  }
  const status = ABSENCE_KEYS.reduce((best, key) => ((counts[key] ?? 0) > (counts[best] ?? 0) ? key : best), ABSENCE_KEYS[0]);
  return { share: absent / rows.length, status, count: absent, total: rows.length };
}

/**
 * The centre of a subchapter bubble. The bubble
 * keeps its rolled-up colour; the centre shows what that colour hides.
 * - Overview, Performance, Evidence: the share of its conditions that are
 *   Weak on the view, drawn in the Weak mark (on Overview the results
 *   underneath incidents; incidents never change a result). `noData` counts
 *   the conditions without a result, which the hover card names.
 * - Intended use, where Weak does not apply: the share without a scope fit
 *   (Out of scope or No data), in the commonest absence's mark.
 * - Safety: none (a subchapter wears its worst mark; the hover card counts).
 * Display only: grades and rollups are unchanged.
 *
 * @param {(object|null)[]} rows decoded map rows of the subchapter's conditions
 * @param {string} viewId
 * @param {{ hasIntendedUse?: boolean }} [options]
 * @returns {{ share: number, status: string, count: number, total: number, noData?: number }|null}
 */
export function subchapterCore(rows, viewId, { hasIntendedUse = true } = {}) {
  if (!rows.length || isSafetyView(viewId)) {
    return null;
  }
  if (viewId === 'intended_use') {
    return absenceCore(rows, viewId, { hasIntendedUse });
  }
  const counts = countStatuses(rows, viewId, { hasIntendedUse, withSafety: false });
  const weak = counts.weak ?? 0;
  if (!weak) {
    return null;
  }
  return { share: weak / rows.length, status: 'weak', count: weak, total: rows.length, noData: counts.no_data ?? 0 };
}

/** No centre on a subchapter bubble smaller than this radius on screen (px). */
export const MIN_CORE_BUBBLE_PX = 5;
/** A centre is at least this radius on screen (px). */
export const MIN_CORE_PX = 2;

/**
 * Whether a centre is drawn on a subchapter bubble of radius `r` (ring
 * units) at `pxPerUnit`, and its radius: area-proportional to the share,
 * at least MIN_CORE_PX across on screen and at most 72% of the bubble, so
 * a rim of the bubble's own colour always shows. Below MIN_CORE_BUBBLE_PX
 * of bubble radius no centre is drawn: it would not read (a phone ring,
 * the smallest subchapters at 1024 px).
 *
 * @returns {number|null} the centre's radius in ring units, or null
 */
export function coreRadius(r, share, pxPerUnit) {
  if (!(share > 0) || !(r > 0) || !(pxPerUnit > 0) || r * pxPerUnit < MIN_CORE_BUBBLE_PX) {
    return null;
  }
  return Math.min(r * 0.72, Math.max(MIN_CORE_PX / pxPerUnit, r * Math.sqrt(share)));
}

/**
 * What the ring key explains for the ring in view: the absence marks drawn
 * (the bubbles' own states and the subchapter centres' states, in key order)
 * and whether any subchapter carries a centre.
 *
 * @param {object} input
 * @param {object[]} input.tiles layout tiles (with concept_id)
 * @param {Map<string, object>} input.rowsById decoded map rows
 * @param {string} input.viewId
 * @param {boolean} [input.isCombinationMode]
 * @param {boolean} [input.isLoading]
 * @param {boolean} [input.hasIntendedUse] the card has an intended-use statement
 * @param {Map<string, { status: string }>|null} [input.coresById]
 * `safety` lists the Safety marks drawn (worst first): on the Safety view all
 * three, on Overview the Serious and Caution marks that replace a result
 *; it is empty on the other views.
 *
 * @returns {{ absences: string[], safety: string[], hasCores: boolean }}
 */
export function ringKeyEntries({ tiles, rowsById, viewId, isCombinationMode = false, isLoading = false, hasIntendedUse = true, coresById = null }) {
  if (isLoading) {
    return { absences: ['loading'], safety: [], hasCores: false };
  }
  const seen = new Set();
  let hasCores = false;
  for (const tile of tiles || []) {
    if (tile.isEmpty || !tile.concept_id) {
      continue;
    }
    const row = rowsById?.get(tile.concept_id) ?? null;
    const status = ringStatus(row, viewId, { isCombinationMode, hasIntendedUse });
    seen.add(status);
    const core = coresById?.get(tile.concept_id);
    if (core && DISPLAY[status]?.form === 'fill') {
      if (isAbsence(core.status)) {
        seen.add(core.status);
      }
      hasCores = true;
    }
  }
  const safetyKeys = isSafetyView(viewId) ? SAFETY_ORDER : viewId === 'overall' ? ALERT_ORDER : [];
  return {
    absences: ABSENCE_ORDER.filter((key) => seen.has(key)),
    safety: safetyKeys.filter((key) => seen.has(key)),
    hasCores
  };
}
