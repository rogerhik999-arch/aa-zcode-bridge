// Runs the real plugin without zcode: the plugin runs in its own sandbox (boot-runner), its Router is
// a stand-in WebSocket server and its app-server a stand-in JSONL script (fake-app-server.mjs, which the
// plugin starts through AA_ZCODE_BOOTSTRAP). Checked here: the handshake of protocol 0.3 advertises
// sessionResume; sessionResume resumes and then subscribes; a resume the app-server rejects comes back
// as that error and nothing is subscribed; a request without a session never reaches the app-server.
// Targets the checked-in plugin, or the one AA_BRIDGE_ENTRY points at.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from '../ws/wrapper.mjs';

const entry = process.env.AA_BRIDGE_ENTRY || fileURLToPath(new URL('../index.mjs', import.meta.url));
// Interlock, as in plugin_boot_test.mjs: a source that ignores AA_ZCODE_* would write the real marker
// log and take over the real ops socket.
if (!/AA_ZCODE_OPSOCK/.test(readFileSync(entry, 'utf8'))) {
  console.error(entry + ' does not honour AA_ZCODE_* overrides; refusing to start it');
  process.exit(2);
}
const runner = fileURLToPath(new URL('./boot-runner.mjs', import.meta.url));
const fakeAppServer = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const manifest = JSON.parse(readFileSync(join(dirname(entry), 'plugin.json'), 'utf8'));
const label = manifest.name + '@' + manifest.version;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, probe, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await probe()) return; await sleep(50); }
  throw new Error('timed out waiting for ' + what);
}

let n = 0;
const check = (name, ok) => { assert.ok(ok, name); n += 1; console.log('PASS ' + name); };

const tmp = mkdtempSync(join(tmpdir(), 'aa-bridge-resume-'));
const stateDir = join(tmp, 'zcode-bridge');
const sockPath = join(tmp, 'router.sock');
const rendezvous = join(stateDir, 'connector.json');
const markerLog = join(tmp, 'marker.log');
const appLog = join(tmp, 'app-server.jsonl');
const key = 'test-' + Math.random().toString(16).slice(2);
mkdirSync(stateDir, { recursive: true });
writeFileSync(rendezvous, JSON.stringify({ version: 2, protocol: 'meshcall', endpoint: { unixPath: sockPath }, key }));

// ---- the stand-in Router: what the plugin's Connector side does with its two connections ----
const registered = { methods: null };
const pending = new Map();          // call_id -> (frame) => void, for the calls this test opens
let control = null;                 // the plugin's server connection: register, then the Bridge calls
const wss = new WebSocketServer({ noServer: true });
const router = createServer();
router.on('upgrade', (req, socket, head) => {
  if (req.headers.authorization !== 'Bearer ' + key) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => {
      const f = JSON.parse(String(data));
      if (f.kind === 'hello') ws.send(JSON.stringify({ kind: 'hello.ack', connection_id: 'test-' + f.role }));
      else if (f.kind === 'server.register') {
        registered.methods = f.services[0].methods;
        control = ws;
        ws.send(JSON.stringify({ kind: 'server.register.ack' }));
      } else if (f.kind === 'ping') ws.send(JSON.stringify({ kind: 'pong', nonce: f.nonce }));
      else if (pending.has(f.call_id)) { const settle = pending.get(f.call_id); pending.delete(f.call_id); settle(f); }
    });
  });
});
await new Promise((listen) => router.listen(sockPath, listen));
let nextCall = 0;
function call(method, payload = {}) {
  const callId = 'test-' + (++nextCall);
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { pending.delete(callId); reject(new Error(method + ': no answer')); }, 20000);
    pending.set(callId, (f) => { clearTimeout(to); resolve(f); });
    control.send(JSON.stringify({ kind: 'call.open', call_id: callId, service: 'aa.zcode.v2.Bridge', method, payload }));
  });
}
const appCalls = () => (existsSync(appLog) ? readFileSync(appLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const marker = () => (existsSync(markerLog) ? readFileSync(markerLog, 'utf8') : '');

let child;
let stderr = '';
try {
  mkdirSync(join(tmp, 'home'));
  child = spawn(process.execPath, [runner, entry], { stdio: ['ignore', 'pipe', 'pipe'], env: {
    HOME: join(tmp, 'home'), USER: process.env.USER || 'test', LOGNAME: process.env.USER || 'test',
    PATH: dirname(process.execPath) + ':/usr/bin:/bin', TMPDIR: tmp + '/',
    AA_ZCODE_RENDEZVOUS: rendezvous, AA_ZCODE_WORKBASE: join(tmp, 'work'),
    AA_ZCODE_LOG: markerLog, AA_ZCODE_OPSOCK: join(tmp, 'bridge.sock'),
    AA_ZCODE_BOOTSTRAP: fakeAppServer, AA_TEST_APPLOG: appLog,
  } });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  await waitFor('the service registration', () => registered.methods !== null, 15000);

  // 1. the handshake
  check('the host registers sessionResume as a unary method',
    registered.methods.some((m) => m.name === 'sessionResume' && m.stream === 'unary'));
  let f = await call('initialize');
  const init = f.payload;
  check('initialize answers protocol 0.3', f.kind === 'call.result' && init.protocolVersion === '0.3');
  check('initialize advertises sessionResume in capabilities, next to the build label and its instance',
    Array.isArray(init.capabilities) && init.capabilities.includes('sessionResume') && init.plugin === label
    && typeof init.instance === 'string' && init.instance.startsWith('aa-bridge-'));

  // 2. a resume the app-server accepts: resume, then the subscription sessionStart also performs
  f = await call('sessionResume', { zcodeSessionId: 'sess_old' });
  check('sessionResume answers resumed and subscribed for the session it was asked for',
    f.kind === 'call.result' && f.payload.zcodeSessionId === 'sess_old' && f.payload.resumed === true && f.payload.subscribed === true);
  const sent = appCalls();
  check('the app-server got session/resume with only the session id, then session/subscribe (after its session/list ready probe)',
    sent.map((c) => c.method).join(' ') === 'session/list session/resume session/subscribe'
    && JSON.stringify(sent[1].params) === '{"sessionId":"sess_old"}'
    && JSON.stringify(sent[2].params) === '{"sessionId":"sess_old","deliveryKind":"desktop-continuous"}');
  check('the marker log records the resume', marker().includes('sessionResume -> sess_old subscribed=true'));

  // 3. a resume the app-server rejects: its error is the answer, and nothing is subscribed
  f = await call('sessionResume', { zcodeSessionId: 'sess_gone' });
  check('a rejected resume is session_resume_failed with the app-server\'s own error, not retryable',
    f.kind === 'call.error' && f.error.code === 'session_resume_failed' && f.error.retryable === false
    && f.error.message.includes('-32004') && f.error.message.includes('Session not found: sess_gone'));
  check('nothing was subscribed for the session that failed to resume',
    appCalls().slice(sent.length).map((c) => c.method).join(' ') === 'session/resume');
  check('the marker log records the failed resume', marker().includes('sessionResume FAIL sess_gone'));

  // 4. a subscription the app-server refuses does not fail the resume (as after session/create)
  f = await call('sessionResume', { zcodeSessionId: 'sess_nosub' });
  check('a refused subscription is reported in the answer: resumed, not subscribed',
    f.kind === 'call.result' && f.payload.resumed === true && f.payload.subscribed === false);

  // 5. no session named: refused without waking the app-server
  const before = appCalls().length;
  f = await call('sessionResume', {});
  check('a request without zcodeSessionId is invalid_params and never reaches the app-server',
    f.kind === 'call.error' && f.error.code === 'invalid_params' && appCalls().length === before);

  child.kill('SIGTERM');
  const stop = await Promise.race([exited, sleep(8000).then(() => null)]);
  check('SIGTERM stops it cleanly, with nothing uncaught on stderr', stop !== null && stop.code === 0 && !/Error|uncaught|unhandled/i.test(stderr));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const ws of wss.clients) ws.terminate();
  await new Promise((close) => wss.close(() => close()));
  await new Promise((close) => router.close(() => close()));
  rmSync(tmp, { recursive: true, force: true });
}
console.log('RESULT: ALL PASS (' + n + ')');
