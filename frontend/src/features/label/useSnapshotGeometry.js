import { useEffect, useState } from 'react';
import useClientQuery from '../../api/useClientQuery.js';
import { cachedSnapshotGeometry, snapshotGeometry } from './snapshot.js';

/**
 * The snapshot geometry for a page: the atlas structure (one read, shared
 * with the atlas's own cache key, so the atlas page reads it once) and the
 * ring layout over it, computed once and shared by every snapshot. The
 * layout is computed after the page has painted, so tiles show their text
 * at once and their snapshots a moment later, in a placeholder of the same
 * size.
 *
 * @param {{ population?: string|null, enabled?: boolean }} [options]
 *   population: a local population (contract v1.10) sizes and places the
 *   bubbles as on that population's atlas
 * @returns {ReturnType<typeof snapshotGeometry>}
 */
export default function useSnapshotGeometry({ population = null, enabled = true } = {}) {
  const key = enabled ? `overview${population ? `|population:${population}` : ''}` : null;
  const overview = useClientQuery(key, (client, options) => client.getAtlasOverview(population ? { population } : {}, options));
  const data = overview.dataKey === key ? overview.data : null;
  const [computed, setComputed] = useState(null);
  const geometry = cachedSnapshotGeometry(data) ?? (computed?.data === data ? computed.geometry : null);

  useEffect(() => {
    if (!data || cachedSnapshotGeometry(data)) {
      return undefined;
    }
    // Let the page paint first; the layout takes a few tens of milliseconds once per structure.
    const timer = setTimeout(() => setComputed({ data, geometry: snapshotGeometry(data) }), 0);
    return () => clearTimeout(timer);
  }, [data]);

  return geometry;
}
