import { useCallback, useEffect, useMemo, useState } from 'react';
import { applyPlan, canCombine, showsInterpretation } from './interpretation.js';
import useInterpretation from './useInterpretation.js';

const keyOf = (query, chips) => `${query}\n${chips.map((chip) => `${chip.kind}|${chip.value}`).join(',')}`;

/**
 * The atlas palette's plain-language search (contract v1.14, CONTRACT.md §31):
 * reads the palette's query as chips (ICD-11, outside Multimorbidity mode) and
 * applies them on request. Apply sets the card (a system or function chip),
 * the whole lens (an axis without a chip is "All …"), the care setting (none:
 * Any setting), and opens the first condition, or the conditions as a
 * combination. After Apply, removing a chip applies the rest at once.
 *
 * @param {object} input
 * @param {ReturnType<import('./useConceptSearch.js').default>} input.search
 * @param {boolean} input.enabled ICD-11 on screen and not in Multimorbidity mode
 * @param {object[]} input.entries the registry (listModels)
 * @param {{ model: string, useCase: string }|null} input.current the card on screen
 * @param {(plan: object, options: { combine: boolean }) => void} input.apply puts a plan on screen
 */
export default function usePlainSearch({ search, enabled, entries, current, apply }) {
  // Read once the palette has opened, and kept while it is closed, so reopening shows the
  // same chips (and what was removed) and whether they are applied.
  const [wasOpened, setWasOpened] = useState(false);
  useEffect(() => {
    if (search.isOpen) setWasOpened(true);
  }, [search.isOpen]);
  const interpretation = useInterpretation({ query: search.query, enabled: enabled && (search.isOpen || wasOpened) });
  const [appliedKey, setAppliedKey] = useState(null);
  const { chips, query } = interpretation;
  const plan = useMemo(() => applyPlan(chips, entries, current), [chips, current, entries]);
  const isApplied = appliedKey !== null && appliedKey === keyOf(query, chips);

  const applyChips = useCallback(
    (nextChips, { combine = false, close = true } = {}) => {
      apply(applyPlan(nextChips, entries, current), { combine });
      setAppliedKey(keyOf(query, nextChips));
      if (close) search.close();
    },
    [apply, current, entries, query, search]
  );

  const remove = useCallback(
    (chip) => {
      interpretation.remove(chip);
      if (isApplied) {
        applyChips(chips.filter((item) => item !== chip), { close: false });
      }
    },
    [applyChips, chips, interpretation, isApplied]
  );

  const isShown = enabled && search.isOpen && (showsInterpretation(query, chips) || interpretation.removedCount > 0 || interpretation.origin === 'helper');
  return {
    isShown,
    interpretation: useMemo(() => ({ ...interpretation, remove }), [interpretation, remove]),
    isApplied,
    canCombine: canCombine(plan, entries, current),
    onApply: ({ combine }) => applyChips(chips, { combine })
  };
}
