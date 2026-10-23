import { useEffect, useRef } from 'react';
import { useDataClient, useResetDataCache } from '../api/DataClientProvider.jsx';
import { createVersionWatch } from '../shared/versionWatch.js';

/**
 * The shared version watch (shared/versionWatch.js) for a React view: polls
 * /meta every 5 minutes and on focus or visibility, and when the live
 * dataset version changed, drops every cached response so the view reads
 * again, then calls `onChange`. Staged previews follow live changes too
 * (CONTRACT.md §2), so the same reset applies to them.
 *
 * @param {object} [options]
 * @param {string|null} [options.knownVersion] the live version on screen, when the view's own data names it
 *   (the catalogue): then nothing is requested on load, and the watch learns the version from the data
 * @param {boolean} [options.checkOnStart] default true unless `knownVersion` is given
 * @param {(version: string, previous: string) => void} [options.onChange]
 * @param {() => void} [options.onTrigger] on every focus or visibility trigger (e.g. retry failed reads or re-read a preview)
 * @param {boolean} [options.enabled] default true
 */
export default function useVersionWatch({ knownVersion, checkOnStart, onChange, onTrigger, enabled = true } = {}) {
  const client = useDataClient();
  const resetCache = useResetDataCache();
  const callbacks = useRef({ onChange, onTrigger });
  callbacks.current = { onChange, onTrigger };
  const watchRef = useRef(null);
  const usesKnownVersion = knownVersion !== undefined;
  const startCheck = checkOnStart ?? !usesKnownVersion;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const watch = createVersionWatch({
      readVersion: async () => (await client.getMeta({}, { version: 'live' })).dataset_version,
      onChange: (version, previous) => {
        resetCache();
        callbacks.current.onChange?.(version, previous);
      },
      onTrigger: () => callbacks.current.onTrigger?.(),
      checkOnStart: startCheck
    });
    watchRef.current = watch;
    watch.start();
    return () => {
      watch.stop();
      watchRef.current = null;
    };
  }, [client, enabled, resetCache, startCheck]);

  // The view's own data names the version on screen: the watch compares with that.
  useEffect(() => {
    if (usesKnownVersion && knownVersion != null) {
      watchRef.current?.setKnownVersion(knownVersion);
    }
  }, [knownVersion, usesKnownVersion, enabled]);
}
