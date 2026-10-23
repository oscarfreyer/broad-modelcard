import { useMemo } from 'react';
import { filtersKey, metricParams } from '../../api/queryKeys.js';
import useClientQuery from '../../api/useClientQuery.js';
import { deriveHighlights, groupStatusCounts, safetyDisplayCounts } from './summaryHighlights.js';
import { conceptName } from '../../shared/conceptName.js';
import { populationWords } from '../../shared/format.js';
import { isSafetyView, keysForView, normalizeCounts } from '../../design/status.js';
import { appraisalCounts, appraisalHighlight } from '../atlas/appraisalMark.js';
import { configurationHighlight } from '../details/copy/evidenceAgeCopy.js';

/** The display counts of a MetricSummary (or one of its chapters) for a view. */
function summaryCounts(entry, viewId) {
  if (isSafetyView(viewId)) {
    return safetyDisplayCounts(entry.safety_counts);
  }
  return normalizeCounts(entry.counts);
}

/** "02 Neoplasms" → "Neoplasms". */
export function chapterName(concept) {
  return conceptName(concept);
}

const sumCounts = (groups, initial = {}) =>
  groups.reduce((total, group) => {
    Object.entries(group.counts).forEach(([key, value]) => {
      total[key] = (total[key] ?? 0) + value;
    });
    return total;
  }, { ...initial });

/** Zero counts for a view's keys, so the centre lists every row (Overview adds incidents when there are any). */
const zeroCounts = (viewId, hasIntendedUse, withMapping = false) =>
  Object.fromEntries(keysForView(viewId, { hasIntendedUse, withMapping }).map((key) => [key, 0]));

/**
 * Centre counts and Summary highlights for the ring in view. At atlas level
 * they come from the contract's MetricSummary; inside a chapter, the counts
 * come from the summary's chapter entry and the per-subchapter breakdown
 * from the chapter's map rows.
 *
 * Overview counts what the ring draws: an open incident's mark
 * replaces a condition's result there, which the MetricSummary does not
 * know, so Overview counts the map rows on screen at both levels (the atlas
 * map holds every top-level condition) and needs no summary request. In
 * another classification (contract v1.13) every view does the same: the map
 * rows tell No mapping from No data, which the summary's counts fold together.
 *
 * @param {object} input
 * @param {object|null} input.filters null disables the summary (multimorbidity mode)
 * @param {string} input.viewId
 * @param {object} input.structure atlas structure (chapters by id)
 * @param {object|null} input.chapter { id, concepts, blocksById } of the open chapter
 * @param {Map<string, object>} input.chapterRows decoded map rows on screen (the atlas map at atlas level, the chapter's inside one)
 * @param {boolean} input.chapterRowsReady
 * @param {boolean} [input.hasIntendedUse] the card has an intended-use statement
 * @param {boolean} [input.withMapping] another classification than ICD-11 is shown (No mapping can occur)
 */
export default function useRingSummary({ filters, viewId, structure, chapter, chapterRows, chapterRowsReady, hasIntendedUse = true, withMapping = false }) {
  const isOverview = viewId === 'overall';
  const fromMap = isOverview || withMapping;
  const key = filters && !fromMap ? `summary|${filtersKey(filters)}|${viewId}` : null;
  const query = useClientQuery(key, (client, options) => client.getMetricSummary({ ...metricParams(filters), view: viewId }, options));
  const summary = query.dataKey === key ? query.data : null;
  // Evidence age (contract v1.14, §28.5): the Evidence view's summary carries `configuration_counts`.
  // Where the counts above come from the map (another classification), it is read on its own.
  const ageKey = filters && viewId === 'evidence' && fromMap ? `summary|${filtersKey(filters)}|evidence` : null;
  const ageQuery = useClientQuery(ageKey, (client, options) => client.getMetricSummary({ ...metricParams(filters), view: 'evidence' }, options));
  const ageSummary = viewId !== 'evidence' ? null : fromMap ? (ageQuery.dataKey === ageKey ? ageQuery.data : null) : summary;
  const configurationCounts = ageSummary?.configuration_counts ?? null;
  const population = filters ? populationWords(filters) : null;

  const atlas = useMemo(() => {
    if (fromMap) {
      if (!filters || !chapterRowsReady || chapter) {
        return null;
      }
      const conditions = Object.values(structure.topLevelConditionsByBlockId).flat();
      const labels = Object.fromEntries(structure.chapterConcepts.map((entry) => [entry.concept_id, chapterName(entry)]));
      const groups = groupStatusCounts(conditions, chapterRows, viewId, (concept) => concept.chapter_id, labels, { hasIntendedUse });
      const counts = sumCounts(groups, zeroCounts(viewId, hasIntendedUse, withMapping));
      return {
        centre: { counts, total: conditions.length, caption: 'conditions' },
        highlights: deriveHighlights({ viewId, total: conditions.length, counts, groups, population, hasIntendedUse, withMapping })
      };
    }
    if (!summary) {
      return null;
    }
    const counts = viewId === 'intended_use'
      ? { ...summary.intended_use_counts, no_data: summary.counts.no_data }
      : summaryCounts(summary, viewId);
    const groups = summary.chapters.map((entry) => ({
      id: entry.chapter_id,
      label: chapterName(structure.conceptsById[entry.chapter_id]) || entry.chapter_id,
      total: entry.total,
      counts: summaryCounts(entry, viewId)
    }));
    return {
      centre: { counts, total: summary.total, caption: 'conditions' },
      highlights: deriveHighlights({ viewId, total: summary.total, counts, groups, population, hasIntendedUse })
    };
  }, [chapter, chapterRows, chapterRowsReady, filters, fromMap, hasIntendedUse, population, structure, summary, viewId, withMapping]);

  const inChapter = useMemo(() => {
    if (!chapter || !chapterRowsReady) {
      return null;
    }
    const conditions = chapter.concepts.filter((concept) => concept.depth_in_kind === 1 || concept.depth_in_kind == null);
    const labels = Object.fromEntries(Object.values(chapter.blocksById).map((block) => [block.concept_id, conceptName(block)]));
    const groups = groupStatusCounts(conditions, chapterRows, viewId, (concept) => concept.parent_id, labels, { hasIntendedUse });
    const summaryEntry = summary?.chapters.find((entry) => entry.chapter_id === chapter.id);
    const counts =
      viewId !== 'intended_use' && summaryEntry ? summaryCounts(summaryEntry, viewId) : sumCounts(groups, zeroCounts(viewId, hasIntendedUse, withMapping));
    const total = summaryEntry?.total ?? conditions.length;
    return {
      centre: { counts, total, caption: 'conditions' },
      highlights: deriveHighlights({
        viewId,
        total,
        counts,
        groups,
        area: { one: 'subchapter', many: 'subchapters' },
        population,
        hasIntendedUse,
        withMapping
      })
    };
  }, [chapter, chapterRows, chapterRowsReady, hasIntendedUse, population, summary, viewId, withMapping]);

  // Not appraised (2026-10-21, CONTRACT.md §22): on Evidence, the graded conditions in view and those
  // with a study record behind their grade, from the map rows on screen (the legend counts the rest).
  const appraisal = useMemo(() => {
    if (viewId !== 'evidence' || !filters || !chapterRowsReady || (chapter && !inChapter)) {
      return null;
    }
    const conditions = chapter
      ? chapter.concepts.filter((concept) => concept.depth_in_kind === 1 || concept.depth_in_kind == null)
      : Object.values(structure.topLevelConditionsByBlockId).flat();
    return appraisalCounts(conditions, chapterRows);
  }, [chapter, chapterRows, chapterRowsReady, filters, inChapter, structure, viewId]);

  const shown = chapter ? inChapter ?? { centre: null, highlights: null } : atlas ?? { centre: null, highlights: null };
  const highlights = useMemo(() => {
    const card = appraisal ? appraisalHighlight(appraisal) : null;
    // The configuration counts are across the card, so they show at atlas level only.
    const age = chapter ? null : configurationHighlight(configurationCounts);
    const extra = [card, age].filter(Boolean);
    return shown.highlights && extra.length ? [...shown.highlights, ...extra] : shown.highlights;
  }, [appraisal, chapter, configurationCounts, shown.highlights]);

  return {
    ...shown,
    highlights,
    appraisal,
    configurationCounts,
    error: query.error,
    retry: query.retry
  };
}
