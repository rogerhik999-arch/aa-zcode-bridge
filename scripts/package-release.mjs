// Builds dist/<name>-<version>.zip from the committed tree with git archive — so a release can only contain
// what is committed — then runs the tests against the extracted zip and prints the marketplace entry.
// A zip that fails the tests is deleted.
// Usage: node scripts/package-release.mjs [tree-ish]      (default HEAD)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ref = process.argv[2] || 'HEAD';
// Everything a host needs to run the plugin; tests, scripts and CI stay out of the zip.
const shipped = ['plugin.json', 'index.mjs', 'CHANGELOG.md', 'README.md', 'ws'];

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}
function fail(msg) {
  console.error('package-release: ' + msg);
  process.exit(1);
}

const shown = git(['show', ref + ':plugin.json']);
if (shown.status !== 0) fail('no plugin.json at ' + ref);
const manifest = JSON.parse(shown.stdout);
if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version))) fail('manifest version is not x.y.z: ' + manifest.version);
for (const p of shipped) {
  if (git(['cat-file', '-e', ref + ':' + p]).status !== 0) fail(ref + ' has no ' + p + ' — a release needs it');
}
const commit = git(['rev-parse', '--short=10', ref]).stdout.trim();

const file = manifest.name + '-' + manifest.version + '.zip';
const out = join(root, 'dist', file);
mkdirSync(join(root, 'dist'), { recursive: true });
const arch = git(['archive', '--format=zip', '-o', out, ref, ...shipped]);
if (arch.status !== 0) fail('git archive failed: ' + arch.stderr);

const bytes = readFileSync(out);
const sha256 = createHash('sha256').update(bytes).digest('hex');

// Extract and look at what is really inside.
const tmp = mkdtempSync(join(tmpdir(), 'aa-bridge-release-'));
let unzip = spawnSync('unzip', ['-q', out, '-d', tmp]);
if (unzip.error && unzip.error.code === 'ENOENT') {
  unzip = spawnSync('python3', ['-m', 'zipfile', '-e', out, tmp]);
}
if (unzip.status !== 0) fail('cannot extract the zip to verify it: ' + (unzip.stderr || unzip.error));
function walk(dir, base = '') {
  return readdirSync(dir).flatMap((name) => {
    const rel = base ? base + '/' + name : name;
    return statSync(join(dir, name)).isDirectory() ? walk(join(dir, name), rel) : [rel];
  });
}
const files = walk(tmp).sort();
const allowed = (f) => shipped.includes(f) || f.startsWith('ws/');
const stray = files.filter((f) => !allowed(f));
if (stray.length) fail('zip contains files outside the shipped set: ' + stray.join(', '));

// The artifact has to pass the same tests as the working tree.
// The test log goes to stderr, so stdout stays machine-readable (the JSON below).
const test = spawnSync(process.execPath, [join(root, 'tests', 'run.mjs')], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  env: { ...process.env, AA_BRIDGE_ENTRY: join(tmp, 'index.mjs') },
});
process.stderr.write(test.stdout + test.stderr);
rmSync(tmp, { recursive: true, force: true });
if (test.status !== 0) {
  rmSync(out, { force: true });
  fail('the extracted zip failed the tests; ' + file + ' was deleted');
}

writeFileSync(out + '.sha256', sha256 + '  ' + file + '\n');

let repoUrl = (git(['remote', 'get-url', 'origin']).stdout || '').trim().replace(/\.git$/, '');
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repoUrl)) repoUrl = 'https://github.com/OWNER/REPO';
const tag = 'v' + manifest.version;
const asset = repoUrl + '/releases/download/' + tag + '/' + file;
console.log(JSON.stringify({
  commit, file, bytes: bytes.length, sha256, files: files.length,
  marketplaceEntry: {
    name: 'aa-bridge',
    source: { source: 'url', type: 'zip', url: asset, sha256 },
    description: 'Agents Anywhere runtime bridge for ZCode (contract aa.zcode.v2)',
    version: manifest.version,
  },
}, null, 2));
