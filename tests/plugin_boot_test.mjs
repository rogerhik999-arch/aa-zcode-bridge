// Boots the plugin in a sandbox (its own HOME, log, ops socket, rendezvous path) with no connector and
// no zcode bundle, and checks what it says about itself; then stops it with SIGTERM.
// Two cases: every path given explicitly, and only the rendezvous path given — the marker log and the
// ops socket must then land next to it, in a directory the plugin creates itself.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, probe, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await probe()) return; await sleep(50); }
  throw new Error('timed out waiting for ' + what);
}
const logText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
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
const check = (name, ok) => { assert.ok(ok, name); n += 1; console.log('PASS ' + name); };

// Each case gets its own sandbox: a HOME, a rendezvous and a workbase of its own, so nothing it starts
// can reach the real log, the real socket or the real home. paths() gives the AA_ZCODE_* variables and
// says where the case expects the log and the socket.
async function runCase(name, paths) {
  const tmp = mkdtempSync(join(tmpdir(), 'aa-bridge-boot-'));
  let child;
  try {
    mkdirSync(join(tmp, 'home'));
    const { env, logPath, sockPath } = paths(tmp);
    const base = {
      HOME: join(tmp, 'home'), USER: process.env.USER || 'test', LOGNAME: process.env.USER || 'test',
      PATH: dirname(process.execPath) + ':/usr/bin:/bin', TMPDIR: tmp + '/',
    };
    child = spawn(process.execPath, [runner, entry], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));

    await waitFor('the ops socket', () => existsSync(sockPath), 15000);
    const reply = await opsReply(sockPath);
    check(name + ': ops socket answers alive', reply.proto === 'aa-bridge-v3' && reply.alive === true);
    check(name + ': ops socket names the build by its manifest', reply.plugin === label);

    const startLine = '=== ' + label + ' START pid=' + child.pid + ' ';
    await waitFor('the start-up log line', () => logText(logPath).includes(startLine), 10000);
    check(name + ': start-up log line names the build', logText(logPath).includes(startLine));
    await waitFor('the missing rendezvous file to be reported', () => logText(logPath).includes('rendezvous.fail'), 10000);
    check(name + ': runs on with no connector (reports the missing rendezvous file)', !logText(logPath).includes('appsrv.spawn'));

    child.kill('SIGTERM');
    const stop = await Promise.race([exited, sleep(8000).then(() => null)]);
    check(name + ': SIGTERM stops it cleanly', stop !== null && stop.code === 0 && stop.signal === null);
    check(name + ': log records the shutdown', logText(logPath).includes('SIGTERM bye'));
    check(name + ': nothing uncaught on stderr', !/Error|uncaught|unhandled/i.test(stderr));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
  }
}

const realRendezvous = join(process.env.HOME || '', '.agents-anywhere', 'zcode-bridge', 'no-connector.json');
const realMarker = join(process.env.HOME || '', '.agents-anywhere', 'zcode-bridge', 'v3-marker.log');
const realMarkerBefore = existsSync(realMarker);

// 1. every path given explicitly
await runCase('explicit paths', (tmp) => ({
  env: {
    AA_ZCODE_LOG: join(tmp, 'marker.log'), AA_ZCODE_OPSOCK: join(tmp, 'bridge.sock'),
    AA_ZCODE_RENDEZVOUS: join(tmp, 'no-connector.json'), AA_ZCODE_WORKBASE: join(tmp, 'work'),
    AA_ZCODE_BOOTSTRAP: join(tmp, 'no-zcode.cjs'),
  },
  logPath: join(tmp, 'marker.log'), sockPath: join(tmp, 'bridge.sock'),
}));

// 2. only the rendezvous is given, inside a directory that does not exist yet: the log and the socket
//   are expected next to it, and the plugin has to create the directory itself.
const stateDir = (tmp) => join(tmp, 'state', 'zcode-bridge');
await runCase('default paths', (tmp) => ({
  env: {
    AA_ZCODE_RENDEZVOUS: join(stateDir(tmp), 'connector.js'), AA_ZCODE_WORKBASE: join(tmp, 'work'),
    AA_ZCODE_BOOTSTRAP: join(tmp, 'no-zcode.cjs'),
  },
  logPath: join(stateDir(tmp), 'v3-marker.log'), sockPath: join(stateDir(tmp), 'v3-bridge.sock'),
}));

check('nothing is written under the real home', !existsSync(realRendezvous));
check('the real marker log is neither created nor touched by the default-path case', existsSync(realMarker) === realMarkerBefore);
console.log('RESULT: ALL PASS (' + n + ')');