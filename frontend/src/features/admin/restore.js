// Restoring a version from History (CONTRACT.md §11, Rollback).
//
// "Restore version n" undoes every later change by default ("Everything"),
// and the maintainer can narrow it to one data set. The page works out from
// History alone which data sets would change, so a restore that would change
// nothing is explained and blocked before anything is sent; the backend still
// refuses one (409 rollback_no_change) and the page says so in plain words.
//
// The API restores one data set per call (or every data set for a version
// that covers all, the initial import). "Everything" for any other version is
// therefore one call per data set that changes, each published as its own
// version, AI systems & functions first: a restore that brings back a
// function's metrics before its registry entry, or the other way round, can
// otherwise leave the registry with functions without metrics
// (rollback_conflict), so a data set refused that way is tried again after
// the others.

import { HISTORY_KINDS } from './datasets.js';
import { publisherFields } from './workspace.js';

export const EVERYTHING = 'all';

/**
 * The version whose content data set `kind` holds at version `upTo`: the
 * newest version up to it that changed the kind (or covered every kind),
 * followed through restores to the version they brought back. Two versions
 * with the same source hold the same data for that kind.
 *
 * @param {{ version_id: number, kind: string|null, rollback_of: number|null }[]} versions History, newest first
 * @param {number} upTo
 * @param {string} kind
 * @returns {number|null}
 */
export function kindSource(versions, upTo, kind) {
  for (const version of versions ?? []) {
    if (version.version_id > upTo || (version.kind !== kind && version.kind !== null)) continue;
    return version.rollback_of != null && version.rollback_of < version.version_id ? kindSource(versions, version.rollback_of, kind) : version.version_id;
  }
  return null;
}

/** The data sets a choice covers, in restore order (AI systems & functions first). */
function restoreKinds(choice) {
  if (!choice) return [];
  return choice === EVERYTHING ? [...HISTORY_KINDS] : [choice];
}

/**
 * What restoring version `versionId` with `choice` (a data set or
 * "Everything") would do:
 * - `kinds`: the data sets that would change, in restore order;
 * - `same`: the data sets of the choice that later versions changed but that
 *   already hold the data of version n again (a later restore brought it back);
 * - `undone`: the later versions it takes back, newest first, as History lists.
 *
 * @param {object[]} versions History, newest first
 * @param {number} versionId
 * @param {string|null} choice a DatasetKind, 'all', or null while none is chosen
 */
export function restorePlan(versions, versionId, choice) {
  const list = versions ?? [];
  const liveId = list.reduce((max, version) => Math.max(max, version.version_id), 0);
  const kinds = [];
  const same = [];
  restoreKinds(choice).forEach((kind) => {
    const later = list.some((version) => version.version_id > versionId && (version.kind === kind || version.kind === null));
    if (kindSource(list, liveId, kind) !== kindSource(list, versionId, kind)) {
      kinds.push(kind);
    } else if (later) {
      same.push(kind);
    }
  });
  const undone = kinds.length ? list.filter((version) => version.version_id > versionId && (version.kind === null || kinds.includes(version.kind))) : [];
  return { kinds, same, undone };
}

/**
 * Restores version `versionId` for each data set of `kinds` (from
 * restorePlan), one rollbackVersion call per data set, or one call that
 * restores every data set in one version when `allAtOnce` (every_kind, v1.11). A data set that
 * already matches (409 rollback_no_change) is skipped; one refused with
 * rollback_conflict is tried again once the others are restored.
 *
 * @param {{ rollbackVersion: Function }} client
 * @param {{ versionId: number, kinds: string[], note: string, allAtOnce?: boolean }} request
 * @returns {Promise<{ restored: object[], unchanged: string[], failed: { kind: string|null, error: Error }|null }>}
 */
export async function runRestore(client, { versionId, kinds, note, allAtOnce = false }) {
  const restored = [];
  const unchanged = [];
  if (allAtOnce) {
    try {
      restored.push(await client.rollbackVersion({ versionId, everyKind: true, note, ...publisherFields() }));
      return { restored, unchanged, failed: null };
    } catch (error) {
      return { restored, unchanged, failed: { kind: null, error } };
    }
  }
  let pending = [...kinds];
  while (pending.length) {
    const deferred = [];
    let lastConflict = null;
    for (const kind of pending) {
      try {
        restored.push(await client.rollbackVersion({ versionId, kind, note, ...publisherFields() }));
      } catch (error) {
        if (error?.code === 'rollback_no_change') {
          unchanged.push(kind);
        } else if (error?.code === 'rollback_conflict' && pending.length > 1) {
          deferred.push(kind);
          lastConflict = { kind, error };
        } else {
          return { restored, unchanged, failed: { kind, error } };
        }
      }
    }
    if (deferred.length === pending.length) {
      // No progress: every remaining data set conflicts with the others.
      return { restored, unchanged, failed: lastConflict };
    }
    pending = deferred;
  }
  return { restored, unchanged, failed: null };
}
