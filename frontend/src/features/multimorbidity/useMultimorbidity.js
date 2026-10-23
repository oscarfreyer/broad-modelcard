import { useMemo } from 'react';
import useClientQuery from '../../api/useClientQuery.js';
import { combinationQuery, filtersKey, metricParams, singlesQuery } from '../../api/queryKeys.js';

import { decodeMetricMap } from '../atlas/decodeMetricMap.js';

/**
 * Multimorbidity mode data for the current selection: which conditions can
 * extend it (colored on the atlas) and the stored row for the exact set.
 *
 * @param {object|null} filters
 * @param {string[]} selectedIds canonical condition ids in selection order
 * @param {string|null} chapterId open chapter, or null for the atlas
 * @param {boolean} enabled
 * @param {string|null} [version] another dataset version than the client's
 *   default; reads the candidates only (a preview compares them with live)
 */
export default function useMultimorbidity(filters, selectedIds, chapterId, enabled, version = null) {
  const selectionKey = selectedIds.join(',');
  const scopeKey = chapterId ? `chapter:${chapterId}` : 'atlas';
  const prefix = `${version ? `${version}|` : ''}candidates|${scopeKey}|`;
  const candidatesKey = enabled && filters ? `${prefix}${filtersKey(filters)}|${selectionKey}` : null;
  const candidates = useClientQuery(candidatesKey, (client, options) =>
    client.getMultimorbidityCandidates(
      { ...metricParams(filters), selected: selectedIds, scope: chapterId ? 'chapter' : 'atlas', chapterId: chapterId || undefined },
      version ? { ...options, version } : options
    )
  );
  const combination = combinationQuery(enabled && !version ? filters : null, selectedIds);
  const combinationResult = useClientQuery(combination?.key ?? null, (client, options) => combination.fetch(client, options));
  const displayRowsById = useMemo(() => decodeMetricMap(candidates.data?.display), [candidates.data]);
  const singles = singlesQuery(enabled && !version ? filters : null, selectedIds);
  const singlesResult = useClientQuery(singles?.key ?? null, (client, options) => singles.fetch(client, options));

  const isCurrentCombination = Boolean(combination) && combinationResult.dataKey === combination.key;
  return {
    candidateIds: candidates.data?.candidate_ids || [],
    displayRowsById,
    isReady: Boolean(candidates.dataKey?.startsWith(prefix)),
    isCurrent: Boolean(candidatesKey) && candidates.dataKey === candidatesKey,
    // Only the row of the exact current set; a previous set's row is never shown for a new one.
    combinationRow: isCurrentCombination ? combinationResult.data?.metrics ?? null : null,
    isLoadingRow: Boolean(combination) && combinationResult.isLoading,
    // Each selected condition's own row, by id (null until read, or for a set below two).
    singleRowsById: singles && singlesResult.dataKey === singles.key ? singlesResult.data : null,
    error: candidates.error || combinationResult.error,
    retry: () => {
      candidates.retry();
      combinationResult.retry();
    }
  };
}
