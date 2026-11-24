// Runs every tests/*_test.mjs with node's test runner, one at a time.
// Run: node tests/run.mjs      (AA_BRIDGE_ENTRY=/path/to/index.mjs targets an extracted release instead)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', here + '*_test.mjs'], { stdio: 'inherit', env: process.env });
process.exit(run.status === null ? 1 : run.status);
