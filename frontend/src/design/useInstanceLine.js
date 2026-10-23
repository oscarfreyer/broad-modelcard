import { useEffect, useState } from 'react';
import { useOptionalDataClientContext } from '../api/DataClientProvider.jsx';
import { IS_STATIC_BUILD } from '../shared/staticBuild.js';
import { instanceLine } from '../shared/instance.js';

/**
 * Who runs this copy (contract v1.13, §26), for Settings: "Public service,
 * maintained by …" or "Hospital version, <organisation>, administered by …".
 * The static demo names itself a snapshot without asking.
 */
export default function useInstanceLine() {
  const context = useOptionalDataClientContext();
  const cached = context?.cache.has('meta') ? context.cache.get('meta') : null;
  const [instance, setInstance] = useState(cached?.instance ?? null);
  useEffect(() => {
    if (IS_STATIC_BUILD || !context) return undefined;
    if (context.cache.has('meta')) {
      setInstance(context.cache.get('meta')?.instance ?? null);
      return undefined;
    }
    // The same read (and cache entry) as the pages' own /meta query.
    const controller = new AbortController();
    context.client.getMeta({}, { signal: controller.signal }).then(
      (meta) => {
        context.cache.set('meta', meta);
        if (!controller.signal.aborted) setInstance(meta?.instance ?? null);
      },
      () => {}
    );
    return () => controller.abort();
  }, [context]);
  return instanceLine(instance);
}
