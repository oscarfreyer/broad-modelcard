// The dashboard demo store (backend/demo/README.md):
//
//   node scripts/demo.mjs build [args]       npm run demo:build   rebuild the demo store
//   node scripts/demo.mjs run   [vite args]  npm run demo         the app on the demo store
//
// `build` runs `python -I` with app.demo's main (`build`): the seed import into
// backend/data/dashboard-demo.sqlite (rebuilt every time), then every demo
// pack file published through the normal upload → check → publish workflow,
// then ICD-10-CM and MONDO when `npm run ontologies:fetch` has downloaded them
// (contract v1.13; without them a notice says the demo serves ICD-11 only).
// Extra arguments are passed on, for example `--db <file>` to build elsewhere.
//
// `run` starts the backend and Vite like `npm run dev`, but on the demo store,
// with its uploads in backend/data/dashboard-demo-uploads/ (never the live
// store's backend/data/uploads/) and the backend on port 8010 unless
// BMC_API_PORT says otherwise, so it can run next to `npm run dev`. The live
// store backend/data/broad_modelcard.sqlite is never opened.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKEND_DIR, REPO_ROOT, isolatedPython, pythonSetupProblem } from './backendServer.mjs';

export const DEMO_STORE = path.join(BACKEND_DIR, 'data', 'dashboard-demo.sqlite');
export const DEMO_UPLOADS = path.join(BACKEND_DIR, 'data', 'dashboard-demo-uploads');
export const DEMO_API_PORT = 8010;

/** The environment for `run`: the demo store, its uploads folder, and the demo API port. */
export function demoEnv(env = process.env) {
  return {
    ...env,
    BMC_DB: DEMO_STORE,
    BMC_UPLOADS_DIR: DEMO_UPLOADS,
    BMC_API_PORT: env.BMC_API_PORT || String(DEMO_API_PORT)
  };
}

function build(args) {
  const problem = pythonSetupProblem();
  if (problem) {
    console.error(problem);
    return 1;
  }
  // Isolated Python (`-I`): the build also reads the downloaded ontology
  // releases (contract v1.13), so nothing next to them may load as code.
  const result = isolatedPython('app.demo.__main__', ['build', ...args]);
  return result.status ?? 1;
}

function run(viteArgs) {
  if (!existsSync(DEMO_STORE)) {
    console.error(`[demo] The demo store ${path.relative(REPO_ROOT, DEMO_STORE)} does not exist yet. Build it first (about 20 s):\n  npm run demo:build`);
    return Promise.resolve(1);
  }
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'dev.mjs'), 'dev', ...viteArgs], {
    cwd: REPO_ROOT,
    env: demoEnv(),
    stdio: 'inherit'
  });
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => process.on(signal, () => child.kill(signal)));
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? (signal ? 0 : 1))));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'build') {
    process.exit(build(args));
  } else if (command === 'run') {
    process.exit(await run(args));
  } else {
    console.error('Usage: node scripts/demo.mjs <build|run> [args]');
    process.exit(2);
  }
}
