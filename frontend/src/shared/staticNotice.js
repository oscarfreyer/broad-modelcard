// The words of the static demo's band, React-free so the
// tests can read them.

const RECORDED = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "ICD-11", "ICD-11 and MONDO", "ICD-11, MONDO, and ICD-10-CM". */
function listWords(items) {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * @param {{ release_version?: string, dataset_version: string, recorded_at: string, ontologies?: string[], has_settings?: boolean }|null} snapshot
 * @returns {{ title: string, detail: string }}
 */
export function staticNoticeText(snapshot) {
  const recorded = snapshot?.recorded_at ? new Date(snapshot.recorded_at) : null;
  const when = recorded && !Number.isNaN(recorded.getTime()) ? `, recorded ${RECORDED.format(recorded)}` : '';
  const release = snapshot?.release_version ? ` of release ${snapshot.release_version}` : '';
  const version = snapshot?.dataset_version ? `${release ? ',' : ' of'} dataset version ${snapshot.dataset_version}` : '';
  const others = (snapshot?.ontologies ?? []).filter((name) => name !== 'ICD-11');
  const classifications = others.length ? ` ${listWords(others)} for all patients,` : '';
  // Release 0.5 (Q9): the care settings each card stores, recorded for all patients.
  const settings = snapshot?.has_settings ? ' stored care settings for all patients,' : '';
  return {
    title: 'Static synthetic demo',
    detail: `A read-only snapshot${release}${version}${when}: all patients or one population group at a time,${settings}${classifications} default prevalence, no Data Library. Not for clinical use.`
  };
}
