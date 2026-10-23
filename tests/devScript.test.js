// scripts/dev.mjs (`npm run dev`, `npm run preview`, `npm run api`): starts
// the backend and Vite together, explains a missing store, and stops both.
// It reuses a running backend only when this checkout started it (the
// backend/data/dev-api-<port>.json marker), never one from another checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backendPlan,
  devMarkerPath,
  pidAlive,
  readDevMarker,
  removeDevMarker,
  storePath,
  writeDevMarker
} from '../scripts/backendServer.mjs';
import { freePort } from './support/backend.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function runDev(args, env = {}) {
  const child = spawn(process.execPath, ['scripts/dev.mjs', ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => output };
}

async function answers(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return null;
  }
}

async function until(check, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/** A stand-in Broad Modelcard API (answers /api/v1/meta) on a free port, e.g. another checkout's backend. */
async function fakeApi() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ api_version: '1', dataset_version: '7' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

/** The pid of a process that has already exited. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

test('backendPlan reuses only a live backend that this checkout started on the same store', () => {
  const store = '/repo/backend/data/broad_modelcard.sqlite';
  const marker = { port: 8000, pid: 42, store };
  const alive = () => true;
  const dead = () => false;
  assert.equal(backendPlan('none', marker, { store, isAlive: alive }), 'start');
  assert.equal(backendPlan('none', null, { store }), 'start');
  assert.equal(backendPlan('other', marker, { store, isAlive: alive }), 'taken');
  assert.equal(backendPlan('ours', marker, { store, isAlive: alive }), 'reuse');
  assert.equal(backendPlan('ours', null, { store, isAlive: alive }), 'foreign', 'no marker: another checkout');
  assert.equal(backendPlan('ours', marker, { store, isAlive: dead }), 'foreign', 'stale marker');
  assert.equal(backendPlan('ours', marker, { store: '/other.sqlite', isAlive: alive }), 'other-store');
});

test('markers are written, read per port, and removed only by their owner', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bmc-marker-'));
  const nested = path.join(dir, 'nested');
  try {
    assert.equal(readDevMarker(8123, dir), null);
    const written = writeDevMarker({ port: 8123, pid: process.pid, store: '/s.sqlite' }, nested);
    assert.match(written.started_at, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(readDevMarker(8123, nested), written);
    assert.equal(readDevMarker(8124, nested), null, 'a marker names one port');
    assert.equal(removeDevMarker(8123, { pid: process.pid + 1, dir: nested }), false);
    assert.ok(existsSync(devMarkerPath(8123, nested)), 'another pid leaves the marker');
    assert.equal(removeDevMarker(8123, { pid: process.pid, dir: nested }), true);
    assert.equal(readDevMarker(8123, nested), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(await deadPid()), false);
  assert.equal(pidAlive(undefined), false);
});

test('an API from another checkout is refused, with or without markers for other ports', async () => {
  const api = await fakeApi();
  const otherPort = await freePort();
  writeDevMarker({ port: otherPort, pid: process.pid, store: storePath() });
  try {
    const run = runDev(['api'], { BMC_API_PORT: String(api.port) });
    const { code } = await run.exited;
    assert.equal(code, 1, run.output());
    assert.match(run.output(), new RegExp(`Port ${api.port} is used by a Broad Modelcard API from another checkout or session`));
    assert.match(run.output(), /choose a free port: BMC_API_PORT=\d+ npm run api/);
    assert.doesNotMatch(run.output(), /Using the Broad Modelcard API/);
    assert.equal(readDevMarker(api.port), null, 'no marker is written for a refused port');
  } finally {
    removeDevMarker(otherPort);
    await api.close();
  }
});

test('a backend that this checkout started is reused and left running', async () => {
  const api = await fakeApi();
  writeDevMarker({ port: api.port, pid: process.pid, store: storePath() });
  try {
    const run = runDev(['api'], { BMC_API_PORT: String(api.port) });
    const { code } = await run.exited;
    assert.equal(code, 0, run.output());
    assert.match(run.output(), new RegExp(`Using the Broad Modelcard API that this checkout started on 127\\.0\\.0\\.1:${api.port} \\(pid ${process.pid}\\)`));
    assert.equal(readDevMarker(api.port)?.pid, process.pid, 'the reusing run keeps the owner marker');
  } finally {
    removeDevMarker(api.port);
    await api.close();
  }
});

test('a backend from this checkout on another store is refused', async () => {
  const api = await fakeApi();
  writeDevMarker({ port: api.port, pid: process.pid, store: '/elsewhere/other.sqlite' });
  try {
    const run = runDev(['api'], { BMC_API_PORT: String(api.port) });
    const { code } = await run.exited;
    assert.equal(code, 1, run.output());
    assert.match(run.output(), /from this checkout \(pid \d+\) that serves another store, \/elsewhere\/other\.sqlite/);
  } finally {
    removeDevMarker(api.port);
    await api.close();
  }
});

test('a stale marker (dead pid) does not make a foreign API ours, and is removed', async () => {
  const api = await fakeApi();
  writeDevMarker({ port: api.port, pid: await deadPid(), store: storePath() });
  try {
    const run = runDev(['api'], { BMC_API_PORT: String(api.port) });
    const { code } = await run.exited;
    assert.equal(code, 1, run.output());
    assert.match(run.output(), /from another checkout or session/);
    assert.equal(existsSync(devMarkerPath(api.port)), false, 'the stale marker is gone');
  } finally {
    removeDevMarker(api.port);
    await api.close();
  }
});

test('a missing store prints the one-line import command', async () => {
  const apiPort = await freePort();
  const run = runDev(['api'], { BMC_API_PORT: String(apiPort), BMC_DB: 'data/no-such-store.sqlite' });
  const { code } = await run.exited;
  assert.equal(code, 1);
  assert.match(run.output(), /cd backend && \.venv\/bin\/python -m app\.importers\.legacy_json/);
});

test('npm run dev starts the backend and Vite, proxies /api, and stops both', async () => {
  const [apiPort, vitePort] = [await freePort(), await freePort()];
  const stalePid = await deadPid();
  writeDevMarker({ port: apiPort, pid: stalePid, store: storePath() });
  const run = runDev(['dev', '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { BMC_API_PORT: String(apiPort) });
  try {
    const ready = await until(async () => (await answers(`http://127.0.0.1:${vitePort}/api/v1/meta`)) === 200);
    assert.ok(ready, `not ready:\n${run.output()}`);
    assert.equal(await answers(`http://127.0.0.1:${apiPort}/api/v1/meta`), 200, 'the backend listens on its own port');
    assert.match(run.output(), /Backend ready on http:\/\/127\.0\.0\.1:\d+\/api\/v1/);

    const marker = readDevMarker(apiPort);
    assert.ok(marker && marker.pid !== stalePid && pidAlive(marker.pid), 'the stale marker is replaced by the new backend');
    assert.equal(marker.store, storePath());

    // A second run in this checkout reuses the backend and leaves it running.
    const second = runDev(['api'], { BMC_API_PORT: String(apiPort) });
    assert.equal((await second.exited).code, 0, second.output());
    assert.match(second.output(), new RegExp(`Using the Broad Modelcard API that this checkout started .* \\(pid ${marker.pid}\\)`));
    assert.equal(await answers(`http://127.0.0.1:${apiPort}/api/v1/meta`), 200);
    assert.equal(readDevMarker(apiPort)?.pid, marker.pid);
  } finally {
    run.child.kill('SIGTERM');
  }
  await run.exited;
  assert.equal(await answers(`http://127.0.0.1:${apiPort}/api/v1/meta`), null, 'the backend stopped');
  assert.equal(await answers(`http://127.0.0.1:${vitePort}/`), null, 'Vite stopped');
  assert.equal(existsSync(devMarkerPath(apiPort)), false, 'the marker is removed on exit');
  removeDevMarker(apiPort);
});
