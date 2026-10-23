// Safety view: how many of a subchapter's conditions carry each Safety mark.
// The map gives a subchapter only its worst mark (CONTRACT.md §18); the hover
// card adds how many of its conditions are marked, from the same map rows.
import { DISPLAY, mapRowStatus } from '../../design/status.js';

/**
 * @param {Record<string, { concept_id: string }[]>} conditionsByGroupId subchapter id → its top-level conditions
 * @param {Map<string, object>} rowsById decoded map rows (with the `safety` column)
 * @returns {Map<string, { serious: number, caution: number, total: number }>} only groups with a marked condition
 */
export function safetyTallies(conditionsByGroupId, rowsById) {
  const tallies = new Map();
  Object.entries(conditionsByGroupId || {}).forEach(([groupId, conditions]) => {
    const tally = { serious: 0, caution: 0, total: conditions.length };
    conditions.forEach((condition) => {
      const key = mapRowStatus(rowsById.get(condition.concept_id) ?? null, 'safety');
      if (key === 'serious' || key === 'caution') {
        tally[key] += 1;
      }
    });
    if (tally.serious || tally.caution) {
      tallies.set(groupId, tally);
    }
  });
  return tallies;
}

/** e.g. "3 of its 14 conditions marked: 2 with a serious incident, 1 with a caution incident". */
export function tallyText(tally) {
  const parts = [
    tally.serious ? `${tally.serious} with a serious incident` : null,
    tally.caution ? `${tally.caution} with a caution incident` : null
  ].filter(Boolean);
  const marked = tally.serious + tally.caution;
  return `${marked} of its ${tally.total.toLocaleString('en-US')} ${tally.total === 1 ? 'condition' : 'conditions'} marked: ${parts.join(', ')}`;
}

/**
 * Off the Safety view, a hovered bubble whose condition (or one of whose
 * conditions) carries an open or mitigated incident says so in one line, so a
 * green result never hides a reported incident until it is clicked (S8
 * critique). On Overview the incident's mark already replaces the result
 *, so the line names the result underneath instead. The result
 * itself is unchanged: incidents never change a grade (CONTRACT.md §18). Null on the Safety view (the mark already says it), in
 * Multimorbidity, and without a mark.
 *
 * @param {object|null} row decoded map row (with the `safety` column)
 * @param {{ level: number }} concept
 * @param {{ isCombinationMode?: boolean, hasIntendedUse?: boolean }} [options]
 * @returns {{ status: 'serious'|'caution', text: string, result?: string }|null} `result`: on Overview, the result's word
 */
export function incidentHint(row, concept, viewId, { isCombinationMode = false, hasIntendedUse = true } = {}) {
  if (viewId === 'safety' || isCombinationMode) {
    return null;
  }
  const status = mapRowStatus(row, 'safety');
  if (status !== 'serious' && status !== 'caution') {
    return null;
  }
  const word = status === 'serious' ? 'serious' : 'caution';
  if (viewId === 'overall') {
    const result = DISPLAY[mapRowStatus(row, 'overall', { hasIntendedUse, withSafety: false })].label;
    return {
      status,
      result,
      text:
        concept?.level === 2
          ? `An open ${word} safety incident is reported, so its mark shows here. The result underneath is ${result}; incidents never change it.`
          : `Holds conditions with a ${word} safety incident, so its mark shows here. The result underneath is ${result}.`
    };
  }
  return {
    status,
    text:
      concept?.level === 2
        ? `A ${word} safety incident is reported. Select it to read it; it does not change this result.`
        : `Holds conditions with a ${word} safety incident. The Safety view marks them.`
  };
}
