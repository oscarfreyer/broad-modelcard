// `npm run validate-seed`: checks backend/seed against the data contract with
// the backend's own rules (python -m app.importers.legacy_json --check). The
// store is not touched. Extra arguments are passed on (for example --seed <dir>).
import { spawnSync } from 'node:child_process';
import { BACKEND_DIR, pythonPath, pythonSetupProblem } from './backendServer.mjs';

const problem = pythonSetupProblem();
if (problem) {
  console.error(problem);
  process.exit(1);
}

const result = spawnSync(pythonPath(), ['-m', 'app.importers.legacy_json', '--check', ...process.argv.slice(2)], {
  cwd: BACKEND_DIR,
  stdio: 'inherit'
});
process.exit(result.status ?? 1);
