// The comparison of 2 to 4 cards for the static build (release 0.4; CONTRACT.md §25): a port of backend/app/services/comparison.py over
// recorded inputs, because the card sets a reader can choose (2 to 4 of every
// card, in any order, at every lens, scope, and classification) are far too
// many to record. What the backend computes per card is recorded once per
// card, lens, and classification (`cards/<card>/<lens>/compare.json`: the card
// facts and every cell at every scope); what is the same for every card is
// recorded once per classification (`compare/rows.json`: the rows' concepts
// and mappings). This module only puts them side by side and applies the
// published rule (the reasons, `comparable`, and `perf_spread`); it computes
// no grade and no status.
//
// scripts/static/record.mjs compares this port with the API for a sample of
// card sets at every recording (as the static search is checked), so a drift
// from §25 fails the recording.

export const MIN_CARDS = 2;
export const MAX_CARDS = 4;

/** A ComparisonCell as one array, values in this order. */
export const CELL_FIELDS = Object.freeze([
  'status',
  'performance_status',
  'evidence_status',
  'perf',
  'ci_low',
  'ci_high',
  'evidence_grade',
  'validation_type',
  'study_design',
  'design_group',
  'lens_fallback',
  'safety',
  // Contract v1.14 (Q4): sent only where they apply, so an absent one is recorded as null and left out again.
  'layer',
  'setting_category'
]);
/** The cell fields the API leaves out instead of sending null (contract v1.14, CONTRACT.md §25). */
const OPTIONAL_CELL_FIELDS = new Set(['layer', 'setting_category']);
/** The fields of a ComparisonRow that are the same for every card. */
export const ROW_FIELDS = Object.freeze(['concept_id', 'code', 'pt', 'level', 'parent_id', 'chapter_no', 'mapping']);

const RESULT_STATUSES = new Set(['strong', 'moderate', 'weak']);
// A study setting category that names no one setting (§22): it never makes settings differ.
const MIXED_SETTING = 'mixed';
const BROADER_MAPPINGS = new Set(['block', 'parent']);
const ALL_LENS = Object.freeze({ age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' });

export const encodeCell = (cell) => CELL_FIELDS.map((field) => cell[field]);
export const decodeCell = (values) =>
  Object.fromEntries(
    CELL_FIELDS.map((field, index) => [field, values[index]]).filter(
      ([field, value]) => !OPTIONAL_CELL_FIELDS.has(field) || (value !== null && value !== undefined)
    )
  );
export const rowSkeleton = (row) => Object.fromEntries(ROW_FIELDS.map((field) => [field, row[field]]));

/** The key of a scope in the recorded files: "atlas", or the chapter id. */
export const scopeKey = (scope, chapterId) => (scope === 'chapter' ? chapterId : 'atlas');

/**
 * Card ids as the API accepts them (`<model_version>|<use_case>`, 2 to 4,
 * distinct): `{ pairs }`, or `{ error }` with the API's words (422 invalid_cards).
 */
export function parseCardIds(cards) {
  const text = Array.isArray(cards) ? cards.join(',') : String(cards ?? '');
  const ids = text ? text.split(',').map((id) => id.trim()) : [];
  if (ids.length < MIN_CARDS || ids.length > MAX_CARDS) {
    return { error: `Compare ${MIN_CARDS} to ${MAX_CARDS} cards; got ${ids.length}.` };
  }
  const pairs = [];
  for (const id of ids) {
    const at = id.indexOf('|');
    const model = at < 0 ? '' : id.slice(0, at);
    const useCase = at < 0 ? '' : id.slice(at + 1);
    if (!model || !useCase || useCase.includes('|') || id.length > 300) {
      return { error: `Invalid card id '${id}'; expected <model_version>|<use_case>.` };
    }
    pairs.push({ cardId: id, model, useCase });
  }
  if (new Set(ids).size !== ids.length) {
    return { error: 'A card is named twice; name each card once.' };
  }
  return { pairs };
}

/** The most common value, the first of equally common ones (the card order decides ties). */
export function referenceGroup(values) {
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  const best = Math.max(...counts.values());
  return values.find((value) => counts.get(value) === best);
}

const reason = (code, cards) => ({ code, cards: cards.map((card) => card.card_id) });
const isAllPatients = (lens) => Object.keys(ALL_LENS).every((axis) => (lens?.[axis] ?? ALL_LENS[axis]) === ALL_LENS[axis]);

/** The reasons that hold on every row (CONTRACT.md §25), from the card facts. */
export function cardReasons(cards, lens) {
  const reasons = [];
  const categories = cards.map((card) => card.function_category);
  const stated = categories.filter(Boolean);
  if (new Set(stated).size > 1) {
    const reference = referenceGroup(stated);
    reasons.push(reason('function_category_differs', cards.filter((_, index) => categories[index] && categories[index] !== reference)));
  }
  if (stated.length < categories.length) {
    reasons.push(reason('function_category_unknown', cards.filter((_, index) => !categories[index])));
  }
  if (!isAllPatients(lens)) {
    const lacking = cards.filter((card) => card.lenses.requested === 'none');
    if (lacking.length && lacking.length < cards.length) {
      reasons.push(reason('population_differs', lacking));
    }
  }
  return [...reasons, ...measureReasons(cards)];
}

/** A performance measure as the rule compares it: case and spacing do not count. */
const sameMeasure = (value) => value.split(/\s+/).filter(Boolean).join(' ').toLowerCase();

/**
 * `measure_differs` and `measure_unknown` (contract v1.14, CONTRACT.md §25):
 * only when at least one card states its performance measure.
 */
export function measureReasons(cards) {
  const keys = cards.map((card) => (card.performance_measure ? sameMeasure(card.performance_measure) : null));
  const stated = keys.filter(Boolean);
  if (!stated.length) {
    return [];
  }
  const reasons = [];
  if (new Set(stated).size > 1) {
    const reference = referenceGroup(stated);
    reasons.push(reason('measure_differs', cards.filter((_, index) => keys[index] && keys[index] !== reference)));
  }
  if (stated.length < keys.length) {
    reasons.push(reason('measure_unknown', cards.filter((_, index) => !keys[index])));
  }
  return reasons;
}

/**
 * `setting_differs` (contract v1.14, CONTRACT.md §25): the linked studies of the
 * cards with a result name at least two setting categories (`mixed` and none do not count).
 */
export function settingReasons(cards, cells) {
  const settled = cards
    .map((card, index) => [card, cells[index]])
    .filter(([, cell]) => RESULT_STATUSES.has(cell.status) && cell.setting_category && cell.setting_category !== MIXED_SETTING);
  if (new Set(settled.map(([, cell]) => cell.setting_category)).size < 2) {
    return [];
  }
  const reference = referenceGroup(settled.map(([, cell]) => cell.setting_category));
  return [reason('setting_differs', settled.filter(([, cell]) => cell.setting_category !== reference).map(([card]) => card))];
}

/** The row-level reasons (CONTRACT.md §25), in their published order. */
export function rowReasons(cards, cells, mapping, level) {
  if (mapping === 'none') {
    return [reason('no_mapping', cards)];
  }
  const reasons = [];
  if (level === 2 && BROADER_MAPPINGS.has(mapping)) {
    reasons.push(reason('mapped_broader', cards));
  }
  const withResult = cards.map((card, index) => [card, cells[index]]).filter(([, cell]) => RESULT_STATUSES.has(cell.status));
  const noResult = cards.filter((_, index) => cells[index].status === 'no_data');
  const outOfScope = cards.filter((_, index) => cells[index].status === 'out_of_scope');
  if (noResult.length) reasons.push(reason('no_result', noResult));
  if (outOfScope.length) reasons.push(reason('out_of_scope', outOfScope));
  const fellBack = withResult.filter(([, cell]) => cell.lens_fallback).map(([card]) => card);
  if (fellBack.length && fellBack.length < withResult.length) {
    reasons.push(reason('lens_fallback', fellBack));
  }
  const grouped = withResult.filter(([, cell]) => cell.design_group !== null && cell.design_group !== undefined);
  if (new Set(grouped.map(([, cell]) => cell.design_group)).size > 1) {
    const reference = referenceGroup(grouped.map(([, cell]) => cell.design_group));
    reasons.push(reason('design_differs', grouped.filter(([, cell]) => cell.design_group !== reference).map(([card]) => card)));
  }
  return [...reasons, ...settingReasons(cards, cells)];
}

/** The largest difference in performance between cards with a result (3 decimals), or null for fewer than two. */
export function perfSpread(cells) {
  const values = cells.filter((cell) => RESULT_STATUSES.has(cell.status) && cell.perf !== null && cell.perf !== undefined).map((cell) => cell.perf);
  if (values.length < 2) {
    return null;
  }
  return Number((Math.max(...values) - Math.min(...values)).toFixed(3));
}

/**
 * The Comparison answer (openapi.json `Comparison`).
 *
 * @param {object} options
 * @param {object} options.rows the classification's compare/rows.json
 * @param {object[]} options.cards each card's compare.json at the lens, in request order
 * @param {'atlas'|'chapter'} options.scope
 * @param {string|null} [options.chapterId]
 * @param {{ age: string, sex: string, ethnicity: string }} options.lens
 * @returns {object|null} null when the rows file does not hold the chapter
 */
export function comparisonAnswer({ rows: rowsFile, cards: cardFiles, scope, chapterId = null, lens }) {
  const key = scopeKey(scope, chapterId);
  const scopeRows = scope === 'chapter' ? rowsFile.chapters?.[chapterId] : { chapter_pt: null, rows: rowsFile.atlas };
  if (!scopeRows) {
    return null;
  }
  const fullLens = { ...ALL_LENS, ...Object.fromEntries(Object.keys(ALL_LENS).map((axis) => [axis, lens?.[axis] || ALL_LENS[axis]])) };
  const cards = cardFiles.map((file) => file.card);
  const shared = cardReasons(cards, fullLens);
  const columns = cardFiles.map((file) => file.cells[key]);
  const rows = scopeRows.rows.map((skeleton, position) => {
    const cells = columns.map((column) => decodeCell(column[position]));
    const reasons = [...shared, ...rowReasons(cards, cells, skeleton.mapping, skeleton.level)];
    return { ...skeleton, cells, comparable: reasons.length === 0, reasons, perf_spread: perfSpread(cells) };
  });
  return {
    dataset_version: rowsFile.dataset_version,
    filters: { context: rowsFile.context, lens: fullLens, scope, chapter_id: scope === 'chapter' ? chapterId : null, chapter_pt: scopeRows.chapter_pt },
    cards,
    card_reasons: shared,
    rows,
    ...(rowsFile.ontology ? { ontology: rowsFile.ontology } : {})
  };
}
