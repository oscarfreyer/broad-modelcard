// Test helpers: a real backend for end-to-end tests and the data client on top
// of it. Each test file (node --test runs one process per file) starts its own
// backend on a free port, unless BMC_TEST_API_URL names one that is already
// running. The backend reads BMC_DB when it is set; otherwise a private copy
// of backend/data/broad_modelcard.sqlite, so the tests never open (and never
// migrate) the developer's own store. Tests that publish get a private copy of
// the store (`copyStore`).
import { copyFileSync, constants, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApiAdapter } from '../../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../../frontend/src/api/dataClient.js';
import { setupProblem, spawnBackend, stopProcess, storePath, waitForBackend } from '../../scripts/backendServer.mjs';

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A private copy of the store (copy-on-write where the file system allows), removed by `dispose()`. */
export function copyStore() {
  const source = storePath();
  const dir = mkdtempSync(path.join(tmpdir(), 'bmc-store-'));
  const target = path.join(dir, 'broad_modelcard.sqlite');
  copyFileSync(source, target, constants.COPYFILE_FICLONE);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(source + suffix)) {
      copyFileSync(source + suffix, target + suffix, constants.COPYFILE_FICLONE);
    }
  }
  return { path: target, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Starts a backend and resolves to `{ origin, port, stop }`.
 *
 * @param {object} [options]
 * @param {string} [options.db] store file (default: BMC_DB, else a private copy of the developer store)
 * @param {boolean} [options.fresh] always start a new process (ignores BMC_TEST_API_URL)
 */
export async function startTestBackend({ db, fresh = false } = {}) {
  if (process.env.BMC_TEST_API_URL && !db && !fresh) {
    const origin = process.env.BMC_TEST_API_URL.replace(/\/+$/, '');
    return { origin, port: Number(new URL(origin).port), stop: async () => {} };
  }
  // Never start a test backend on the developer's own store: a newer backend
  // would apply its migrations to it. Without BMC_DB, use a private copy.
  let ownCopy = null;
  if (!db && !process.env.BMC_DB && existsSync(storePath())) {
    ownCopy = copyStore();
    db = ownCopy.path;
  }
  const env = db ? { ...process.env, BMC_DB: db } : process.env;
  const problem = setupProblem(env);
  if (problem) {
    throw new Error(`The end-to-end tests need the backend.\n${problem}`);
  }
  const port = await freePort();
  const child = spawnBackend({ port, env, stdio: ['ignore', 'ignore', 'pipe'], args: ['--log-level', 'warning'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const kill = () => child.kill('SIGKILL');
  process.once('exit', kill);
  try {
    await waitForBackend(port, { child, timeoutMs: 60000 });
  } catch (error) {
    kill();
    ownCopy?.dispose();
    throw new Error(`${error.message}\n${stderr}`);
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    stop: async () => {
      process.removeListener('exit', kill);
      await stopProcess(child);
      ownCopy?.dispose();
    }
  };
}

/** The app's data client over a backend origin (Node's fetch; no browser Origin header). */
export function apiClient(origin, { version } = {}) {
  return createDataClient(createApiAdapter({ baseUrl: `${origin}/api/v1`, defaultVersion: version }));
}
