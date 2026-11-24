// Loads the plugin the way zcode's plugin host does — import the module, then call main() — and stays up.
// Usage: node tests/boot-runner.mjs /path/to/index.mjs
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) { console.error('usage: boot-runner.mjs <index.mjs>'); process.exit(2); }
const mod = await import(pathToFileURL(resolve(entry)).href);
await mod.main();
