// npm run ontologies:import — write ICD-10-CM and MONDO into the store at
// BMC_DB (else the live store), from the files `npm run ontologies:fetch`
// downloaded (contract v1.13, backend/CONTRACT.md §23), with the synonyms of
// ICD-11 concepts read from the same files (contract v1.14, §31).
//
// Runs `python -I` (isolatedPython: no current directory or PYTHON*
// variables on the import path), so nothing in the downloaded data folder can
// load as code. Extra arguments are passed on: --db FILE, --sources DIR,
// --only icd10cm|mondo, --quiet. A backend that is running on the store keeps
// the ontologies it loaded until it restarts.
import { isolatedPython, pythonSetupProblem } from '../backendServer.mjs';

const problem = pythonSetupProblem();
if (problem) {
  console.error(problem);
  process.exit(1);
}
const result = isolatedPython('app.ontologies.importer', process.argv.slice(2));
process.exit(result.status ?? 1);
