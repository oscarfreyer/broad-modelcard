// A block or chapter rollup without children for the lens (CONTRACT.md §6,
// §13, V1). The API serves it as out of scope for parity, with the
// `out_of_scope_group` warning, `conservative_rollup_p20` for CDSS, and the
// Critical `scope-stop` safeguard. Those describe scope and an aggregate, and
// the data says neither: no condition under the group has a result for this
// population. The card and its exports present it as No data and leave them out.
import { isRollupWithoutChildren } from '../../../design/status.js';

const SCOPE_WARNINGS = new Set(['out_of_scope_group', 'conservative_rollup_p20']);
const SCOPE_SAFEGUARDS = new Set(['scope-stop']);

/** The warnings the card shows for a row: without the scope ones on a rollup without children. */
export function presentedWarnings(row, warnings = []) {
  return isRollupWithoutChildren(row) ? (warnings ?? []).filter((warning) => !SCOPE_WARNINGS.has(warning.code)) : warnings ?? [];
}

/** The safeguards the card shows for a row: without `scope-stop` on a rollup without children. */
export function presentedSafeguards(row, safeguards = []) {
  return isRollupWithoutChildren(row) ? (safeguards ?? []).filter((safeguard) => !SCOPE_SAFEGUARDS.has(safeguard.id)) : safeguards ?? [];
}
