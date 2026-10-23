import { useCallback, useEffect, useRef, useState } from 'react';
import { useDataClientContext } from './DataClientProvider.jsx';

/**
 * Read data through the data client.
 *
 * `key` identifies the request (null disables it). Cached responses are
 * returned synchronously. While a new key loads, the previous response stays
 * available as `data` so views can keep showing it; `dataKey` tells which key
 * `data` belongs to.
 *
 * @template T
 * @param {string|null} key
 * @param {(client: object, options: { signal: AbortSignal }) => Promise<T>} fetcher
 * @returns {{ data: T|null, dataKey: string|null, isLoading: boolean, error: Error|null, retry: () => void }}
 */
export default function useClientQuery(key, fetcher) {
  const { client, cache } = useDataClientContext();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [state, setState] = useState(() => ({
    key: key != null && cache.has(key) ? key : null,
    data: key != null && cache.has(key) ? cache.get(key) : null,
    errorKey: null,
    error: null
  }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (key == null) {
      // A disabled query forgets its data, so re-enabling never shows stale data.
      setState((current) => (current.key === null && current.data === null ? current : { key: null, data: null, errorKey: null, error: null }));
      return undefined;
    }
    if (cache.has(key)) {
      const data = cache.get(key);
      setState((current) => (current.key === key && current.data === data ? current : { key, data, errorKey: null, error: null }));
      return undefined;
    }

    const controller = new AbortController();
    fetcherRef.current(client, { signal: controller.signal }).then(
      (data) => {
        // An aborted read is not cached: a fetcher that resolves after an
        // abort may hold a partial answer.
        if (!controller.signal.aborted) {
          cache.set(key, data);
          setState({ key, data, errorKey: null, error: null });
        }
      },
      (error) => {
        if (!controller.signal.aborted && error?.name !== 'AbortError') {
          setState((current) => ({ ...current, errorKey: key, error }));
        }
      }
    );
    return () => controller.abort();
  }, [cache, client, key, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  if (key == null) {
    return { data: null, dataKey: null, isLoading: false, error: null, retry };
  }
  if (cache.has(key)) {
    return { data: cache.get(key), dataKey: key, isLoading: false, error: null, retry };
  }
  const error = state.errorKey === key ? state.error : null;
  return { data: state.data, dataKey: state.key, isLoading: !error, error, retry };
}
