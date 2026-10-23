// Promise wrapper around the level-2 layout worker, with a main-thread
// fallback when workers are unavailable.
import { buildLevel2ModelFromPayload } from './level2Layout.js';

export function createLevel2LayoutClient() {
  const pending = new Map();
  let nextRequestId = 0;
  let worker = null;

  if (typeof Worker !== 'undefined') {
    worker = new Worker(new URL('./level2LayoutWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { requestId, model, error } = event.data || {};
      const request = pending.get(requestId);
      if (!request) {
        return;
      }
      pending.delete(requestId);
      if (error) {
        request.reject(new Error(error));
      } else {
        request.resolve(model);
      }
    };
  }

  return {
    /** @returns {Promise<object>} the chapter's circle layout model */
    compute(payload) {
      if (!worker) {
        return new Promise((resolve, reject) => {
          window.setTimeout(() => {
            try {
              resolve(buildLevel2ModelFromPayload(payload));
            } catch (error) {
              reject(error);
            }
          }, 0);
        });
      }
      nextRequestId += 1;
      const requestId = nextRequestId;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        worker.postMessage({ requestId, payload });
      });
    },
    /** Stops the worker; pending layouts never settle. */
    terminate() {
      worker?.terminate();
      pending.clear();
    }
  };
}
