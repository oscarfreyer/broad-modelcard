// Whether this is the static, read-only build for GitHub Pages: `vite build --mode static` defines __BMC_STATIC__ as true and
// __BMC_STATIC_SNAPSHOT__ as the recorded snapshot's manifest summary
// (frontend/vite.config.js). Every other build defines them as false and
// null, so the static-only code drops out of it; under node --test they are
// undefined, which reads as the normal build.
/* global __BMC_STATIC__, __BMC_STATIC_SNAPSHOT__ */

export const IS_STATIC_BUILD = typeof __BMC_STATIC__ !== 'undefined' && __BMC_STATIC__ === true;

/**
 * The snapshot the static build carries, or null outside it.
 *
 * @type {{ dataset_version: string, recorded_at: string, lens_count: number, card_count: number }|null}
 */
export const STATIC_SNAPSHOT = IS_STATIC_BUILD && typeof __BMC_STATIC_SNAPSHOT__ !== 'undefined' ? __BMC_STATIC_SNAPSHOT__ : null;
