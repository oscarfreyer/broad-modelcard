import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { createQueryCache } from './queryCache.js';

const DataClientContext = createContext(null);

/**
 * Makes one data client (and its response cache) available to the component
 * tree. `resetCache()` starts a fresh cache, so every query reads again, for
 * example after the dataset version changed.
 */
export function DataClientProvider({ client, children }) {
  const [generation, setGeneration] = useState(0);
  const resetCache = useCallback(() => setGeneration((value) => value + 1), []);
  // A new cache per generation; the generation is the dependency that replaces it.
  const cache = useMemo(() => createQueryCache(), [client, generation]);
  const value = useMemo(() => ({ client, cache, resetCache }), [cache, client, resetCache]);
  return <DataClientContext.Provider value={value}>{children}</DataClientContext.Provider>;
}

export function useDataClientContext() {
  const context = useContext(DataClientContext);
  if (!context) {
    throw new Error('useDataClient must be used inside <DataClientProvider>.');
  }
  return context;
}

/** The provider's client and cache, or null outside a provider (shared chrome such as SiteNav, rendered alone in tests). */
export function useOptionalDataClientContext() {
  return useContext(DataClientContext);
}

/** The app's data client: the only way components reach data. */
export function useDataClient() {
  return useDataClientContext().client;
}

/** Drops every cached response, so every query reads again. */
export function useResetDataCache() {
  return useDataClientContext().resetCache;
}
