import { useEffect } from 'react';
import useClientQuery from '../../api/useClientQuery.js';
import { stagedIncidentIds, validStagedUploadIds, withNextIncidentId } from './records.js';

/**
 * The incident IDs the safety form must not reuse, and the next free one for
 * a fresh form (audit A15): every stored incident's ID (all cards, live) and,
 * since audit batch 3, the IDs that staged, not yet published incidents
 * reserve, read from each valid staged safety upload's change summary.
 *
 * @param {object} props
 * @param {boolean} props.enabled the page has the incident form
 * @param {string|number} props.refreshKey the version the stored IDs are read for
 * @param {object|null} props.upload the page's staged upload
 * @param {object[]} props.stagedUploads every staged upload of the data set
 * @param {boolean} props.isRestoring the staged uploads are still being restored
 * @param {string|undefined} props.freshId the form's own fresh ID (a new form asks again)
 * @param {(update: (form: object) => object) => void} props.setIncident
 * @returns {string[]|null} the stored IDs, once read
 */
export default function useIncidentIds({ enabled, refreshKey, upload, stagedUploads, isRestoring, freshId, setIncident }) {
  const storedIncidents = useClientQuery(enabled ? `admin|incident-ids|${refreshKey}` : null, (client, options) => client.listIncidents({}, options));
  const storedIncidentIds = storedIncidents.data ? storedIncidents.data.incidents.map((entry) => entry.incident_id) : null;
  const stagedSafetyIds = enabled ? validStagedUploadIds(upload, stagedUploads) : [];
  const stagedSafetyKey = stagedSafetyIds.join(',');
  const stagedIncidents = useClientQuery(stagedSafetyKey ? `admin|staged-incident-ids|${stagedSafetyKey}` : null, async (client, options) => {
    const summaries = await Promise.all(
      stagedSafetyKey.split(',').map((uploadId) =>
        client.getUploadChanges({ uploadId }, options).catch((error) => {
          // An upload discarded or published meanwhile reserves nothing.
          if (error?.name === 'AbortError') throw error;
          return null;
        })
      )
    );
    return summaries.flatMap(stagedIncidentIds);
  });
  const stagedIncidentIdList = !stagedSafetyKey || stagedIncidents.error
    ? []
    : stagedIncidents.dataKey === `admin|staged-incident-ids|${stagedSafetyKey}` ? stagedIncidents.data : null;
  // Wait for the staged uploads to be restored, so a fresh form's ID does not change under the maintainer.
  const storedIdsKey = storedIncidentIds && stagedIncidentIdList && !isRestoring ? storedIncidentIds.join('|') : null;
  const stagedIdsKey = stagedIncidentIdList ? stagedIncidentIdList.join('|') : '';
  useEffect(() => {
    if (storedIdsKey === null) return;
    const split = (key) => (key ? key.split('|') : []);
    setIncident((form) => withNextIncidentId(form, [...split(storedIdsKey), ...split(stagedIdsKey)]));
    // setIncident is a state setter.
  }, [storedIdsKey, stagedIdsKey, freshId]);
  return storedIncidentIds;
}
