// Creates the app's data client. This is the only module that imports the
// adapters; entry points call it once. The static build for GitHub Pages
// reads the recorded snapshot instead of the backend API.
import { IS_STATIC_BUILD } from '../shared/staticBuild.js';
import { createApiAdapter } from './apiAdapter.js';
import { createDataClient } from './dataClient.js';
import { createStaticAdapter } from './staticAdapter.js';

/**
 * @param {object} [options]
 * @param {'live'|`staged:${string}`} [options.version] dataset version every read uses by default
 */
export function createAppDataClient({ version = 'live' } = {}) {
  if (IS_STATIC_BUILD) {
    return createDataClient(createStaticAdapter({ defaultVersion: version }));
  }
  return createDataClient(createApiAdapter({ defaultVersion: version }));
}
