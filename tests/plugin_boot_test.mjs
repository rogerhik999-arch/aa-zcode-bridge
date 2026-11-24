// Boots the plugin in a sandbox (its own HOME, log, ops socket, rendezvous path) with no connector and
// no zcode bundle, and checks what it says about itself; then stops it with SIGTERM.
// Targets the checked-in plugin, or the one AA_BRIDGE_ENTRY points at.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const entry = process.env.AA_BRIDGE_ENTRY || fileURLToPath(new URL('../index.mjs', import.meta.url));
// Interlock: the sandbox below only holds for a plugin that honours AA_ZCODE_*. An older source ignores
// those variables, writes the real marker log and takes over the real ops socket — so refuse to run it.
if (!/AA_ZCODE_OPSOCK/.test(readFileSync(entry, 'utf8'))) {
  console.error(entry + ' does not honour AA_ZCODE_* overrides; refusing to start it (it would touch the real log and ops socket)');
  process.exit(2);
}
const runner = fileURLToPath(new URL('./boot-runner.mjs', import.meta.url));
const manifest = JSON.parse(readFileSync(join(dirname(entry), 'plugin.json'), 'utf8'));
const label = manifest.name + '@' + manifest.version;

const tmp = mkdtempSync(join(tmpdir(), 'aa-bridge-boot-'));
const logPath = join(tmp, 'marker.log');
const sockPath = join(tmp, 'bridge.sock');
mkdirSync(join(tmp, 'home'));
const env = {
  HOME: join(tmp, 'home'), USER: process.env.USER || 'test', LOGNAME: process.env.USER || 'test',
  PATH: dirname(process.execPath) + ':/usr/bin:/bin', TMPDIR: tmp + '/',
  AA_ZCODE_LOG: logPath, AA_ZCODE_OPSOCK: sockPath,
  AA_ZCODE_RENDEZVOUS: join(tmp, 'no-connector.json'), AA_ZCODE_WORKBASE: join(tmp, 'work'),
  AA_ZCODE_BOOTSTRAP: join(tmp, 'no-zcode.cjs'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, probe, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await probe()) return; await sleep(50); }
  throw new Error('timed out waiting for ' + what);
}
const logText = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
function opsReply(path) {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    s.setEncoding('utf8');
    let buf = '';
    const to = setTimeout(() => { s.destroy(); reject(new Error('ops socket: no reply')); }, 5000);
    s.on('connect', () => s.write('ping\n'));
    s.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl < 0) return; clearTimeout(to); s.destroy(); resolve(JSON.parse(buf.slice(0, nl))); });
    s.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

let n = 0;
const check = (name, ok) => { assert.ok(ok, name); n += 1; console.log('PASS ' + name); }

let child;
try {
  child = spawn(process.execPath, [runner, entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));

  await waitFor('the ops socket', () => existsSync(sockPath), 15000);
  const reply = await opsReply(sockPath);
  check('ops socket answers alive', reply.proto === 'aa-bridge-v3' && reply.alive === true);
  check('ops socket names the build by its manifest', reply.plugin === label);

  await waitFor('the start-up log line', () => logText().includes('=== ' + label + ' START pid=' + child.pid + ' '), 10000);
  check('start-up log line names the build', logText().includes('=== ' + label + ' START pid=' + child.pid + ' '));
  await waitFor('the missing rendezvous file to be reported', () => logText().includes('rendezvous.fail'), 10000);
  check('runs on with no connector (reports the missing rendezvous file)', !logText().includes('appsrv.spawn'));
  check('nothing is written under the real home', !existsSync(join(process.env.HOME || '', '.agents-anywhere', 'zcode-bridge', 'no-connector.json')));

  child.kill('SIGTERM');
  const stop = await Promise.race([exited, sleep(8000).then(() => null)]);
  check('SIGTERM stops it cleanly', stop !== null && stop.code === 0 && stop.signal === null);
  check('log records the shutdown', logText().includes('SIGTERM bye'));
  check('nothing uncaught on stderr', !/Error|uncaught|unhandled/i.test(stderr));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
}
console.log('RESULT: ALL PASS (' + n + ')');
