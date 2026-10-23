// What the comparison table shows from one getComparison answer
// (CONTRACT.md §25): the rows after the filter and the sort, grouped by
// subchapter at chapter level, the counts for the filter, and the atlas link
// of each cell. Framework-free, so the node tests can check it.
import { atlasHref } from '../../app/startupParams.js';
import { displayUseCase } from '../../shared/format.js';
import { rowOnlyReasons } from './compareCopy.js';
import { SHOW, SORTS, splitCardId } from './compareState.js';

/**
 * Whether a row is flagged on its own: a reason beyond those that hold on
 * every row (the card-level reasons, said once above the table). Filtering
 * by `comparable` would flag every row as soon as two functions differ.
 */
export function isRowFlagged(row, cardReasons = []) {
  return rowOnlyReasons(row, cardReasons).length > 0;
}

/** Whether a row passes the filter. */
export function passes(row, show, cardReasons = []) {
  if (show === SHOW.comparable) return !isRowFlagged(row, cardReasons);
  if (show === SHOW.flagged) return isRowFlagged(row, cardReasons);
  return true;
}

/** How many rows the comparison holds per filter, for the segment labels. */
export function showCounts(rows, cardReasons = []) {
  const flagged = rows.filter((row) => isRowFlagged(row, cardReasons)).length;
  return { all: rows.length, comparable: rows.length - flagged, flagged };
}

/**
 * The row filter's options with their counts. When a card-level reason holds
 * ("Not directly comparable on every row"), no row is plainly comparable, so
 * the counts are named as what they are: rows with or without a reason of
 * their own ("No row flag", "Row flag").
 *
 * @param {{ all: number, comparable: number, flagged: number }} counts showCounts()
 * @param {object[]} [cardReasons] the answer's card_reasons
 */
export function showOptions(counts, cardReasons = []) {
  const cardLevel = (cardReasons ?? []).length > 0;
  return [
    { value: SHOW.all, label: `All ${counts.all}` },
    { value: SHOW.comparable, label: `${cardLevel ? 'No row flag' : 'Not flagged'} ${counts.comparable}` },
    { value: SHOW.flagged, label: `${cardLevel ? 'Row flag' : 'Flagged'} ${counts.flagged}` }
  ];
}

/** Largest difference first; rows without one (fewer than two results) last, in atlas order. */
export function byDifference(rows) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const x = a.row.perf_spread;
      const y = b.row.perf_spread;
      if (x == null && y == null) return a.index - b.index;
      if (x == null) return 1;
      if (y == null) return -1;
      return y - x || a.index - b.index;
    })
    .map(({ row }) => row);
}

/**
 * The table's body: a list of entries `{ row, depth }` in display order.
 *
 * - Atlas level: one row per chapter.
 * - Chapter level in atlas order: each subchapter, then its conditions
 *   (depth 1); a subchapter stays as the group's heading when any of its
 *   conditions passes the filter, marked `isContext` when it does not pass
 *   itself.
 * - Sorted by largest difference: one flat list of every row that passes.
 *
 * @param {object[]} rows getComparison rows
 * @param {{ show: string, sort: string, scope: 'atlas'|'chapter', cardReasons?: object[] }} options
 * @returns {{ row: object, depth: number, isContext?: boolean }[]}
 */
export function tableEntries(rows, { show = SHOW.all, sort = SORTS.atlas, scope = 'atlas', cardReasons = [] } = {}) {
  const keep = (row) => passes(row, show, cardReasons);
  if (sort === SORTS.difference) {
    return byDifference(rows.filter(keep)).map((row) => ({ row, depth: 0 }));
  }
  if (scope !== 'chapter') {
    return rows.filter(keep).map((row) => ({ row, depth: 0 }));
  }
  const entries = [];
  let block = null;
  let children = [];
  const flush = () => {
    if (!block) return;
    const own = keep(block);
    if (own || children.length) {
      entries.push({ row: block, depth: 0, isContext: !own });
      children.forEach((child) => entries.push({ row: child, depth: 1 }));
    }
  };
  for (const row of rows) {
    if (row.level === 1) {
      flush();
      block = row;
      children = [];
    } else if (keep(row)) {
      children.push(row);
    }
  }
  flush();
  return entries;
}

/** The short name of each card, for the reasons: the AI system and, when two cards share it, the function. */
export function cardNames(cards) {
  const systems = new Map();
  cards.forEach((card) => systems.set(card.display_name, (systems.get(card.display_name) ?? 0) + 1));
  return new Map(
    cards.map((card) => [card.card_id, systems.get(card.display_name) > 1 ? `${card.display_name} (${displayUseCase(card.use_case)})` : card.display_name])
  );
}

/**
 * The card's atlas at a row's concept, with the lens, population, and
 * classification of the comparison: a chapter row opens the chapter, a
 * subchapter or condition opens its chapter with it selected.
 */
export function cellAtlasHref(cardId, row, context) {
  return cardAtlasHref(cardId, { ...context, chapterId: row.level === 0 ? row.concept_id : context.chapterId ?? null }, row.concept_id);
}

/**
 * The card's atlas with the comparison's lens, population, classification,
 * depth, and view, at the open chapter (if any) or at a concept in it.
 */
export function cardAtlasHref(cardId, { lens, setting = null, population = null, ontology = null, chapterId = null, depth = null, view = null }, conceptId = null) {
  const { modelVersion, useCase } = splitCardId(cardId);
  return atlasHref({
    model: modelVersion,
    useCase,
    // The view the reader came from (the table shows the Overview mark); Overview by default.
    view: view ?? 'overall',
    lens,
    setting,
    population,
    ontology,
    depth: depth === 'expert' ? depth : null,
    chapterId,
    conceptId
  });
}

/**
 * The code beside a row's name: a condition's code, or a subchapter's range in
 * another classification (ICD-10-CM's E08-E13). ICD-11 subchapters carry
 * linearization ids (BlockL1-5A0) that mean nothing to a reader, and chapters
 * carry none (audit A29), so neither shows one.
 */
export function shownCode(row) {
  if (!row.code || row.level === 0) return null;
  return row.level === 1 && /^BlockL/.test(row.code) ? null : row.code;
}

/** The value a cell shows: performance with three decimals, or null. */
export function cellValue(cell) {
  return Number.isFinite(cell?.perf) ? cell.perf.toFixed(3) : null;
}

/** The status key a cell's mark draws: No mapping for an unmapped row, else the Overview status. */
export function cellMark(row, cell) {
  return row.mapping === 'none' ? 'no_mapping' : cell.status;
}

/** Whether a reason of the row concerns the card. */
export function concerns(reasons, cardId) {
  return reasons.some((reason) => reason.cards.includes(cardId));
}

/**
 * Whether a cell is outlined: a reason singles the card out (it concerns
 * this card but not every card; a reason about every card, such as No
 * mapping, singles none out).
 */
export function singledOut(reasons, cardId, cardCount) {
  return reasons.some((reason) => reason.cards.length < cardCount && reason.cards.includes(cardId));
}
