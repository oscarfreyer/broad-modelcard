// "Across groups" on the condition card (contract v1.13, CONTRACT.md §24): the condition's performance for each patient group next to
// all patients, from one getConceptSubgroups read. About population groups,
// never about study quality (that is "Study quality", §22). The difference
// flag is the backend's (a prototype heuristic, not a grade); this module only
// words it and lays out the rows. React-free so the node tests can check it.
import { formatScore, rangeModel, rangePosition } from '../../../design/rangeScale.js';
import { isRollupWithoutChildren } from '../../../design/status.js';
import { lensValueWords } from '../../../shared/format.js';

export const ACROSS_GROUPS_TITLE = 'Across groups';
export const ACROSS_GROUPS_LEAD = 'Performance for each group of patients. The line marks all patients.';
export const ACROSS_GROUPS_UNAVAILABLE = 'Results by group could not be loaded.';
export const CHOOSE_GROUP_HINT = 'Choose a group to show it on the atlas.';
export const FALLBACK_WORDS = 'Worked out from related groups';
// With local results for the chosen population (contract v1.13, §24 Layers): every row names its
// layer, and a group is compared only with the all-patients result of the same layer.
export const LAYER_WORDS = Object.freeze({ local: 'Local result', includes_local: 'Includes local results', public: 'Public result' });
export const LAYER_NOTE = 'Local results are compared with the local result for all patients, public results with the public one.';
export const NOT_COMPARED_WORDS = 'Not compared: no local result for all patients';

const AXES = Object.freeze([
  { id: 'age', label: 'Age' },
  { id: 'sex', label: 'Sex' },
  { id: 'ethnicity', label: 'Ethnicity' }
]);

const FLAG_WORDS = Object.freeze({ higher: 'Higher', lower: 'Lower' });

/**
 * The published rule in words (`/meta.subgroup_difference`), never restating
 * numbers the API did not send.
 */
export function ruleSentence(rule, depth = 'plain') {
  const delta = Number.isFinite(rule?.min_delta) ? rule.min_delta.toFixed(2) : null;
  const separation = rule?.requires_ci_separation !== false;
  if (!delta) {
    return 'A marked group differs from all patients. A prototype check, not a grade.';
  }
  if (depth === 'expert') {
    return `Marked when |group − all patients| ≥ ${delta}${separation ? ' and the confidence intervals do not overlap' : ''}. A prototype heuristic, not a grade; it changes no status.`;
  }
  return `Marked when a group differs from all patients by ${delta} or more${separation ? ' and their ranges do not overlap' : ''}. A prototype check, not a grade.`;
}

const sameLens = (a, b) => Boolean(a && b) && a.age === b.age && a.sex === b.sex && a.ethnicity === b.ethnicity;

/** Whether an entry has a performance value to show (a rollup without children has none: No data). */
function hasValue(entry) {
  return Boolean(entry?.has_result) && !isRollupWithoutChildren(entry) && Number.isFinite(entry.perf);
}

function valueText(value, depth) {
  return depth === 'expert' ? value.toFixed(3) : formatScore(value);
}

function signedDelta(delta) {
  return `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${Math.abs(delta).toFixed(3)}`;
}

const plural = (value, noun) => `${Number(value).toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`;

/**
 * "1,240 patients, 6 sites": the size of a group's result (contract v1.14, §24),
 * or null when the API sent none. A result over several conditions or groups (a
 * rollup or a lens fallback) carries their mean, so it reads "About … per condition"
 * or "About … per group". Patients means patients or cases, as the study counts them.
 */
export function groupSizeWords(entry) {
  const patients = Number.isFinite(entry?.n_samples) ? plural(entry.n_samples, 'patient') : null;
  const sites = Number.isFinite(entry?.n_sites) ? plural(entry.n_sites, 'site') : null;
  if (!patients && !sites) return null;
  const words = [patients, sites].filter(Boolean).join(', ');
  if (entry.provenance?.source === 'rollup') return `About ${words} per condition`;
  if (entry.provenance?.lens_fallback) return `About ${words} per group`;
  return words;
}

/** Whether an entry has a row at all (a rollup without children counts as none). */
function hasRow(entry) {
  return Boolean(entry?.has_result) && !isRollupWithoutChildren(entry);
}

/**
 * One row: its words, value, chart, flag, layer, and fallback note.
 *
 * @param {object} entry contract SubgroupResult
 * @param {object} context
 */
function rowModel(entry, { depth, statusBands, referencePerf, currentLens, label: labelOverride = null }) {
  const shows = hasValue(entry);
  const status = shows ? entry.status?.performance ?? 'no_data' : 'no_data';
  const hasCi = shows && Number.isFinite(entry.ci_low) && Number.isFinite(entry.ci_high);
  const chart = shows
    ? rangeModel({ view: 'performance', value: entry.perf, ciLow: hasCi ? entry.ci_low : null, ciHigh: hasCi ? entry.ci_high : null, statusBands, status })
    : null;
  // The all-patients line, on the group rows only (the reference row is all patients itself).
  const reference = chart && entry.axis !== 'all' && Number.isFinite(referencePerf) ? rangePosition(referencePerf, chart.domain) : null;
  const difference = entry.difference ?? null;
  const flag = difference?.flagged && FLAG_WORDS[difference.direction]
    ? { direction: difference.direction, word: FLAG_WORDS[difference.direction], text: `${FLAG_WORDS[difference.direction]} than all patients` }
    : null;
  const label = labelOverride ?? (entry.axis === 'all' ? 'All patients' : lensValueWords(entry.group));
  const details = [];
  // Contract v1.13 (§24 Layers): with local results every row says which layer it is.
  const layerWords = shows && entry.layer ? LAYER_WORDS[entry.layer] ?? null : null;
  if (layerWords && entry.axis !== 'all') details.push(layerWords);
  if (shows && depth === 'expert') {
    details.push(hasCi ? `CI ${entry.ci_low.toFixed(3)}–${entry.ci_high.toFixed(3)}` : 'No confidence interval');
    if (Number.isFinite(difference?.delta)) details.push(`Δ ${signedDelta(difference.delta)}`);
  } else if (shows && hasCi) {
    details.push(`Likely ${entry.ci_low.toFixed(2)}–${entry.ci_high.toFixed(2)}`);
  }
  if (shows && difference?.reason === 'layer_differs') details.push(NOT_COMPARED_WORDS);
  // Contract v1.14 (§24): how many patients and sites the group's result rests on.
  const size = shows ? groupSizeWords(entry) : null;
  if (size) details.push(size);
  const isFallback = Boolean(entry.provenance?.lens_fallback) && shows;
  return {
    key: entry.axis === 'all' ? `all${entry.layer ? `:${entry.layer}` : ''}` : `${entry.axis}:${entry.group}`,
    axis: entry.axis,
    label,
    lens: entry.lens,
    status,
    value: shows ? valueText(entry.perf, depth) : null,
    details,
    size,
    chart,
    referencePct: reference ? reference.pct : null,
    flag,
    layer: entry.layer ?? null,
    isFallback,
    isCurrent: sameLens(entry.lens, currentLens)
  };
}

/**
 * Why no group has a result, from the facts of the answer, never assumed:
 * the condition has no ICD-11 mapping; results are stored for all patients
 * only (all patients has one, no group has a row); otherwise there is no data
 * by group for this condition.
 */
export function noGroupResultSentence(answer) {
  if (answer?.mapping?.kind === 'none') {
    return 'No results by group: this condition has no ICD-11 mapping.';
  }
  if (hasValue(answer?.all_patients) && (answer.groups ?? []).every((entry) => !hasRow(entry))) {
    return 'No results by group: results are stored for all patients only.';
  }
  return 'No results by group: no data for this condition.';
}

/** "All patients", or with a second, public reference row "All patients, local result". */
function referenceLabel(entry, hasTwoReferences) {
  const words = hasTwoReferences && entry?.layer ? LAYER_WORDS[entry.layer] : null;
  return words ? `All patients, ${words.toLowerCase()}` : 'All patients';
}

/**
 * Everything the section shows for one getConceptSubgroups answer.
 *
 * With local results for the chosen population (contract v1.13, §24 Layers)
 * each group's all-patients line is the all-patients result of the layer it
 * was compared with (`difference.compared_with`); when all patients is not a
 * public result, the public all-patients result is a second reference row.
 *
 * @param {object} answer contract ConceptSubgroups
 * @param {{ depth?: 'plain'|'expert', statusBands?: object, currentLens?: object|null }} [options]
 * @returns {{ reference: object, references: object[], groups: Array<{ axis: string, label: string, rows: object[] }>, flaggedCount: number, hasAnyGroupResult: boolean, isLayered: boolean, summary: string }}
 */
export function acrossGroupsModel(answer, { depth = 'plain', statusBands, currentLens = null } = {}) {
  const perfOf = (entry) => (hasValue(entry) ? entry.perf : null);
  const isLayered = answer.all_patients?.layer !== undefined;
  const publicReference = isLayered ? answer.public_all_patients ?? null : null;
  const referencePerfFor = (entry) => {
    const comparedWith = entry.difference?.compared_with;
    if (!isLayered || comparedWith === undefined) return perfOf(answer.all_patients);
    if (comparedWith === null) return null;
    return comparedWith === 'public' && publicReference ? perfOf(publicReference) : perfOf(answer.all_patients);
  };
  const base = { depth, statusBands, currentLens, referencePerf: null };
  // The atlas shows the served (first) all-patients result; the public one is only a reference.
  const references = [answer.all_patients, ...(publicReference ? [publicReference] : [])].map((entry, index) =>
    rowModel(entry, { ...base, currentLens: index === 0 ? currentLens : null, label: referenceLabel(entry, Boolean(publicReference)) })
  );
  const rows = (answer.groups ?? []).map((entry) => rowModel(entry, { ...base, referencePerf: referencePerfFor(entry) }));
  const groups = AXES.map((axis) => ({ axis: axis.id, label: axis.label, rows: rows.filter((row) => row.axis === axis.id) })).filter(
    (group) => group.rows.length
  );
  const flaggedCount = rows.filter((row) => row.flag).length;
  const hasAnyGroupResult = rows.some((row) => row.value != null);
  let summary;
  if (!hasAnyGroupResult) {
    summary = noGroupResultSentence(answer);
  } else if (flaggedCount) {
    summary = `${flaggedCount} of ${rows.length} groups differ from all patients.`;
  } else {
    summary = `No group differs clearly from all patients.`;
  }
  return { reference: references[0], references, groups, flaggedCount, hasAnyGroupResult, isLayered, summary };
}
