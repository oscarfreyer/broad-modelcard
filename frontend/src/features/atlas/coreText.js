// What a subchapter bubble's centre says, in words (status.js
// subchapterCore): the hover card and the bubble's accessible name.

const plural = (count, one, many) => (count === 1 ? one : many);

/**
 * @param {{ share: number, status: string, count: number, total: number }} core
 * @returns {string} e.g. "4 of its 23 conditions are weak (17%)"
 */
export function coreText(core) {
  const percent = Math.round(core.share * 100);
  const of = `${core.count} of its ${core.total} ${plural(core.total, 'condition', 'conditions')}`;
  if (core.status === 'weak') {
    return `${of} ${plural(core.count, 'is', 'are')} weak (${percent}%)`;
  }
  return `${of} ${plural(core.count, 'has', 'have')} no scope fit (${percent}%)`;
}

/** Beside a weak centre: the conditions without a result, or null. */
export function coreNoDataText(core) {
  if (core?.status !== 'weak' || !core.noData) {
    return null;
  }
  return `${core.noData} ${plural(core.noData, 'condition has', 'conditions have')} no data`;
}
