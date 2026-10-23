// The base models' results for the condition card's Built on section
// (contract v1.14, release 0.5 phase Q4). One read per base
// model through the existing getConceptMetrics, with the same condition,
// lens, population, and classification as the card on screen; no new API.
import { useMemo } from 'react';
import { conceptMetricsQuery } from '../../api/queryKeys.js';
import useClientQuery from '../../api/useClientQuery.js';
import { builtOnBases } from './copy/builtOnCopy.js';

/**
 * @param {object} input
 * @param {object|null} input.entry ModelEntry on screen
 * @param {object|null} input.functionEntry UseCaseEntry on screen
 * @param {object[]} input.registry every ModelEntry
 * @param {object|null} input.filters the atlas filters (card, lens, population, classification); null disables it
 * @param {string|null} input.conceptId the condition on screen
 * @param {((base: object) => string|null)|null} [input.compareHrefFor] the comparison link for a base card
 * @returns {{ base: object, details: object|null, error: Error|null, compareHref: string|null }[]}
 */
export default function useBuiltOn({ entry, functionEntry, registry, filters, conceptId, compareHrefFor = null }) {
  const bases = useMemo(() => (filters && conceptId ? builtOnBases(entry, functionEntry, registry) : []), [conceptId, entry, filters, functionEntry, registry]);
  const queries = useMemo(
    () => bases.map((base) => (base.choice ? conceptMetricsQuery({ ...filters, model: base.version, useCase: base.choice.useCase }, conceptId) : null)),
    [bases, conceptId, filters]
  );
  const key = queries.some(Boolean) ? `built-on|${queries.map((query) => query?.key ?? '-').join('||')}` : null;
  const read = useClientQuery(key, (client, options) => Promise.all(queries.map((query) => (query ? query.fetch(client, options) : null))));
  const current = key && read.dataKey === key ? read.data : null;
  const error = key ? read.error : null;
  return useMemo(
    () =>
      bases.map((base, index) => ({
        base,
        details: current?.[index] ?? null,
        error: base.choice ? error : null,
        compareHref: base.choice && compareHrefFor ? compareHrefFor(base) : null
      })),
    [bases, compareHrefFor, current, error]
  );
}
