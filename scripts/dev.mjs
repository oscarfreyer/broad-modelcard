// One command for the local app: starts the backend
// (python -m app.serve on 127.0.0.1) and then Vite, which proxies /api to it.
//
//   node scripts/dev.mjs dev     [vite args]   npm run dev      (dev server)
//   node scripts/dev.mjs preview [vite args]   npm run preview  (production build)
//   node scripts/dev.mjs api                   npm run api      (backend only)
//
// BMC_API_PORT changes the backend port (default 8000). BMC_VITE_PORT gives
// Vite a fixed port (with --strictPort), unless the Vite args name --port
// themselves (`npm run dev -- --port 5180 --strictPort`). A backend that this
// checkout started (recorded in backend/data/dev-api-<port>.json) and that
// still runs on the same store is reused and left running. An API on the port
// that this checkout did not start, for example one from another git
// worktree, is refused: it may serve another database. Ctrl+C stops both.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { apiPort } from '../frontend/apiProxy.js';
import {
  REPO_ROOT,
  backendPlan,
  pidAlive,
  probeBackend,
  readDevMarker,
  removeDevMarker,
  setupProblem,
  spawnBackend,
  stopProcess,
  storePath,
  waitForBackend,
  writeDevMarker
} from './backendServer.mjs';

const MODES = new Set(['dev', 'preview', 'api']);
const [mode = 'dev', ...cliViteArgs] = process.argv.slice(2);
const vitePort = process.env.BMC_VITE_PORT;
const viteArgs =
  vitePort && !cliViteArgs.some((arg) => arg === '--port' || arg.startsWith('--port='))
    ? [...cliViteArgs, '--port', vitePort, '--strictPort']
    : cliViteArgs;
if (!MODES.has(mode)) {
  console.error(`Usage: node scripts/dev.mjs <dev|preview|api> [vite args]`);
  process.exit(2);
}

const port = apiPort();
const store = storePath();
const children = [];
let backend = null;
let stopping = false;

async function shutdown(code = 0) {
  if (stopping) {
    return;
  }
  stopping = true;
  await Promise.all(children.map((child) => stopProcess(child)));
  process.exit(code);
}
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => process.on(signal, () => shutdown(0)));
// The marker goes once the backend it names has stopped. A backend that
// outlives this script (the script was killed hard) keeps its marker and is
// reused next time.
process.on('exit', () => {
  if (backend?.pid && (backend.exitCode !== null || backend.signalCode !== null)) {
    removeDevMarker(port, { pid: backend.pid });
  }
});

function refuse(reason) {
  const example = port === 8020 ? 8030 : 8020;
  console.error(`[dev] ${reason} Stop it, or choose a free port: BMC_API_PORT=${example} npm run ${mode}`);
  process.exit(1);
}

async function startBackend() {
  let marker = readDevMarker(port);
  if (marker && !pidAlive(marker.pid)) {
    removeDevMarker(port);
    marker = null;
  }
  const probe = await probeBackend(port);
  switch (backendPlan(probe, marker, { store })) {
    case 'reuse':
      console.log(`[dev] Using the Broad Modelcard API that this checkout started on 127.0.0.1:${port} (pid ${marker.pid}).`);
      return;
    case 'foreign':
      refuse(`Port ${port} is used by a Broad Modelcard API from another checkout or session, which may serve another database.`);
      break;
    case 'other-store':
      refuse(`Port ${port} is used by a Broad Modelcard API from this checkout (pid ${marker.pid}) that serves another store, ${marker.store}.`);
      break;
    case 'taken':
      refuse(`Port ${port} is taken by another program.`);
      break;
    default:
      break;
  }
  const problem = setupProblem();
  if (problem) {
    console.error(`[dev] ${problem}`);
    process.exit(1);
  }
  backend = spawnBackend({ port });
  children.push(backend);
  if (backend.pid) {
    writeDevMarker({ port, pid: backend.pid, store });
  }
  backend.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[dev] The backend stopped (${signal ?? `exit code ${code}`}); stopping.`);
      shutdown(code || 1);
    }
  });
  try {
    const ms = await waitForBackend(port, { child: backend });
    console.log(`[dev] Backend ready on http://127.0.0.1:${port}/api/v1 after ${(ms / 1000).toFixed(1)} s.`);
  } catch (error) {
    console.error(`[dev] ${error.message}`);
    await shutdown(1);
  }
}

function startVite() {
  const viteBin = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const args = [viteBin, ...(mode === 'preview' ? ['preview'] : []), '--config', 'frontend/vite.config.js', ...viteArgs];
  const vite = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, BMC_API_PORT: String(port) },
    stdio: ['inherit', 'inherit', 'inherit']
  });
  children.push(vite);
  vite.once('exit', (code, signal) => {
    if (!stopping) {
      shutdown(code ?? (signal ? 0 : 1));
    }
  });
}

await startBackend();
if (mode === 'api') {
  if (children.length === 0) {
    process.exit(0);
  }
} else {
  startVite();
}
