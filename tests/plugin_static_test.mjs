// What can be checked without running the plugin: the manifest is the only version, the source names no
// machine, and every Bridge method the plugin registers is implemented (and the other way round).
// Targets the checked-in plugin, or the one AA_BRIDGE_ENTRY points at.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const entry = process.env.AA_BRIDGE_ENTRY || fileURLToPath(new URL('../index.mjs', import.meta.url));
const root = dirname(entry);
const src = readFileSync(entry, 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));

let n = 0;
const check = (name, ok) => { assert.ok(ok, name); n += 1; console.log('PASS ' + name); };

check('manifest name is aa-bridge-reg', manifest.name === 'aa-bridge-reg');
check('manifest version is x.y.z', /^\d+\.\d+\.\d+$/.test(String(manifest.version)));
check('manifest main exists next to the manifest', existsSync(join(root, String(manifest.main))));
check('CHANGELOG has an entry for the manifest version',
  readFileSync(join(root, 'CHANGELOG.md'), 'utf8').includes(String(manifest.version)));

check('source names no home directory', !/\/(Users|home)\//.test(src));
check('handshake reply carries the label, not a literal', /plugin: LABEL,/.test(src) && !/aa-bridge-v\d+\.\d/.test(src));

// pluginLabel() has no nested braces, so its source is matched however it is formatted.
const fn = src.match(/function pluginLabel\([^)]*\)\s*\{[^}]*\}/);
assert.ok(fn, 'pluginLabel not found');
const pluginLabel = new Function(fn[0] + '\nreturn pluginLabel;')();
check('label is <name>@<version> from the manifest', pluginLabel(manifest) === 'aa-bridge-reg@' + manifest.version);
check('label follows whatever manifest it is given', pluginLabel({ name: 'x', version: '9.9.9' }) === 'x@9.9.9');

const registered = [...src.matchAll(/\{ name: '(\w+)', stream: '(?:unary|server_stream)'/g)].map((m) => m[1]).sort();
const handled = new Set(['sync']);
for (const m of src.matchAll(/f\.method === '(\w+)'/g)) handled.add(m[1]);
// Contract A (aa.zcode.v2): the Bridge service as the connector's client.py knows it.
const contract = ['initialize', 'modelCatalog', 'sessionList', 'sessionRespond', 'sessionSelect', 'sessionSend',
  'sessionStart', 'sessionStop', 'shutdown', 'sync'];
check('registered Bridge methods are exactly contract A', JSON.stringify(registered) === JSON.stringify(contract));
check('every registered method is implemented, and no implementation is unregistered',
  JSON.stringify([...handled].sort()) === JSON.stringify(contract));

const ws = JSON.parse(readFileSync(join(root, 'ws', 'package.json'), 'utf8'));
check('vendored ws is pinned and keeps its licence', ws.name === 'ws' && /^\d+\.\d+\.\d+$/.test(ws.version) && existsSync(join(root, 'ws', 'LICENSE')));

console.log('RESULT: ALL PASS (' + n + ')');
