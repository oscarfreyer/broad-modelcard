// Runs the backend pytest suite for the root `npm test`.
// Uses backend/.venv by default; set BMC_PYTHON to use another interpreter.
import { spawnSync } from 'node:child_process';
import { BACKEND_DIR, pythonPath, pythonSetupProblem } from './backendServer.mjs';

const problem = pythonSetupProblem();
if (problem) {
  console.error(problem);
  process.exit(1);
}

const result = spawnSync(pythonPath(), ['-m', 'pytest', '-q', ...process.argv.slice(2)], { cwd: BACKEND_DIR, stdio: 'inherit' });
process.exit(result.status ?? 1);
