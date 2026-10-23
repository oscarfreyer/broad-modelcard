// The live panel's data client: the app's own adapter and client (api/), so
// the panel reaches the backend exactly like the app does (lookup and /meta,
// contract v1.8) and tests/frontendBoundary.test.js keeps one module that
// calls fetch. This is the panel's entry into the data layer (like
// appDataClient.js for the pages): it takes the element's `api-base` instead
// of the fixed /api/v1.
import { createApiAdapter } from '../api/apiAdapter.js';
import { createDataClient } from '../api/dataClient.js';

/**
 * @param {string} apiBase the API root, e.g. /api/v1 (same origin: the API sends no CORS headers)
 * @returns {Readonly<{ lookup: Function, getMeta: Function }>}
 */
export function createPanelClient(apiBase) {
  return createDataClient(createApiAdapter({ baseUrl: apiBase }));
}
