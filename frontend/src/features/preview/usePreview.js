import { useCallback, useEffect, useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';

const POLL_MS = 10000;

/**
 * The staged upload an atlas preview shows (`?version=staged:<upload_id>`),
 * re-read on focus and every few seconds, so the banner notices when it was
 * published, replaced, or discarded elsewhere.
 *
 * phase: 'loading' | 'active' (valid, staged reads work) | 'checking' |
 * 'ended' (published, superseded, discarded, invalid) | 'missing' (unknown id)
 * | 'unreachable' (no answer yet).
 *
 * @param {string|null} uploadId
 */
export default function usePreview(uploadId) {
  const client = useDataClient();
  const [state, setState] = useState({ upload: null, error: null });

  const refresh = useCallback(async () => {
    if (!uploadId) {
      return;
    }
    try {
      const upload = await client.getUpload({ uploadId });
      setState((current) => (current.upload?.status === upload.status && current.upload?.previewed === upload.previewed && !current.error ? current : { upload, error: null }));
    } catch (error) {
      setState((current) => ({ ...current, error }));
    }
  }, [client, uploadId]);

  useEffect(() => {
    if (!uploadId) {
      return undefined;
    }
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh, uploadId]);

  if (!uploadId) {
    return null;
  }
  const { upload, error } = state;
  let phase;
  if (error?.code === 'unknown_upload') {
    phase = 'missing';
  } else if (!upload) {
    phase = error ? 'unreachable' : 'loading';
  } else if (upload.status === 'valid') {
    phase = 'active';
  } else if (upload.status === 'checking') {
    phase = 'checking';
  } else {
    phase = 'ended';
  }
  return { uploadId, upload, phase, refresh };
}
