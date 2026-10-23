// Vite's /api proxy in front of the real backend: the app's own
// pages pass the backend's local-only guard (CONTRACT.md §16), every other
// origin (another site, or another page on localhost) does not and gets no
// CORS headers, and a stopped backend becomes a readable 503
// backend_unavailable problem.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { freePort, startTestBackend } from './support/backend.js';

const CONFIG = fileURLToPath(new URL('../frontend/vite.config.js', import.meta.url));

let backend;
let vite;
let origin;

async function startVite(apiPort) {
  process.env.BMC_API_PORT = String(apiPort);
  const port = await freePort();
  const server = await createServer({
    configFile: CONFIG,
    logLevel: 'silent',
    server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }
  });
  await server.listen();
  return { server, origin: `http://localhost:${port}`, port };
}

/** Raw HTTP request, so the Host header can be set (fetch forbids it). */
function rawRequest({ port, path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const FOREIGN = 'http://localhost:3000';
const LOOKUP = JSON.stringify({
  context: { card: { model_version: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS' }, conditions: [{ code: '5A11' }] }
});

/** The requests a foreign page could try: admin reads, JSON, bodyless, multipart, and form writes, and the lookup. */
function attempts() {
  const form = new FormData();
  form.append('kind', 'metrics');
  form.append('file', new File(['x\n'], 'metrics.csv', { type: 'text/csv' }));
  const json = (method, body) => ({ method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return [
    ['GET /admin/assist', '/api/v1/admin/assist', { method: 'GET' }],
    ['PUT /admin/assist', '/api/v1/admin/assist', json('PUT', { provider: 'hosted', model: 'claude-opus-5-5' })],
    ['POST rollback', '/api/v1/admin/versions/1/rollback', { method: 'POST' }],
    ['POST /admin/uploads', '/api/v1/admin/uploads', { method: 'POST', body: form }],
    ['POST population remove', '/api/v1/admin/populations/x/remove', json('POST', { note: 'x' })],
    ['POST /lookup', '/api/v1/lookup', { method: 'POST', body: LOOKUP, headers: { 'Content-Type': 'application/json' } }]
  ];
}

async function assertRefused(response, label) {
  assert.equal(response.status, 403, label);
  assert.equal((await response.json()).code, 'local_only', label);
  const cors = [...response.headers.keys()].filter((name) => name.startsWith('access-control-'));
  assert.deepEqual(cors, [], `${label}: no CORS headers for a foreign origin`);
}

before(async () => {
  backend = await startTestBackend({ fresh: true });
  vite = await startVite(backend.port);
  origin = vite.origin;
});
after(async () => {
  await vite?.server.close();
  await backend?.stop();
});

test('reads through the proxy pass the local-only guard', async () => {
  const response = await fetch(`${origin}/api/v1/meta`, { headers: { Origin: origin } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('x-dataset-version'), /^\d+$/);
  assert.equal((await response.json()).api_version, '1');
});

test('admin requests from the app origin reach the backend', async () => {
  const listing = await fetch(`${origin}/api/v1/admin/datasets`, { headers: { Origin: origin } });
  assert.equal(listing.status, 200);
  // A POST carries the page's Origin; an incomplete form is the backend's 422, not the guard's 403.
  const form = new FormData();
  form.append('kind', 'metrics');
  form.append('file', new File(['x\n'], 'metrics.csv', { type: 'text/csv' }));
  const upload = await fetch(`${origin}/api/v1/admin/uploads`, { method: 'POST', body: form, headers: { Origin: origin } });
  assert.equal(upload.status, 422);
  assert.equal((await upload.json()).code, 'invalid_parameter');
});

test('cross-site Origins and foreign Host names are refused with 403 local_only', async () => {
  const crossSite = await fetch(`${origin}/api/v1/admin/versions/1/rollback`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).code, 'local_only');

  // Vite's own host check answers first ("Blocked request"); the backend guard is the second layer.
  const rebinding = await rawRequest({ port: vite.port, path: '/api/v1/meta', headers: { Host: `evil.example:${vite.port}` } });
  assert.equal(rebinding.status, 403);
  assert.ok(/Blocked request/.test(rebinding.body) || JSON.parse(rebinding.body).code === 'local_only', rebinding.body);
  const direct = await rawRequest({ port: backend.port, path: '/api/v1/meta', headers: { Host: `evil.example:${backend.port}` } });
  assert.equal(direct.status, 403);
  assert.equal(JSON.parse(direct.body).code, 'local_only');

  const loopbackHost = await rawRequest({ port: vite.port, path: '/api/v1/meta', headers: { Host: `127.0.0.1:${vite.port}` } });
  assert.equal(loopbackHost.status, 200);
});

test('another page on localhost cannot read admin state or write, through the proxy or directly', async () => {
  for (const base of [origin, backend.origin]) {
    for (const [label, path, init] of attempts()) {
      const response = await fetch(`${base}${path}`, { ...init, headers: { ...init.headers, Origin: FOREIGN } });
      await assertRefused(response, `${label} via ${base}`);
    }
    // Fetch metadata alone also refuses a cross-site write.
    const sameSite = await fetch(`${base}/api/v1/lookup`, {
      method: 'POST',
      body: LOOKUP,
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' }
    });
    await assertRefused(sameSite, `same-site lookup via ${base}`);
  }
  const preflight = await fetch(`${origin}/api/v1/lookup`, {
    method: 'OPTIONS',
    headers: { Origin: FOREIGN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
  });
  await assertRefused(preflight, 'preflight via the proxy');
  // Vite itself sends no CORS headers either (server.cors: false).
  const page = await fetch(`${origin}/index.html`, { headers: { Origin: FOREIGN } });
  assert.equal(page.headers.get('access-control-allow-origin'), null);
});

test("the app's own same-origin requests still pass", async () => {
  const own = { Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const assist = await fetch(`${origin}/api/v1/admin/assist`, { headers: own });
  assert.equal(assist.status, 200);
  const lookup = await fetch(`${origin}/api/v1/lookup`, { method: 'POST', body: LOOKUP, headers: { ...own, 'Content-Type': 'application/json' } });
  assert.equal(lookup.status, 200);
  assert.equal((await lookup.json()).conditions.length, 1);
  const remove = await fetch(`${origin}/api/v1/admin/populations/x/remove`, {
    method: 'POST',
    body: JSON.stringify({ note: 'x' }),
    headers: { ...own, 'Content-Type': 'application/json' }
  });
  assert.equal(remove.status, 404, 'the route answers, not the guard');
  // The same page reached as 127.0.0.1 is its own origin as well.
  const loopback = await rawRequest({
    port: vite.port,
    path: '/api/v1/lookup',
    method: 'POST',
    headers: { Host: `127.0.0.1:${vite.port}`, Origin: `http://127.0.0.1:${vite.port}`, 'Content-Type': 'application/json' },
    body: LOOKUP
  });
  assert.equal(loopback.status, 200, loopback.body);
});

test('dev and preview servers share the proxy', async () => {
  const { config } = vite.server;
  assert.equal(config.server.proxy['/api'].target, `http://127.0.0.1:${backend.port}`);
  assert.equal(config.preview.proxy['/api'].target, `http://127.0.0.1:${backend.port}`);
  assert.equal(config.server.proxy['/api'].changeOrigin, false, 'the browser Host and Origin reach the guard');
  assert.equal(config.server.cors, false, 'the dev server sends no CORS headers');
  assert.equal(config.preview.cors, false, 'the preview server sends no CORS headers');
  assert.equal(config.publicDir, '', 'no static data directory is served');
});

test('a stopped backend answers 503 backend_unavailable through the proxy', async () => {
  const port = await freePort();
  const orphan = await startVite(port);
  try {
    const response = await fetch(`${orphan.origin}/api/v1/meta`);
    assert.equal(response.status, 503);
    assert.match(response.headers.get('content-type'), /problem\+json/);
    const problem = await response.json();
    assert.equal(problem.code, 'backend_unavailable');
    assert.match(problem.detail, /npm run dev/);
  } finally {
    await orphan.server.close();
  }
});
