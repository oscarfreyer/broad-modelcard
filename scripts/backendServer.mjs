// Starting and probing the local backend (python -m app.serve) from Node: used
// by scripts/dev.mjs (`npm run dev`, `npm run preview`, `npm run api`) and by
// the frontend end-to-end tests. The backend binds 127.0.0.1 only.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BACKEND_DIR = path.join(REPO_ROOT, 'backend');

export function pythonPath(env = process.env) {
  if (env.BMC_PYTHON) {
    return env.BMC_PYTHON;
  }
  const windows = path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe');
  return process.platform === 'win32' && existsSync(windows) ? windows : path.join(BACKEND_DIR, '.venv', 'bin', 'python');
}

export function storePath(env = process.env) {
  return env.BMC_DB ? path.resolve(BACKEND_DIR, env.BMC_DB) : path.join(BACKEND_DIR, 'data', 'broad_modelcard.sqlite');
}

/**
 * Runs a backend module's `main(argv)` with `python -I` (isolated: neither the
 * current directory nor PYTHON* variables reach the import path); the backend
 * is added by its absolute path. Used where Python reads downloaded files (the
 * ontology releases, contract v1.13), so nothing next to them loads as code.
 */
export function isolatedPython(module, args, { env = process.env, stdio = 'inherit' } = {}) {
  const code = `import sys; sys.path.insert(0, ${JSON.stringify(BACKEND_DIR)}); from ${module} import main; sys.exit(main(sys.argv[1:]))`;
  return spawnSync(pythonPath(env), ['-I', '-c', code, ...args], { cwd: BACKEND_DIR, env, stdio });
}

/** Setup steps when the backend's Python environment is missing, or null. */
export function pythonSetupProblem(env = process.env) {
  const python = pythonPath(env);
  if (existsSync(python)) {
    return null;
  }
  return [
    `The backend needs its Python environment, but ${python} does not exist. Set it up once:`,
    '  cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt',
    'or point BMC_PYTHON at an interpreter that has the backend requirements.'
  ].join('\n');
}

/** What is missing before the backend can start, as printable setup steps, or null. */
export function setupProblem(env = process.env) {
  const missingPython = pythonSetupProblem(env);
  if (missingPython) {
    return missingPython;
  }
  const store = storePath(env);
  if (!existsSync(store)) {
    return [
      `The data store ${path.relative(REPO_ROOT, store)} does not exist yet. Build it once (about 15 s):`,
      '  cd backend && .venv/bin/python -m app.importers.legacy_json'
    ].join('\n');
  }
  return null;
}

/**
 * Whether a Broad Modelcard API answers on the port: 'ours', 'other' (the
 * port is taken by something else), or 'none'.
 */
export async function probeBackend(port, { timeoutMs = 1500 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/meta`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return 'other';
    }
    const body = await response.json().catch(() => null);
    return body?.api_version === '1' && typeof body.dataset_version === 'string' ? 'ours' : 'other';
  } catch (error) {
    return error?.cause?.code === 'ECONNREFUSED' || error?.name === 'TypeError' ? 'none' : 'other';
  }
}

// Ownership markers. A Broad Modelcard API on the port may belong to another
// checkout or git worktree that serves another store, and /meta cannot tell
// them apart. So scripts/dev.mjs records each backend it spawns in this
// checkout's backend/data/dev-api-<port>.json (gitignored), and reuses a
// running API only when that marker names a live process.

export const MARKER_DIR = path.join(BACKEND_DIR, 'data');

export function devMarkerPath(port, dir = MARKER_DIR) {
  return path.join(dir, `dev-api-${port}.json`);
}

/** Whether a process with this pid exists (EPERM: it exists but belongs to another user). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** The marker for the port, or null when there is none or it is unreadable. */
export function readDevMarker(port, dir = MARKER_DIR) {
  try {
    const marker = JSON.parse(readFileSync(devMarkerPath(port, dir), 'utf8'));
    return marker?.port === port && Number.isInteger(marker.pid) ? marker : null;
  } catch {
    return null;
  }
}

/** Records a backend this checkout spawned on `port`. */
export function writeDevMarker({ port, pid, store }, dir = MARKER_DIR) {
  mkdirSync(dir, { recursive: true });
  const marker = { port, pid, store, started_at: new Date().toISOString() };
  writeFileSync(devMarkerPath(port, dir), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

/** Removes the marker for `port`; with `pid`, only while the marker still names that process. */
export function removeDevMarker(port, { pid, dir = MARKER_DIR } = {}) {
  if (pid !== undefined && readDevMarker(port, dir)?.pid !== pid) {
    return false;
  }
  rmSync(devMarkerPath(port, dir), { force: true });
  return true;
}

/**
 * What to do about the backend port, from `probeBackend`'s answer and this
 * checkout's marker: 'start' (nothing answers), 'reuse' (this checkout's live
 * backend on the same store), 'other-store' (this checkout's backend on
 * another BMC_DB), 'foreign' (a Broad Modelcard API that this checkout did not
 * start), or 'taken' (another program).
 */
export function backendPlan(probe, marker, { store, isAlive = pidAlive } = {}) {
  if (probe === 'none') {
    return 'start';
  }
  if (probe !== 'ours') {
    return 'taken';
  }
  if (!marker || !isAlive(marker.pid)) {
    return 'foreign';
  }
  return marker.store === store ? 'reuse' : 'other-store';
}

/** Resolves once the API answers, or rejects after `timeoutMs` or when `child` exits. */
export async function waitForBackend(port, { timeoutMs = 60000, child = null } = {}) {
  const started = Date.now();
  let exited = null;
  child?.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  for (;;) {
    if (exited) {
      throw new Error(`The backend stopped before it was ready (exit code ${exited.code ?? exited.signal}).`);
    }
    if ((await probeBackend(port, { timeoutMs: 1000 })) === 'ours') {
      return Date.now() - started;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`The backend did not answer on 127.0.0.1:${port} within ${Math.round(timeoutMs / 1000)} s.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * Spawns `python -m app.serve --port <port>` in backend/.
 *
 * @param {object} [options]
 * @param {number} [options.port]
 * @param {'inherit'|'pipe'|'ignore'} [options.stdio]
 * @param {string[]} [options.args] extra app.serve arguments, e.g. ['--log-level', 'warning']
 */
export function spawnBackend({ port = 8000, stdio = 'inherit', args = [], env = process.env } = {}) {
  return spawn(pythonPath(env), ['-m', 'app.serve', '--port', String(port), ...args], {
    cwd: BACKEND_DIR,
    env,
    stdio: stdio === 'inherit' ? ['ignore', 'inherit', 'inherit'] : stdio
  });
}

/** Stops a child process: SIGTERM, then SIGKILL after `graceMs`. Resolves when it has exited. */
export function stopProcess(child, { graceMs = 4000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
