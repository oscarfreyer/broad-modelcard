import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';

const MAX_SEARCH_MATCHES = 80;
const DEBOUNCE_MS = 90;

/**
 * Live search for the ⌘K palette, in the classification on screen (ICD-11,
 * or another ontology, contract v1.13): by code, concept id, or part of a
 * name. Choosing a result opens it on the ring; in multimorbidity mode a
 * condition is added to (or removed from) the combination instead.
 *
 * @param {object} input
 * @param {boolean} input.isMultimorbidityMode
 * @param {string|null} [input.population] a local population id (contract v1.10): results carry its tiers
 * @param {string|null} [input.ontology] another classification than ICD-11 (contract v1.13): its concepts are searched
 * @param {(concept: object) => string} input.pathLabelFor
 * @param {(concept: object) => void} input.onNavigate open a concept with focus
 * @param {(concept: object) => void} input.onToggleCondition toggle a condition in the combination
 */
export default function useConceptSearch({ isMultimorbidityMode, population = null, ontology = null, pathLabelFor, onNavigate, onToggleCondition }) {
  const client = useDataClient();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState({ query: '', matches: [], total: 0, error: null });
  const requestRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    requestRef.current += 1;
    const requestId = requestRef.current;
    if (!trimmed) {
      setResult({ query: '', matches: [], total: 0, error: null });
      return undefined;
    }
    // A newer query cancels the request of the last one, not only its answer.
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await client.searchConcepts(
          {
            q: trimmed,
            limit: MAX_SEARCH_MATCHES,
            ...(population ? { population } : {}),
            ...(ontology ? { ontology } : {})
          },
          { signal: controller.signal }
        );
        if (requestId === requestRef.current) {
          setResult({
            query: trimmed,
            matches: response.results.map((concept) => ({ ...concept, pathLabel: pathLabelFor(concept) })),
            total: response.total,
            error: null
          });
        }
      } catch (error) {
        if (requestId === requestRef.current && error?.name !== 'AbortError') {
          setResult({ query: trimmed, matches: [], total: 0, error });
        }
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, ontology, pathLabelFor, population, query]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  /** Whether a result can be chosen in the current mode. */
  const canChoose = useCallback((concept) => !isMultimorbidityMode || concept.level === 2, [isMultimorbidityMode]);

  const choose = useCallback((concept) => {
    if (!concept || !canChoose(concept)) {
      return;
    }
    setIsOpen(false);
    if (isMultimorbidityMode) {
      onToggleCondition(concept);
    } else {
      onNavigate(concept);
    }
  }, [canChoose, isMultimorbidityMode, onNavigate, onToggleCondition]);

  const trimmed = query.trim();
  const isCurrent = result.query === trimmed;
  return useMemo(
    () => ({
      isOpen,
      open,
      close,
      query,
      setQuery,
      matches: isCurrent ? result.matches : [],
      total: isCurrent ? result.total : 0,
      error: isCurrent ? result.error : null,
      isPending: Boolean(trimmed) && !isCurrent,
      limit: MAX_SEARCH_MATCHES,
      canChoose,
      choose
    }),
    [canChoose, choose, close, isCurrent, isOpen, open, query, result, trimmed]
  );
}
