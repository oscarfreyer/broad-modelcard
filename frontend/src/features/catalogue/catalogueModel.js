// What the catalogue shows, derived in the browser from the one catalogue
// response (CONTRACT.md §17): tabs, filter options, the filter and sort
// combination, and the per-tile facts. Pure functions, so every tab switch,
// filter, and sort is instant and testable.
import { STATUS_ORDER, safetyKey } from '../../design/status.js';
import { aiTypeLabel, functionCategoryLabel, kindLabel, systemKind, systemName } from '../../shared/aiSystem.js';
import { displayUseCase } from '../../shared/format.js';
import { FILTER_KEYS, SORTS, TABS } from './catalogueState.js';

export const TAB_LABELS = Object.freeze({
  [TABS.performance]: 'Performance',
  [TABS.safety]: 'Safety',
  [TABS.mine]: 'My systems'
});

export const SORT_LABELS = Object.freeze({
  [SORTS.name]: 'Name',
  [SORTS.release]: 'Newest release',
  [SORTS.updated]: 'Last update',
  [SORTS.incidents]: 'Most open incidents'
});

export const FILTER_LABELS = Object.freeze({
  system: 'AI system',
  functionName: 'Function',
  category: 'Function category',
  kind: 'Model or Product',
  aiType: 'AI type',
  developer: 'Developer',
  // The stage of the AI system in the registry, not a result status.
  status: 'Stage'
});

export const REGISTRY_STATUS_LABELS = Object.freeze({ ACTIVE: 'Active', EXPERIMENTAL: 'Experimental' });

/**
 * The safety counts of a tile (contract v1.7, CONTRACT.md §17): `serious`
 * and `caution` count the open incidents by derived severity (so serious +
 * caution = open), and `open`, `mitigated`, `closed` count every incident of
 * the card by status, over every lens. Null when the catalogue carries no
 * safety data (a response from before v1.7).
 *
 * @returns {{ serious: number, caution: number, open: number, mitigated: number, closed: number }|null}
 */
export function openIncidents(tile) {
  const safety = tile?.safety;
  if (!safety || typeof safety !== 'object') {
    return null;
  }
  const count = (name) => (Number.isFinite(safety[name]) ? safety[name] : 0);
  const serious = count('serious');
  const caution = count('caution');
  return { serious, caution, open: serious + caution, mitigated: count('mitigated'), closed: count('closed') };
}

/** Why a Caution mark can show on the ring with no incident open (CONTRACT.md §18: mitigated incidents mark Caution). */
export function mitigatedNote(count) {
  return `${count} mitigated ${count === 1 ? 'incident is' : 'incidents are'} marked Caution on the ring.`;
}

/**
 * What a tile shows on the Safety tab: the open incidents as Serious and
 * Caution rows (non-zero only, Serious first), each saying it is open, then
 * how many subchapters of the snapshot carry a mark (one incident can apply
 * to many conditions, so it can mark many bubbles), and the mitigated and
 * closed ones as quiet words. Mitigated incidents are not open but still mark
 * Caution on the ring; the tile says so in the model card's words. Without
 * open incidents, the neutral mark with "No reported incidents" (no incident
 * at all) or "No open incidents". Never green, never "safe".
 *
 * @returns {{ rows: { status: 'serious'|'caution', count: number }[], quiet: string|null, span: string|null, settled: string|null, mitigated: string|null }}
 */
export function safetyLead(tile) {
  const incidents = openIncidents(tile) ?? { serious: 0, caution: 0, open: 0, mitigated: 0, closed: 0 };
  const settledParts = [
    incidents.mitigated ? `${incidents.mitigated} mitigated` : null,
    incidents.closed ? `${incidents.closed} closed` : null
  ].filter(Boolean);
  const rows = [
    { status: 'serious', count: incidents.serious },
    { status: 'caution', count: incidents.caution }
  ].filter((row) => row.count > 0);
  const total = incidents.open + incidents.mitigated + incidents.closed;
  const marked = markedSubchapters(tile);
  return {
    rows,
    quiet: rows.length ? null : total ? 'No open incidents' : 'No reported incidents',
    // Where the marks are: one incident can apply to many conditions.
    span: marked ? `across ${marked.toLocaleString('en-US')} ${marked === 1 ? 'subchapter' : 'subchapters'}` : null,
    // Mitigated and closed incidents, quietly after the open ones.
    settled: settledParts.length ? settledParts.join(', ') : null,
    mitigated: incidents.mitigated ? mitigatedNote(incidents.mitigated) : null
  };
}

/** How many subchapters of a tile's snapshot carry a Serious or Caution mark (0 without a snapshot). */
export function markedSubchapters(tile) {
  const blocks = tile?.snapshot?.blocks;
  if (!Array.isArray(blocks)) return 0;
  return blocks.filter((block) => MARKED.has(safetyKey(block?.safety ?? null))).length;
}

const MARKED = new Set(['serious', 'caution']);

/** True once tiles carry safety counts: the Safety tab and sort appear then. */
export function hasSafetyData(tiles = []) {
  return tiles.some((tile) => openIncidents(tile) !== null);
}

export function availableTabs(tiles) {
  return hasSafetyData(tiles) ? [TABS.performance, TABS.safety, TABS.mine] : [TABS.performance, TABS.mine];
}

export function availableSorts(tiles) {
  const sorts = [SORTS.name, SORTS.release, SORTS.updated];
  return hasSafetyData(tiles) ? [...sorts, SORTS.incidents] : sorts;
}

/** The value a tile has for each filter (what the filter compares). */
export function tileFilterValues(tile) {
  return {
    system: tile.model_version,
    functionName: tile.use_case,
    category: tile.function_category ?? null,
    kind: systemKind(tile.system),
    aiType: tile.system?.ai_type ?? null,
    developer: tile.system?.developer ?? null,
    status: tile.system?.status ?? null
  };
}

function optionLabel(key, value, tile) {
  switch (key) {
    case 'system':
      return systemName({ ...tile.system, model_version: tile.model_version });
    case 'functionName':
      return displayUseCase(value);
    case 'kind':
      return kindLabel(tile.system);
    case 'category':
      return functionCategoryLabel(value);
    case 'aiType':
      return aiTypeLabel(value);
    case 'status':
      return REGISTRY_STATUS_LABELS[value] ?? value;
    default:
      return value;
  }
}

/**
 * The choices of each filter: every value present in the catalogue, sorted
 * by label, with how many cards carry it. With `filters`, the counts are
 * faceted: a choice counts the cards it would show together with the other
 * filters that are set, so a combination that matches nothing reads (0).
 *
 * @param {object[]} tiles
 * @param {Record<string, string|null>} [filters]
 * @returns {Record<string, { value: string, label: string, count: number }[]>}
 */
export function filterOptions(tiles = [], filters = null) {
  const options = Object.fromEntries(FILTER_KEYS.map((key) => [key, new Map()]));
  for (const tile of tiles) {
    const values = tileFilterValues(tile);
    for (const key of FILTER_KEYS) {
      const value = values[key];
      if (value == null || value === '') continue;
      const entry = options[key].get(value) ?? { value, label: optionLabel(key, value, tile), count: 0 };
      if (!filters || matchesFilters(tile, { ...filters, [key]: null })) entry.count += 1;
      options[key].set(value, entry);
    }
  }
  return Object.fromEntries(
    FILTER_KEYS.map((key) => [key, [...options[key].values()].sort((a, b) => a.label.localeCompare(b.label, 'en'))])
  );
}

/**
 * The text search: every word of the query must appear in the card's AI
 * system name, model version, function, or developer (case and accents
 * ignored). An empty query matches every card.
 *
 * @param {object} tile
 * @param {string} query
 */
export function matchesQuery(tile, query) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = normalize(
    [
      systemName({ ...tile.system, model_version: tile.model_version }),
      tile.model_version,
      displayUseCase(tile.use_case),
      tile.use_case,
      tile.system?.developer ?? ''
    ].join(' ')
  );
  return words.every((word) => haystack.includes(word));
}

function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Every set filter must match (they combine with AND). */
export function matchesFilters(tile, filters) {
  const values = tileFilterValues(tile);
  return FILTER_KEYS.every((key) => !filters?.[key] || values[key] === filters[key]);
}

const byName = (a, b) =>
  systemName({ ...a.system, model_version: a.model_version }).localeCompare(systemName({ ...b.system, model_version: b.model_version }), 'en') ||
  displayUseCase(a.use_case).localeCompare(displayUseCase(b.use_case), 'en');

const newestFirst = (a, b) => (a && b ? (a < b ? 1 : a > b ? -1 : 0) : a ? -1 : b ? 1 : 0);

const COMPARE = {
  [SORTS.name]: byName,
  [SORTS.release]: (a, b) => newestFirst(a.system?.release_date ?? null, b.system?.release_date ?? null) || byName(a, b),
  [SORTS.updated]: (a, b) =>
    (b.last_updated?.version ?? 0) - (a.last_updated?.version ?? 0) ||
    newestFirst(a.last_updated?.at ?? null, b.last_updated?.at ?? null) ||
    byName(a, b),
  [SORTS.incidents]: (a, b) => {
    const left = openIncidents(a) ?? { serious: 0, open: 0 };
    const right = openIncidents(b) ?? { serious: 0, open: 0 };
    return right.serious - left.serious || right.open - left.open || byName(a, b);
  }
};

/** A sorted copy. Missing release dates sort last; ties fall back to the name. */
export function sortTiles(tiles, sort) {
  return [...tiles].sort(COMPARE[sort] ?? COMPARE[SORTS.name]);
}

/**
 * True when another AI system of the registry replaces this tile's AI system
 * (contract v1.14, CONTRACT.md §28.2): "Newest versions only" hides it.
 */
export function isReplaced(tile) {
  return Array.isArray(tile?.system?.replaced_by) && tile.system.replaced_by.length > 0;
}

/** True once some AI system of the catalogue replaces another: the "Newest versions only" choice appears then. */
export function hasLineage(tiles = []) {
  return tiles.some(isReplaced);
}

/**
 * The name of the AI system a tile's system replaces ("Replaces X"), from the
 * other tiles, or its model version; null when it replaces none.
 *
 * @param {object} tile
 * @param {Map<string, string>} names model version → AI system name (systemNames)
 */
export function replacesName(tile, names) {
  const version = tile?.system?.replaces;
  return version ? names.get(version) ?? version : null;
}

/** model version → the AI system's name, for every tile. */
export function systemNames(tiles = []) {
  return new Map(tiles.map((tile) => [tile.model_version, systemName({ ...tile.system, model_version: tile.model_version })]));
}

/**
 * The tiles a view shows: the tab (My systems keeps tracked cards only), then
 * the filters (and "Newest versions only"), then the sort.
 *
 * @param {object[]} tiles
 * @param {{ tab: string, filters: object, sort: string, query?: string, tracked?: Iterable<string>, newest?: boolean }} view
 */
export function visibleTiles(tiles = [], { tab, filters, sort, query = '', tracked = [], newest = false }) {
  return sortTiles(
    tabTiles(tiles, { tab, tracked, newest }).filter((tile) => matchesQuery(tile, query) && matchesFilters(tile, filters)),
    sort
  );
}

/**
 * The tiles of a tab before the filters: every tile, or the tracked ones on My
 * systems, without replaced versions when "Newest versions only" is on (the
 * facet counts start from these).
 */
export function tabTiles(tiles = [], { tab, tracked = [], newest = false }) {
  const trackedIds = tracked instanceof Set ? tracked : new Set(tracked);
  const inTab = tab === TABS.mine ? tiles.filter((tile) => trackedIds.has(tile.card_id)) : tiles;
  return newest ? inTab.filter((tile) => !isReplaced(tile)) : inTab;
}

/** How many cards each AI system has (for "Other functions of this system"). */
export function functionsPerSystem(tiles = []) {
  const counts = new Map();
  for (const tile of tiles) {
    counts.set(tile.model_version, (counts.get(tile.model_version) ?? 0) + 1);
  }
  return counts;
}

/** The overall distribution as [status, count] in display order, zero counts left out. */
export function distributionParts(counts = {}) {
  return STATUS_ORDER.filter((key) => (counts[key] ?? 0) > 0).map((key) => [key, counts[key]]);
}

/** Said where scope would be counted, on a card without an intended-use statement. */
export const NO_STATEMENT_NOTE = 'No intended-use statement';

/**
 * The Overview counts of a tile as [status, count] in display order, zero
 * counts left out. A card without an intended-use statement has no scope, so
 * Out of scope never shows for it; the API serves 0 there.
 *
 * @param {Record<string, number>} [counts] tile.distribution.overall
 * @param {{ hasIntendedUse?: boolean }} [options]
 */
export function overviewParts(counts = {}, { hasIntendedUse = true } = {}) {
  return distributionParts(counts ?? {}).filter(([status]) => hasIntendedUse || status !== 'out_of_scope');
}

const UPDATED = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const UPDATED_LONG = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "12 Oct 2026" (or "12 October 2026" with long) for an ISO date-time; null when it does not parse. */
export function formatUpdated(iso, { long = false } = {}) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : (long ? UPDATED_LONG : UPDATED).format(date);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (date) => Math.floor(date.getTime() / DAY_MS);

/**
 * "Updated today", "Updated yesterday", "Updated 3 days ago" for the last
 * four weeks, else "Updated 12 Oct 2026"; null when the date does not parse.
 * Days are counted in UTC, as formatUpdated prints them.
 *
 * @param {string|null} iso
 * @param {Date} [now]
 */
export function relativeUpdated(iso, now = new Date()) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const days = utcDay(now) - utcDay(date);
  if (days <= 0) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  if (days < 28) return `Updated ${days} days ago`;
  return `Updated ${formatUpdated(iso)}`;
}

/**
 * True when every tile was last updated on the same day: a date on each tile
 * would repeat one fact, so the tiles leave it out and the footer says it.
 */
export function sameUpdateDay(tiles = []) {
  const days = new Set(tiles.map((tile) => tile.last_updated?.at?.slice(0, 10) ?? null));
  return tiles.length > 1 && days.size === 1 && !days.has(null);
}
