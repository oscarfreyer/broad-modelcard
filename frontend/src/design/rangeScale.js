// Geometry of the Health-style range chart: a fixed domain per metric, the
// Strong / Moderate / Weak zones from the contract's status bands, the value
// dot, and the confidence-interval whisker, all as percentages of the track.
import { isAbsence } from './status.js';

/**
 * Fixed domains so charts compare across conditions; they start near the
 * data so the Weak zone does not dominate the bar. Values outside clamp to
 * an edge (drawn with a dashed dot).
 */
const RANGE_DOMAINS = Object.freeze({
  overall: [0.4, 1],
  performance: [0.5, 1],
  evidence: [0.4, 1]
});

/** Fallback when /meta is not loaded yet; mirrors CONTRACT.md §4.5. */
export const DEFAULT_STATUS_BANDS = Object.freeze({
  overall: [
    { status: 'strong', min: 0.76, max: null },
    { status: 'moderate', min: 0.64, max: 0.76 },
    { status: 'weak', min: null, max: 0.64 }
  ],
  performance: [
    { status: 'strong', min: 0.8, max: null },
    { status: 'moderate', min: 0.7, max: 0.8 },
    { status: 'weak', min: null, max: 0.7 }
  ],
  evidence: [
    { status: 'strong', min: 0.8, max: null },
    { status: 'moderate', min: 0.68, max: 0.8 },
    { status: 'weak', min: null, max: 0.68 }
  ]
});

/**
 * What a range chart plots for a decoded metric map row (CONTRACT.md §10,
 * v1.1): the overall score or the performance value, read by column name.
 * The map's CI bounds belong to performance, so only that view draws a
 * whisker. Evidence and intended use have no value in the map.
 *
 * @returns {{ value: number|null, ciLow: number|null, ciHigh: number|null }}
 */
export function mapRangeValues(row, viewId) {
  const finite = (value) => (Number.isFinite(value) ? value : null);
  if (!row) {
    return { value: null, ciLow: null, ciHigh: null };
  }
  if (viewId === 'overall') {
    return { value: finite(row.overall_score), ciLow: null, ciHigh: null };
  }
  if (viewId === 'performance') {
    const value = finite(row.perf);
    const hasCi = value != null && finite(row.ci_low) != null && finite(row.ci_high) != null;
    return { value, ciLow: hasCi ? row.ci_low : null, ciHigh: hasCi ? row.ci_high : null };
  }
  return { value: null, ciLow: null, ciHigh: null };
}

const toPct = (value, [low, high]) => ((value - low) / (high - low)) * 100;

/** Position of a value on a domain, clamped to the track. */
export function rangePosition(value, domain) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const [low, high] = domain;
  if (value < low) {
    return { pct: 0, clamped: 'low' };
  }
  if (value > high) {
    return { pct: 100, clamped: 'high' };
  }
  return { pct: toPct(value, domain), clamped: null };
}

/** Zones in track order (low to high), clipped to the domain. */
export function rangeZones(bands, domain) {
  const [low, high] = domain;
  return (bands || [])
    .map((band) => {
      const from = Math.max(low, band.min ?? low);
      const to = Math.min(high, band.max ?? high);
      return { status: band.status, from, to, startPct: toPct(from, domain), endPct: toPct(to, domain) };
    })
    .filter((zone) => zone.to > zone.from)
    .sort((a, b) => a.from - b.from);
}

/**
 * Everything a range chart draws for one metric.
 *
 * @param {object} input
 * @param {'overall'|'performance'|'evidence'} input.view
 * @param {number|null} input.value
 * @param {number|null} [input.ciLow]
 * @param {number|null} [input.ciHigh]
 * @param {object} [input.statusBands] contract Meta.status_bands
 * @param {string|null} [input.status] the row's contract status; decides the highlighted zone
 */
export function rangeModel({ view, value, ciLow = null, ciHigh = null, statusBands = DEFAULT_STATUS_BANDS, status = null }) {
  const domain = RANGE_DOMAINS[view];
  if (!domain) {
    throw new Error(`No range domain for view ${view}`);
  }
  // The contract status is authoritative (it comes from the grade); the value
  // only decides the zone when no status is given.
  const clampedValue = Number.isFinite(value) ? Math.min(domain[1], Math.max(domain[0], value)) : null;
  const zones = rangeZones(statusBands?.[view] ?? DEFAULT_STATUS_BANDS[view], domain).map((zone) => ({
    ...zone,
    isActive: status
      ? zone.status === status
      : clampedValue != null && clampedValue >= zone.from && (clampedValue < zone.to || zone.to === domain[1])
  }));
  const hasCi = Number.isFinite(ciLow) && Number.isFinite(ciHigh) && ciHigh >= ciLow;
  const ci = hasCi
    ? { startPct: rangePosition(ciLow, domain).pct, endPct: rangePosition(ciHigh, domain).pct, low: ciLow, high: ciHigh }
    : null;
  const ticks = zones.slice(1).map((zone) => ({ value: zone.from, pct: zone.startPct, label: zone.from.toFixed(2) }));
  return { domain, zones, value: rangePosition(value, domain), ci, ticks, status };
}

const SCOPE_LEVELS = Object.freeze(['out_of_scope', 'partially_in_scope', 'in_scope']);

/**
 * The absence state a range chart draws instead of its track, or null when
 * it draws a track: a scored chart without a value whose status is an
 * absence (Out of scope, No data), or a scope chart without an
 * intended-use level (No data).
 *
 * @param {ReturnType<typeof rangeModel>|{ kind: 'scope', level: string|null }} model
 * @returns {string|null}
 */
export function rangeAbsence(model) {
  if (model.kind === 'scope') {
    return SCOPE_LEVELS.includes(model.level) ? null : isAbsence(model.level) ? model.level : 'no_data';
  }
  return !model.value && isAbsence(model.status) ? model.status : null;
}

/**
 * A score at two decimals, rounded down, so the figure never crosses a band
 * edge its status does not: bands start at their threshold (Strong ≥ 0.76),
 * and rounding 0.757 up to "0.76" beside "Moderate" read as a contradiction
 * (S8 critique). Expert depth shows three decimals instead.
 */
export function formatScore(value) {
  return (Math.floor(value * 100 + 1e-9) / 100).toFixed(2);
}
