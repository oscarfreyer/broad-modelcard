import { useMemo } from 'react';
import useClientQuery from '../../api/useClientQuery.js';
import { filtersKey, metricParams } from '../../api/queryKeys.js';
import { decodeMetricMap } from './decodeMetricMap.js';

/**
 * Metric map for the atlas (chapterId null) or one chapter. While a new lens
 * or model loads, the previous map of the same scope stays on screen.
 *
 * `isCurrent` is true once the map for exactly these filters is shown.
 * `version` reads another dataset version than the client's default (a
 * preview compares its staged map with the live one).
 *
 * `ontology` is the classification the map on screen was read in (contract
 * v1.13; null for ICD-11), so the ring draws it only over the same structure.
 *
 * @returns {{ rowsById: Map<string, object>, ontology: string|null, isReady: boolean, isCurrent: boolean, isSwitchingModel: boolean, isLoading: boolean, error: Error|null, retry: () => void }}
 */
export default function useMetricMap(filters, chapterId, enabled = true, version = null) {
  const scopeKey = chapterId ? `chapter:${chapterId}` : 'atlas';
  const prefix = `${version ? `${version}|` : ''}map|${scopeKey}|`;
  const key = enabled && filters ? `${prefix}${filtersKey(filters)}` : null;
  const query = useClientQuery(key, (client, options) =>
    client.getMetricMap(
      { ...metricParams(filters), scope: chapterId ? 'chapter' : 'atlas', chapterId: chapterId || undefined },
      version ? { ...options, version } : options
    )
  );
  const isSameScope = Boolean(query.dataKey?.startsWith(prefix));
  const map = isSameScope ? query.data : null;
  const rowsById = useMemo(() => decodeMetricMap(map), [map]);
  const shownFilters = map?.filters;

  return {
    rowsById,
    ontology: map?.ontology?.id ?? null,
    isReady: Boolean(map),
    isCurrent: Boolean(key) && query.dataKey === key,
    isSwitchingModel: Boolean(
      query.isLoading && shownFilters && filters && (shownFilters.model !== filters.model || shownFilters.use_case !== filters.useCase)
    ),
    isLoading: query.isLoading,
    error: query.error,
    retry: query.retry
  };
}
