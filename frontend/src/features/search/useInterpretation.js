import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';

const DEBOUNCE_MS = 140;
const EMPTY = Object.freeze({ query: '', chips: [], unrecognized: [], origin: 'rules', helper: null, error: null });
const chipKey = (chip) => `${chip.kind}|${chip.value}`;

/**
 * Reads a query as chips (contract v1.14, CONTRACT.md §31): interpretQuery as
 * the reader types, and, on request, the optional helper (interpretQueryWithHelper),
 * offered only while getAssistStatus says it is on. Removing a chip hides it
 * until the query changes. Nothing here applies anything.
 *
 * @param {{ query: string, enabled: boolean }} input
 */
export default function useInterpretation({ query, enabled }) {
  const client = useDataClient();
  const [result, setResult] = useState(EMPTY);
  const [removed, setRemoved] = useState(() => new Set());
  const [helperState, setHelperState] = useState({ available: false, isAsking: false, error: null });
  const requestRef = useRef(0);
  const trimmed = enabled ? String(query ?? '').trim() : '';

  // Whether the helper is on: asked once, the first time the row could show it.
  const askedStatus = useRef(false);
  useEffect(() => {
    if (!enabled || askedStatus.current) return;
    askedStatus.current = true;
    client
      .getAssistStatus()
      .then((status) => setHelperState((state) => ({ ...state, available: Boolean(status?.enabled) })))
      .catch(() => setHelperState((state) => ({ ...state, available: false })));
  }, [client, enabled]);

  useEffect(() => {
    requestRef.current += 1;
    const requestId = requestRef.current;
    setRemoved(new Set());
    setHelperState((state) => ({ ...state, isAsking: false, error: null }));
    if (!trimmed) {
      setResult(EMPTY);
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const answer = await client.interpretQuery({ q: trimmed }, { signal: controller.signal });
        if (requestId === requestRef.current) {
          setResult({ query: trimmed, chips: answer.chips, unrecognized: answer.unrecognized, origin: 'rules', helper: null, error: null });
        }
      } catch (error) {
        if (requestId === requestRef.current && error?.name !== 'AbortError') {
          setResult({ ...EMPTY, query: trimmed, error });
        }
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, trimmed]);

  const askHelper = useCallback(async () => {
    if (!trimmed) return;
    const requestId = requestRef.current;
    setHelperState((state) => ({ ...state, isAsking: true, error: null }));
    try {
      const answer = await client.interpretQueryWithHelper({ q: trimmed });
      if (requestId !== requestRef.current) return;
      setRemoved(new Set());
      setResult({
        query: trimmed,
        chips: answer.chips,
        unrecognized: answer.unrecognized,
        origin: 'helper',
        helper: { provider: answer.provider, model: answer.model, dropped: answer.dropped },
        error: null
      });
      setHelperState((state) => ({ ...state, isAsking: false }));
    } catch (error) {
      if (requestId === requestRef.current) setHelperState((state) => ({ ...state, isAsking: false, error }));
    }
  }, [client, trimmed]);

  const remove = useCallback((chip) => setRemoved((current) => new Set([...current, chipKey(chip)])), []);

  const isCurrent = result.query === trimmed;
  return useMemo(() => {
    const chips = isCurrent ? result.chips.filter((chip) => !removed.has(chipKey(chip))) : [];
    return {
      query: trimmed,
      chips,
      removedCount: isCurrent ? result.chips.length - chips.length : 0,
      unrecognized: isCurrent ? result.unrecognized : [],
      origin: isCurrent ? result.origin : 'rules',
      helper: isCurrent ? result.helper : null,
      error: isCurrent ? result.error : null,
      isPending: Boolean(trimmed) && !isCurrent,
      remove,
      helperAvailable: helperState.available,
      isAskingHelper: helperState.isAsking,
      helperError: helperState.error,
      askHelper
    };
  }, [askHelper, helperState, isCurrent, remove, removed, result, trimmed]);
}
