// The /api proxy shared by Vite's dev and preview servers: forwards to the
// backend on 127.0.0.1 (CONTRACT.md §16). The proxy keeps the browser's Host
// and Origin headers (no changeOrigin), so the backend's local-only guard
// sees the dev server's own origin (Origin = scheme://Host) for the app's
// pages and refuses every other page, including other localhost ports.

export const DEFAULT_API_PORT = 8000;

export function apiPort(env = process.env) {
  const port = Number(env.BMC_API_PORT || DEFAULT_API_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_API_PORT;
}

/** problem+json body for a backend that is not running (Problem code backend_unavailable). */
export function backendUnavailableProblem(port) {
  return {
    type: 'urn:broad-modelcard:problem:backend_unavailable',
    title: 'The Broad Modelcard backend is not running',
    status: 503,
    code: 'backend_unavailable',
    detail: `Nothing answers on 127.0.0.1:${port}. Start the app with \`npm run dev\` (or \`npm run preview\`), which starts the backend too.`
  };
}

/** Vite `server.proxy` / `preview.proxy` entry. */
export function apiProxy({ port = apiPort() } = {}) {
  return {
    '/api': {
      target: `http://127.0.0.1:${port}`,
      changeOrigin: false,
      xfwd: false,
      configure(proxy) {
        // Runs before Vite's own handler, which would answer a bare 500.
        proxy.on('error', (_error, _request, response) => {
          if (!response || typeof response.writeHead !== 'function' || response.headersSent || response.writableEnded) {
            return;
          }
          response.writeHead(503, { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify(backendUnavailableProblem(port)));
        });
      }
    }
  };
}
