// The instance line (CONTRACT.md §26): one quiet line that says
// who runs this copy of Broad Modelcard. React-free for the tests and the
// model card. The static demo is a snapshot of the public demonstration.
import { IS_STATIC_BUILD } from './staticBuild.js';

export const STATIC_INSTANCE_LINE = 'Public service (demonstration snapshot)';

/**
 * "Public service, maintained by the Broad Modelcard project" or
 * "Hospital version, Northbridge General, administered by the AI office"
 * (no dot separators).
 *
 * @param {{ kind: 'public'|'hospital', organisation: string, maintained_by: string }|null|undefined} instance /meta.instance
 * @param {{ isStatic?: boolean }} [options]
 * @returns {string} '' while unknown
 */
export function instanceLine(instance, { isStatic = IS_STATIC_BUILD } = {}) {
  if (isStatic) return STATIC_INSTANCE_LINE;
  if (!instance) return '';
  const by = String(instance.maintained_by ?? '').trim();
  if (instance.kind === 'hospital') {
    return ['Hospital version', String(instance.organisation ?? '').trim(), by ? `administered by ${by}` : ''].filter(Boolean).join(', ');
  }
  return by ? `Public service, maintained by ${by}` : 'Public service';
}
