import { buildLevel2ModelFromPayload } from './level2Layout.js';

self.onmessage = (event) => {
  const { requestId, payload } = event.data || {};
  if (!Number.isFinite(requestId) || !payload) {
    return;
  }

  try {
    const model = buildLevel2ModelFromPayload(payload);
    self.postMessage({ requestId, model });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ requestId, error: message });
  }
};
