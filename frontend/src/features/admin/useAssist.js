import { useCallback, useEffect, useRef, useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import { configureRequest } from './assist.js';

/**
 * The study helper's status (contract v1.9, CONTRACT.md §20) and the actions
 * that change it. The status never holds the API key; `save` takes the key
 * as an argument, sends it once, and keeps nothing of it.
 *
 * @returns {{
 *   status: object|null, error: Error|null, isOpen: boolean, open: () => void, close: () => void,
 *   reload: () => Promise<void>, save: (form: object, apiKey?: string) => Promise<object|null>,
 *   turnOff: () => Promise<boolean>, busy: null|'saving'|'clearing', problem: Error|null, clearProblem: () => void
 * }}
 */
export default function useAssist() {
  const client = useDataClient();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await client.getAssistStatus();
      if (current === generation.current) {
        setStatus(next);
        setError(null);
      }
    } catch (failure) {
      if (current === generation.current) setError(failure);
    }
  }, [client]);

  // Read again on focus: the helper may have been set up or turned off in another tab.
  useEffect(() => {
    reload();
    const onFocus = () => reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  const save = useCallback(
    async (form, apiKey = '') => {
      setBusy('saving');
      setProblem(null);
      try {
        const next = await client.configureAssist(configureRequest(form, apiKey));
        generation.current += 1;
        setStatus(next);
        setError(null);
        return next;
      } catch (failure) {
        setProblem(failure);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [client]
  );

  const turnOff = useCallback(async () => {
    setBusy('clearing');
    setProblem(null);
    try {
      await client.clearAssist();
      await reload();
      return true;
    } catch (failure) {
      setProblem(failure);
      return false;
    } finally {
      setBusy(null);
    }
  }, [client, reload]);

  return {
    status,
    error,
    isOpen,
    open: () => {
      setProblem(null);
      setIsOpen(true);
    },
    close: () => setIsOpen(false),
    reload,
    save,
    turnOff,
    busy,
    problem,
    clearProblem: () => setProblem(null)
  };
}
