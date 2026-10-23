import { useCallback, useEffect, useRef, useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import { shouldReloadOnFocus } from './adminReload.js';

/**
 * The library overview every admin page needs: data sets (version, last
 * update, counts, staged uploads), the live model registry (for the AI system
 * × function pickers), and the version history. `reload()` reads all three
 * again, e.g. after a publish; the page also reloads when it regains focus,
 * at most once every few seconds. A reload keeps showing the data it has, so
 * it renders once, when the new data arrives.
 */
export default function useAdminData() {
  const client = useDataClient();
  const [state, setState] = useState({ datasets: null, models: null, versions: null, error: null });
  const generation = useRef(0);
  const lastLoad = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    lastLoad.current = Date.now();
    try {
      const [datasets, models, versions] = await Promise.all([
        client.listDatasets(),
        client.listModels({}, { version: 'live' }),
        client.listVersions({})
      ]);
      if (current === generation.current) {
        setState({ datasets, models, versions, error: null });
      }
    } catch (error) {
      if (current === generation.current) {
        setState((previous) => ({ ...previous, error }));
      }
    }
  }, [client]);

  useEffect(() => {
    reload();
    const onFocus = () => {
      if (shouldReloadOnFocus(lastLoad.current, Date.now())) reload();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  return { ...state, reload };
}
