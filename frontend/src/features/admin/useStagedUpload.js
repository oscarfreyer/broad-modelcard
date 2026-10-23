import { useCallback, useEffect, useRef, useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import { populationUploadFields } from './populations.js';
import { publisherFields } from './workspace.js';

const POLL_MS = 400;

/** Statuses of an upload that is no longer staged (CONTRACT.md UploadStatus). */
const GONE_STATUSES = new Set(['published', 'discarded', 'superseded']);

function sameTarget(upload, target) {
  if (!target) {
    return !upload.target;
  }
  if (target.populationId) {
    return upload.target?.population_id === target.populationId;
  }
  if (target.localPopulationId) {
    // Local results (contract v1.13): a card and a local population.
    return upload.target?.model_version === target.model && upload.target?.use_case === target.useCase && upload.target?.population_id === target.localPopulationId;
  }
  return upload.target?.model_version === target.model && upload.target?.use_case === target.useCase;
}

/** The key of a target: a card, a local population (contract v1.10), or none. */
function targetKeyOf(target) {
  if (!target) return '';
  if (target.populationId) return `population:${target.populationId}`;
  return target.localPopulationId ? `${target.model}|${target.useCase}|${target.localPopulationId}` : `${target.model}|${target.useCase}`;
}

/**
 * The update in progress for one data set (and, for metrics and
 * multimorbidity, one model × use case): the staged upload restored from the
 * server, the check's progress, the change summary, and the actions that
 * move it on. Nothing here changes live data until `publish`.
 *
 * @param {object} options
 * @param {string} options.kind
 * @param {{ model: string, useCase: string }|{ populationId: string, populationName: string, isLive: boolean }|null} options.target
 *   the card of a metrics or multimorbidity update, or the local population of a population update; null for the other data sets
 * @param {string[]} options.stagedIds the data set's staged upload ids (listDatasets)
 * @param {() => void} options.onLibraryChange reload the library after a change
 */
export default function useStagedUpload({ kind, target, stagedIds, onLibraryChange }) {
  const client = useDataClient();
  const [upload, setUpload] = useState(null);
  const [changes, setChanges] = useState(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [busy, setBusy] = useState(null); // 'uploading' | 'publishing' | 'discarding' | 'rolling-back'
  const [problem, setProblem] = useState(null);
  const [pendingReplace, setPendingReplace] = useState(null); // { file, existing }
  const [published, setPublished] = useState(null); // VersionEntry of a publish in this session
  const [publishedChanges, setPublishedChanges] = useState(null); // its change summary
  const [rolledBack, setRolledBack] = useState(null); // VersionEntry of a rollback in this session
  const [stagedUploads, setStagedUploads] = useState([]); // every staged upload of the data set
  const [discarded, setDiscarded] = useState(null); // { token, upload } of a discard in this session
  const targetKey = targetKeyOf(target);
  const stagedKey = (stagedIds ?? []).join(',');
  const discardingId = useRef(null); // the upload a discard request is removing
  const library = useRef(onLibraryChange);
  library.current = onLibraryChange;

  // A new data set or target starts a new session.
  useEffect(() => {
    setPublished(null);
    setRolledBack(null);
    setDiscarded(null);
    setProblem(null);
    setPendingReplace(null);
    setUpload(null);
    setIsRestoring(true);
  }, [kind, targetKey]);

  // Restore the staged upload of this data set (and target) from the server.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const ids = stagedKey ? stagedKey.split(',') : [];
        const uploads = await Promise.all(ids.map((uploadId) => client.getUpload({ uploadId }, { signal: controller.signal })));
        if (!controller.signal.aborted) {
          setStagedUploads(uploads);
          const found = uploads.find((entry) => sameTarget(entry, target)) ?? null;
          setUpload((previous) =>
            previous && found && previous.upload_id === found.upload_id && previous.status === found.status && previous.previewed === found.previewed
              ? previous
              : found
          );
        }
      } catch (error) {
        if (!controller.signal.aborted && error?.name !== 'AbortError') {
          setProblem(error);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsRestoring(false);
        }
      }
    })();
    return () => controller.abort();
    // targetKey stands for target, which is a new object on every render.
  }, [client, kind, targetKey, stagedKey]);

  // Follow the check while it runs.
  const uploadId = upload?.upload_id ?? null;
  const status = upload?.status ?? null;
  useEffect(() => {
    if (status !== 'checking' || !uploadId) {
      return undefined;
    }
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      try {
        const next = await client.getUpload({ uploadId });
        if (cancelled) return;
        // A discard of this upload is running: its status is no longer news.
        // Ask again later, in case the discard fails and the check goes on.
        if (discardingId.current === uploadId) {
          timer = window.setTimeout(poll, POLL_MS);
          return;
        }
        if (GONE_STATUSES.has(next.status)) {
          setUpload((current) => (current?.upload_id === uploadId ? null : current));
          library.current?.();
          return;
        }
        setUpload(next);
        if (next.status === 'checking') {
          timer = window.setTimeout(poll, POLL_MS);
        } else {
          library.current?.();
        }
      } catch (error) {
        if (!cancelled) {
          setProblem(error);
          timer = window.setTimeout(poll, POLL_MS * 5);
        }
      }
    };
    timer = window.setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, status, uploadId]);

  // The change summary, once the check passed.
  useEffect(() => {
    if (status !== 'valid' || !uploadId) {
      setChanges(null);
      return undefined;
    }
    const controller = new AbortController();
    setChanges(null);
    client.getUploadChanges({ uploadId }, { signal: controller.signal }).then(
      (summary) => setChanges(summary),
      (error) => {
        if (error?.name !== 'AbortError') setProblem(error);
      }
    );
    return () => controller.abort();
  }, [client, status, uploadId]);

  const refreshUpload = useCallback(async () => {
    if (!uploadId) return;
    try {
      setUpload(await client.getUpload({ uploadId }));
    } catch (error) {
      setProblem(error);
    }
  }, [client, uploadId]);

  /**
   * Stages an update: a file (`{ file, mode }`, mode 'replace' or 'merge') or
   * records (`{ records }` from a one-record form or the study helper, always
   * a merge); `onCreated` hears of the new upload, also after the replace
   * prompt. A 409
   * staged_upload_exists keeps the payload in `pendingReplace` for the
   * replace prompt; `replaceStaged` replaces the waiting update.
   */
  const send = useCallback(
    async (payload, replaceStaged) => {
      setBusy('uploading');
      setProblem(null);
      setPublished(null);
      setRolledBack(null);
      setDiscarded(null);
      try {
        const common = target?.populationId
          ? { kind, ...populationUploadFields(target), replaceStaged }
          : { kind, modelVersion: target?.model, useCase: target?.useCase, populationId: target?.localPopulationId, replaceStaged };
        const created = payload.records
          ? await client.createRecordsUpload({ ...common, records: payload.records })
          : await client.createUpload({ ...common, file: payload.file, mode: payload.mode });
        setPendingReplace(null);
        setUpload(created);
        payload.onCreated?.(created);
        library.current?.();
        return created;
      } catch (error) {
        if (error?.code === 'staged_upload_exists') {
          setPendingReplace({ ...payload, existing: upload });
        } else {
          setProblem(error);
        }
        return null;
      } finally {
        setBusy(null);
      }
    },
    [client, kind, target, upload]
  );

  /**
   * Discards the staged update, whatever its check status (checking,
   * invalid, or valid; the backend accepts each). Resolves to true when the
   * update is gone (also when it was already gone: `upload_not_staged`,
   * whose notice stays), and records it in `discarded`; false after any
   * other failure, which stays in `problem` with the update kept.
   */
  const discard = useCallback(async () => {
    // Nothing to discard, or another request (an upload, a publish) is running.
    if (!uploadId || busy) return false;
    const gone = upload;
    discardingId.current = uploadId;
    setBusy('discarding');
    setProblem(null);
    // Only the discarded upload leaves the page; one staged meanwhile stays.
    const removed = () => {
      setUpload((current) => (current?.upload_id === uploadId ? null : current));
      setDiscarded({ token: Date.now(), upload: gone });
      library.current?.();
    };
    try {
      await client.discardUpload({ uploadId });
      removed();
      return true;
    } catch (error) {
      setProblem(error);
      discardingId.current = null;
      if (error?.code === 'upload_not_staged') {
        removed();
        return true;
      }
      return false;
    } finally {
      setBusy(null);
    }
  }, [busy, client, upload, uploadId]);

  /**
   * Publishes with the maintainer's change note (contract v1.7; the Data
   * Library always sends one). Resolves to the new VersionEntry, or null
   * after a problem (kept in `problem`).
   */
  const publish = useCallback(async (note) => {
    if (!uploadId) return null;
    setBusy('publishing');
    setProblem(null);
    try {
      const entry = await client.publishUpload({ uploadId, previewed: Boolean(upload?.previewed), note, ...publisherFields() });
      setPublishedChanges(changes);
      setPublished(entry);
      setDiscarded(null);
      setUpload(null);
      library.current?.();
      return entry;
    } catch (error) {
      setProblem(error);
      if (error?.code === 'upload_not_valid' || error?.code === 'upload_outdated') {
        refreshUpload();
      }
      // Another publish may have taken the next version number meanwhile.
      library.current?.();
      return null;
    } finally {
      setBusy(null);
    }
  }, [changes, client, refreshUpload, upload?.previewed, uploadId]);

  /** Restores this data set to `versionId` as a new version, with a change note. */
  const rollback = useCallback(
    async (versionId, note) => {
      setBusy('rolling-back');
      setProblem(null);
      setDiscarded(null);
      try {
        const entry = await client.rollbackVersion({ versionId, kind, note, ...publisherFields() });
        setRolledBack(entry);
        library.current?.();
        return entry;
      } catch (error) {
        setProblem(error);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [client, kind]
  );

  return {
    upload,
    stagedUploads,
    changes,
    isRestoring,
    busy,
    problem,
    clearProblem: () => setProblem(null),
    pendingReplace,
    cancelReplace: () => setPendingReplace(null),
    published,
    publishedChanges,
    rolledBack,
    discarded,
    send,
    discard,
    publish,
    rollback,
    refreshUpload
  };
}
