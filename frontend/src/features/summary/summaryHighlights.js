// Plain-language Summary highlights derived from status counts (contract
// MetricSummary at atlas level, map rows inside a chapter). Each highlight
// names a region the reader can open on the ring. The sentences describe the
// synthetic data; they make no clinical claims.
import { ALERT_ORDER, DISPLAY, INTENDED_USE_ORDER, SAFETY_ORDER, isAbsence, isSafetyView, keysForView, mapRowStatus, normalizeCounts } from '../../design/status.js';

/**
 * A group is compared ("weakest", "strongest") only from this size: at least
 * 20 conditions, or 2% of those in view (audit A17: "75% of its 8
 * conditions" led the Summary). Smaller groups are compared only when no
 * group is large enough.
 */
export function defaultMinGroupSize(total) {
  return Math.max(20, Math.ceil(total * 0.02));
}
/** "Strongest" is said only from this share of strong conditions (not "3% strong"). */
const MIN_STRONGEST_SHARE = 0.25;
/** "Weakest" is said only from this share of weak conditions. */
const MIN_WEAKEST_SHARE = 0.1;
/** A card with an intended-use statement that is out of scope for at least this share leads with what is in scope (audit A18). */
const NARROW_SHARE = 0.5;

const formatCount = (value) => Number(value || 0).toLocaleString('en-US');
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const plural = (count, one, many) => (count === 1 ? one : many);

/** Top groups by a count, largest first, ties by label. */
function topGroups(groups, key, limit) {
  return groups
    .filter((group) => (group.counts[key] ?? 0) > 0)
    .sort((a, b) => b.counts[key] - a.counts[key] || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** The group with the highest share of `key`, among groups large enough to compare. */
function highestShare(groups, key, minGroupSize) {
  const eligible = groups.filter((group) => group.total >= minGroupSize && (group.counts[key] ?? 0) > 0);
  const candidates = eligible.length ? eligible : groups.filter((group) => (group.counts[key] ?? 0) > 0);
  return candidates.sort(
    (a, b) =>
      b.counts[key] / b.total - a.counts[key] / a.total || b.counts[key] - a.counts[key] || a.label.localeCompare(b.label)
  )[0] ?? null;
}

function concentration(key, count, groups, unit, area = { one: 'chapter', many: 'chapters' }, title = null) {
  const holding = groups.filter((group) => (group.counts[key] ?? 0) > 0);
  const [first, second] = topGroups(groups, key, 2);
  if (!first) {
    return null;
  }
  const named = (group) => `${group.label} (${formatCount(group.counts[key])})`;
  const topTwo = first.counts[key] + (second?.counts[key] ?? 0);
  // "Most" only when it is true: the named groups hold more than half.
  const where =
    first.counts[key] === count
      ? `All in ${first.label}.`
      : topTwo * 2 > count
        ? `Mostly in ${named(first)}${second ? ` and ${named(second)}` : ''}.`
        : `Spread over ${formatCount(holding.length)} ${plural(holding.length, area.one, area.many)}; largest: ${named(first)}${second ? `, ${named(second)}` : ''}.`;
  return {
    id: `concentration-${key}`,
    tone: key,
    title: title ?? `${DISPLAY[key].label} for ${formatCount(count)} ${plural(count, unit.one, unit.many)}`,
    text: where,
    targetId: first.id
  };
}

/** Groups with one extra count, `key`, summed from `keys` (or computed per group). */
function withCount(groups, key, countOf) {
  return groups.map((group) => ({ ...group, counts: { ...group.counts, [key]: countOf(group) } }));
}

/**
 * Incident-marked conditions whose result underneath is an absence
 * (`groupStatusCounts`' `marked`), of one group or summed over groups.
 *
 * @param {object|object[]} groups
 * @param {string|null} alert 'serious', 'caution', or null for both
 * @param {string} absence 'out_of_scope' or 'no_data'
 */
function markedOver(groups, alert, absence) {
  return [groups].flat().reduce(
    (sum, group) => sum + (alert ? [alert] : ALERT_ORDER).reduce((inner, key) => inner + (group.marked?.[key]?.[absence] ?? 0), 0),
    0
  );
}

/** "all in X", "most in X", or "" for where the in-scope conditions are. */
function inScopeWhere(groups, count) {
  const [first] = topGroups(groups, 'in_view', 1);
  if (!first) {
    return '';
  }
  if (first.counts.in_view === count) {
    return `, all in ${first.label}`;
  }
  return first.counts.in_view * 2 > count ? `, most in ${first.label}` : '';
}

/**
 * A narrow card (audit A18): it states an intended use and is out of scope
 * for most conditions, so the ring is a quiet grey field. The Summary leads
 * with what is in scope and opens the region that holds most of it.
 */
function narrowLead({ viewId, total, counts, groups, unit, area, alerts, stripKeys }) {
  // In scope by the intended use underneath: an incident's mark over an out-of-scope condition is not "in scope".
  const markedOut = markedOver(groups, null, 'out_of_scope');
  const out = (counts.out_of_scope ?? 0) + markedOut;
  const noData = (counts.no_data ?? 0) + markedOver(groups, null, 'no_data');
  const inView = total - out - noData;
  const scoped = withCount(
    groups,
    'in_view',
    (group) =>
      group.total -
      (group.counts.out_of_scope ?? 0) -
      (group.counts.no_data ?? 0) -
      markedOver(group, null, 'out_of_scope') -
      markedOver(group, null, 'no_data')
  );
  const markedInScope = (key) => (counts[key] ?? 0) - markedOver(groups, key, 'out_of_scope') - markedOver(groups, key, 'no_data');
  const [first] = topGroups(scoped, 'in_view', 1);
  const where = inScopeWhere(scoped, inView);
  const results =
    viewId === 'intended_use'
      ? `${formatCount(counts.in_scope ?? 0)} in scope and ${formatCount(counts.partially_in_scope ?? 0)} partly in scope`
      : [
          `${formatCount(counts.strong ?? 0)} strong, ${formatCount(counts.moderate ?? 0)} moderate, and ${formatCount(counts.weak ?? 0)} weak`,
          ...alerts
            .filter((key) => markedInScope(key) > 0)
            .map((key) => `${formatCount(markedInScope(key))} ${key === 'serious' ? 'serious' : 'caution'} incident`)
        ].join('; ');
  const leading =
    viewId === 'intended_use'
      ? (counts.in_scope ?? 0) >= (counts.partially_in_scope ?? 0) ? 'in_scope' : 'partially_in_scope'
      : ['strong', 'moderate', 'weak'].reduce((best, key) => ((counts[key] ?? 0) > (counts[best] ?? 0) ? key : best), 'strong');
  return {
    id: 'overview',
    tone: inView ? leading : 'out_of_scope',
    title: inView
      ? `In scope for ${formatCount(inView)} ${plural(inView, unit.one, unit.many)}${where}`
      : `Out of scope for all ${unit.many} with a result`,
    text: `${inView ? `${results}. ` : ''}${formatCount(out)} out of scope (${share(out, total)}%)${
      markedOut ? `, ${formatCount(markedOut)} with an incident` : ''
    }.${noData ? ` ${formatCount(noData)} no data.` : ''}`,
    targetId: first?.id ?? null,
    strip: { counts, total, keys: stripKeys }
  };
}


/**
 * Every condition reads No data: the data holds no results for this AI system
 * and function, or none for this population (a product with all-population
 * results only, for example). Said once instead of as empty counts.
 */
function noResults(population, unit) {
  const isSpecific = Boolean(population && population !== 'All patients');
  return {
    id: 'no-results',
    tone: 'no_data',
    title: isSpecific ? `No results for ${population}` : 'No results stored',
    text: isSpecific
      ? `All ${unit.many} read No data. Try All patients under Population.`
      : `All ${unit.many} read No data.`,
    targetId: null
  };
}

/** Contract SafetyCounts as display keys (`none` is No reported incidents). */
export function safetyDisplayCounts(safetyCounts) {
  return {
    serious: safetyCounts?.serious ?? 0,
    caution: safetyCounts?.caution ?? 0,
    no_incidents: safetyCounts?.none ?? 0
  };
}

const MAX_SAFETY_AREAS = 3;

/**
 * The Safety view's highlights (CONTRACT.md §18). Incidents
 * behave like warnings: the headline counts the conditions with a serious or
 * a caution incident, then the areas that hold them, worst first, each
 * opening on the ring. With none, the one highlight says nothing is reported
 * and that this does not mean safe.
 */
function safetyHighlights({ total, counts, groups, unit, area, population, stripKeys = SAFETY_ORDER }) {
  const serious = counts.serious ?? 0;
  const caution = counts.caution ?? 0;
  const forWhom = population && population !== 'All patients' ? ` for ${population}` : '';
  if (!serious && !caution) {
    return [
      {
        id: 'no-incidents',
        tone: 'no_incidents',
        title: 'No reported incidents',
        text: `None open or mitigated${forWhom}. Not evidence of safety.`,
        targetId: null
      }
    ];
  }
  const lead = serious ? 'serious' : 'caution';
  const headCount = serious || caution;
  const parts = [
    serious ? `${formatCount(serious)} with a serious incident` : null,
    caution ? `${formatCount(caution)} with a caution incident` : null
  ].filter(Boolean);
  const highlights = [
    {
      id: 'overview',
      tone: lead,
      title: `${formatCount(headCount)} ${plural(headCount, unit.one, unit.many)} with a ${lead === 'serious' ? 'serious incident' : 'caution incident'}`,
      text: `${parts.join(', ')}, of ${formatCount(total)}${forWhom}.`,
      targetId: null,
      strip: { counts, total, keys: stripKeys }
    }
  ];
  groups
    .filter((group) => (group.counts.serious ?? 0) + (group.counts.caution ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.counts.serious ?? 0) - (a.counts.serious ?? 0) ||
        (b.counts.caution ?? 0) - (a.counts.caution ?? 0) ||
        a.label.localeCompare(b.label)
    )
    .slice(0, MAX_SAFETY_AREAS)
    .forEach((group) => {
      const groupSerious = group.counts.serious ?? 0;
      const groupCaution = group.counts.caution ?? 0;
      const said = [
        groupSerious ? `${formatCount(groupSerious)} ${plural(groupSerious, unit.one, unit.many)} with a serious incident` : null,
        groupCaution ? `${formatCount(groupCaution)} with a caution incident` : null
      ].filter(Boolean);
      highlights.push({
        id: `safety-${group.id}`,
        tone: groupSerious ? 'serious' : 'caution',
        title: group.label,
        text: `${said.join(', ')}, of ${formatCount(group.total)}.`,
        targetId: group.id
      });
    });
  return highlights;
}

/**
 * @param {object} input
 * @param {string} input.viewId contract MetricView, or 'safety'
 * @param {number} input.total conditions counted
 * @param {Record<string, number>} input.counts display key → count (StatusCounts, or intended-use levels plus no_data)
 * @param {{ id: string, label: string, total: number, counts: Record<string, number> }[]} input.groups chapters or blocks
 * @param {{ one: string, many: string }} [input.unit]
 * @param {{ one: string, many: string }} [input.area] what a group is called
 * @param {string|null} [input.population] the population in words ("All patients", "Age 65+, Female")
 * @param {boolean} [input.hasIntendedUse] the card has an intended-use statement
 * @param {boolean} [input.withMapping] another classification (contract v1.13): No mapping is counted and
 *   named apart from No data, and the strips show it
 * @returns {{ id: string, tone: string, title: string, text: string, targetId: string|null, strip?: object }[]}
 */
export function deriveHighlights({
  viewId,
  total,
  counts: servedCounts,
  groups: servedGroups = [],
  unit = { one: 'condition', many: 'conditions' },
  area = { one: 'chapter', many: 'chapters' },
  minGroupSize = null,
  population = null,
  hasIntendedUse = true,
  withMapping = false
}) {
  const counts = normalizeCounts(servedCounts);
  const mappingKeys = withMapping ? ['no_mapping'] : [];
  const groups = servedGroups.map((group) => ({ ...group, counts: normalizeCounts(group.counts) }));
  if (!total) {
    return [{ id: 'empty', tone: 'no_data', title: `No ${unit.many} in view`, text: 'Nothing to summarise here.', targetId: null }];
  }
  if (isSafetyView(viewId)) {
    return safetyHighlights({ total, counts, groups, unit, area, population, stripKeys: [...SAFETY_ORDER, ...mappingKeys] });
  }
  if ((counts.no_data ?? 0) >= total) {
    return [noResults(population, unit)];
  }
  const highlights = [];

  const narrow = hasIntendedUse && ((counts.out_of_scope ?? 0) + markedOver(groups, null, 'out_of_scope')) / total >= NARROW_SHARE;

  if (viewId === 'intended_use') {
    const inScope = counts.in_scope ?? 0;
    const partly = counts.partially_in_scope ?? 0;
    const out = counts.out_of_scope ?? 0;
    if (narrow) {
      highlights.push(narrowLead({ viewId, total, counts, groups, unit, area, alerts: [], stripKeys: [...INTENDED_USE_ORDER, ...mappingKeys] }));
    } else {
      highlights.push({
        id: 'overview',
        tone: inScope >= partly && inScope >= out ? 'in_scope' : partly >= out ? 'partially_in_scope' : 'out_of_scope',
        title: `In scope for ${share(inScope, total)}% of ${unit.many}`,
        text: `${formatCount(inScope)} in scope, ${formatCount(partly)} partly, ${formatCount(out)} out of scope.`,
        targetId: null,
        strip: { counts, total, keys: [...INTENDED_USE_ORDER, ...mappingKeys] }
      });
    }
    (narrow ? ['no_data', ...mappingKeys] : ['out_of_scope', 'no_data', ...mappingKeys]).forEach((key) => {
      const item = (counts[key] ?? 0) > 0 ? concentration(key, counts[key], groups, unit, area) : null;
      if (item) {
        highlights.push(item);
      }
    });
    return highlights;
  }

  // Overview draws an open incident's mark over a result: the
  // strip and the sentences count those conditions apart, as the ring does.
  const keys = keysForView(viewId, { hasIntendedUse, withMapping });
  const alerts = viewId === 'overall' ? ALERT_ORDER.filter((key) => (counts[key] ?? 0) > 0) : [];
  const stripKeys = [...alerts, ...keys];
  const leading = keys.reduce((best, key) => ((counts[key] ?? 0) > (counts[best] ?? 0) ? key : best), keys[0]);
  const marked = alerts.reduce((sum, key) => sum + counts[key], 0);
  // The absence that leads is said once: its "where" joins the lead (audit A17).
  const leadConcentration = isAbsence(leading) && !narrow ? concentration(leading, counts[leading] ?? 0, groups, unit, area) : null;
  if (narrow) {
    highlights.push(narrowLead({ viewId, total, counts, groups, unit, area, alerts, stripKeys }));
  } else {
    // Every condition in view wears an incident's mark: say that, not "Strong for 0%".
    const allMarked = marked >= total;
    highlights.push({
      id: 'overview',
      tone: allMarked ? alerts[0] : leading,
      title: allMarked
        ? `All ${formatCount(total)} ${plural(total, unit.one, unit.many)} show a safety incident's mark`
        : `${DISPLAY[leading].label} for ${share(counts[leading] ?? 0, total)}% of ${unit.many}`,
      text: `${formatCount(counts.strong)} strong, ${formatCount(counts.moderate)} moderate, ${formatCount(counts.weak)} weak of ${formatCount(total)}.${
        marked ? ` ${formatCount(marked)} with an incident.` : ''
      }${leadConcentration ? ` ${leadConcentration.text}` : ''}`,
      targetId: leadConcentration?.targetId ?? null,
      strip: { counts, total, keys: stripKeys }
    });
  }
  if (marked) {
    // Serious and Caution together, per group (audit A1): the concentration is
    // over every marked condition, not over the worst mark alone.
    const alertGroups = withCount(groups, 'alerts', (group) => alerts.reduce((sum, key) => sum + (group.counts[key] ?? 0), 0));
    const lead = alerts[0];
    const item = concentration(
      'alerts',
      marked,
      alertGroups,
      unit,
      area,
      `${formatCount(marked)} ${plural(marked, unit.one, unit.many)} with a safety incident`
    );
    if (item) {
      const serious = counts.serious ?? 0;
      const caution = counts.caution ?? 0;
      const kinds = [
        serious ? `${formatCount(serious)} serious` : null,
        caution ? `${formatCount(caution)} caution` : null
      ].filter(Boolean);
      highlights.push({
        ...item,
        id: 'incidents',
        tone: lead,
        text: `${kinds.join(', ')}. ${item.text}`
      });
    }
  }

  const minSize = minGroupSize ?? defaultMinGroupSize(total);
  const weakest = highestShare(groups, 'weak', minSize);
  if (weakest && weakest.counts.weak / weakest.total >= MIN_WEAKEST_SHARE) {
    highlights.push({
      id: 'weakest',
      tone: 'weak',
      title: `Weakest ${area.one}: ${weakest.label}`,
      text: `${share(weakest.counts.weak, weakest.total)}% of ${formatCount(weakest.total)} weak.`,
      targetId: weakest.id,
      strip: { counts: weakest.counts, total: weakest.total, keys: stripKeys }
    });
  }
  const strongest = highestShare(groups.filter((group) => group.id !== weakest?.id), 'strong', minSize);
  if (strongest && strongest.counts.strong / strongest.total >= MIN_STRONGEST_SHARE) {
    highlights.push({
      id: 'strongest',
      tone: 'strong',
      title: `Strongest ${area.one}: ${strongest.label}`,
      text: `${share(strongest.counts.strong, strongest.total)}% of ${formatCount(strongest.total)} strong.`,
      targetId: strongest.id,
      strip: { counts: strongest.counts, total: strongest.total, keys: stripKeys }
    });
  }
  ['out_of_scope', 'no_data', ...mappingKeys].forEach((key) => {
    if (key === leadConcentration?.tone || (narrow && key === 'out_of_scope')) {
      return;
    }
    const item = (counts[key] ?? 0) > 0 ? concentration(key, counts[key], groups, unit, area) : null;
    if (item) {
      highlights.push(item);
    }
  });
  return highlights;
}

/**
 * Status counts per group from decoded map rows (used inside a chapter, where
 * the groups are blocks).
 *
 * On Overview an incident's mark replaces a condition's result, as on the
 * ring; `marked` keeps what lies underneath when that is an absence
 * (`{ serious: { out_of_scope: 1 } }`), so "in scope" counts by the intended
 * use, not by the mark (audit batch 3). `counts` is what the ring draws.
 *
 * @param {object[]} concepts concepts to count (top-level conditions)
 * @param {Map<string, object>} rowsById decoded map rows
 * @param {string} viewId
 * @param {(concept: object) => string|null} groupOf group id of a concept
 * @param {Record<string, string>} labels group id → label
 * @param {{ hasIntendedUse?: boolean }} [options] as `mapRowStatus`
 */
export function groupStatusCounts(concepts, rowsById, viewId, groupOf, labels, options = {}) {
  const groups = new Map();
  for (const concept of concepts) {
    const groupId = groupOf(concept);
    if (!groupId) {
      continue;
    }
    if (!groups.has(groupId)) {
      groups.set(groupId, { id: groupId, label: labels[groupId] ?? groupId, total: 0, counts: {} });
    }
    const group = groups.get(groupId);
    const row = rowsById.get(concept.concept_id) ?? null;
    const key = mapRowStatus(row, viewId, options);
    group.total += 1;
    group.counts[key] = (group.counts[key] ?? 0) + 1;
    if (ALERT_ORDER.includes(key)) {
      const underneath = mapRowStatus(row, viewId, { ...options, withSafety: false });
      if (isAbsence(underneath)) {
        group.marked ??= {};
        group.marked[key] ??= {};
        group.marked[key][underneath] = (group.marked[key][underneath] ?? 0) + 1;
      }
    }
  }
  return [...groups.values()];
}
