import { appendFileSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const HOME = '/Users/rogerhi';
const LOG = HOME + '/Documents/dsh-workspace/zcode-adapter/v3-marker.log';
const OPSOCK = HOME + '/Documents/dsh-workspace/zcode-adapter/v3-bridge.sock';
const RENDEZVOUS = process.env.AA_ZCODE_RENDEZVOUS || HOME + '/.agents-anywhere/zcode-bridge/connector.json';
const WORKBASE = process.env.AA_ZCODE_WORKBASE || '/tmp/aa-zcode-bridge/work';
const ZCODE = '/Applications/ZCode.app/Contents/MacOS/ZCode';
const BOOTSTRAP = HOME + '/zcode-headless/zcode.cjs';
const INSTANCE = 'aa-bridge-' + randomBytes(4).toString('hex');
const SERVICE = 'aa.zcode.v2.Bridge';
const SYNC = 'aa.zcode.v2.Sync';
const PREFS_REPLY = { nativeSearchEnhancementsEnabled: false };
function require_unlink(p) { try { unlinkSync(p); } catch (e) {} }
const log = (m) => { try { appendFileSync(LOG, new Date().toISOString() + ' | ' + m + '\n'); } catch (e) {} };

// ---------- minimal WebSocket over unix socket ----------
import WSLib from './ws/index.js';

class WsUnix {
  constructor(path) { this.path = path; this.handlers = {}; }
  on(ev, fn) { this.handlers[ev] = fn; }
  async open(headers) {
    this.sock = new WSLib('ws://localhost/', {
      createConnection: () => connect(this.path),
      handshakeTimeout: 8000,
      maxPayload: 16 * 1024 * 1024,
      headers,
    });
    this.sock.on('message', (data, isBinary) => {
      if (isBinary) return;
      try { this.handlers.message && this.handlers.message(data.toString('utf8')); } catch (e) {}
    });
    this.sock.on('close', (code, reason) => this.handlers.close && this.handlers.close(code, reason.toString()));
    this.sock.on('error', (e) => this.handlers.error && this.handlers.error(e));
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('ws open timeout')), 9000);
      this.sock.once('open', () => { clearTimeout(to); res(); });
      this.sock.once('error', (e) => { clearTimeout(to); rej(e); });
    });
  }
  send(str) { try { this.sock.send(str); } catch (e) { log('ws.send fail ' + e.message); } }
}

// ---------- app-server manager (JSONL over stdio, mirrors adapter appclient.py) ----------
class AppServer {
  constructor(onEvent) {
    this.proc = null; this.pending = new Map(); this.nextId = 1; this.buf = '';
    this.onEvent = onEvent; this.starting = null;
  }
  get running() { return this.proc && this.proc.exitCode === null; }
  async ensure() {
    if (this.running) return this;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async _start() {
    mkdirSync(WORKBASE, { recursive: true });
    // rev5.1 (actually applied this time): plain node app-server. NEVER the
    // ZCode.app binary — macOS LS registers in-bundle-binary processes as a
    // running ZCode app (Dock icons + desktop cold-start handoff ghost, rev4.6).
    const child = spawn(process.execPath, [BOOTSTRAP, 'app-server', '--cwd', WORKBASE], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc = child;
    log('appsrv.spawn pid=' + child.pid);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      this.buf += d;
      let nl;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        let f; try { f = JSON.parse(line); } catch (e) { continue; }
        if (f.method && f.id !== undefined) this._answerServerRequest(f);
        else if (f.method) { try { this.onEvent(f.method, f.params || {}); } catch (e) {} }
        else if (f.id !== undefined) {
          const p = this.pending.get(f.id);
          if (p) { this.pending.delete(f.id); p(f); }
        }
      }
    });
    child.on('exit', (c) => { log('appsrv.exit code=' + c); this.proc = null; });
    // ready probe
    await this.call('session/list', {}, 30000);
    return this;
  }
  call(method, params, timeoutMs) {
    return new Promise(async (resolve, reject) => {
      try { await this.ensure(); } catch (e) { return reject(e); }
      const id = this.nextId++;
      const to = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timeout')); }, timeoutMs || 45000);
      this.pending.set(id, (f) => { clearTimeout(to);
        if (f.error) reject(new Error(method + ' error: ' + JSON.stringify(f.error).slice(0, 160)));
        else resolve(f.result);
      });
      this.proc.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
    });
  }
  _answerServerRequest(f) {
    let reply = {};
    if (f.method === 'session/requestRuntimePreferences') reply = PREFS_REPLY;
    else if (f.method === 'interaction/requestPermission') {
      // v3.4: with an AA relay attached the decision belongs to the AA user.
      // The request is parked and surfaced as an interaction notice; AA answers
      // through Bridge.sessionRespond (or the timeout sweep denies it).
      const p = f.params || {};
      const opts = Array.isArray(p.options) ? p.options : [];
      // zcode's option order is [allow_once, (always-allow variant)?, deny]; pick the
      // narrowest grant explicitly instead of trusting the order.
      let allow = null, deny = null;
      for (const o of opts) {
        const r = o && o.response; if (!r) continue;
        if (r.decision === 'allow' && (!allow || o.optionId === 'allow_once' || o.kind === 'allow_once')) allow = r;
        if (r.decision === 'deny' && !deny) deny = r;
      }
      const fallback = allow || (opts[0] && opts[0].response) || { decision: 'deny', reason: 'no options' };
      if (subscriptions.size === 0) {
        // No AA relay: keep the pre-v3.4 behaviour instead of stranding the turn.
        reply = fallback;
        log('permission(auto,no-relay) ' + (p.title || '') + ' -> ' + (reply.decision || '?'));
      } else {
        // zcode re-announces a pending request every few seconds with a fresh JSON-RPC id
        // but the same params.requestId: key by requestId so it stays one card.
        const rid = String(p.requestId || f.id);
        const zsid = String(p.sessionId || '');
        const prev = pendingPerm.get(rid);
        if (prev) {
          prev.rawId = f.id; prev.as = this;  // answer the latest announcement
          log('permission(reannounce) id=' + rid + ' jsonrpc=' + f.id);
          return;
        }
        const input = (p.input && typeof p.input === 'object') ? p.input : {};
        const subject = String(input.command || input.file_path || input.path || input.url || p.title || '').trim();
        const tool = String(p.toolName || p.title || 'tool call');
        const title = 'ZCode 请求权限: ' + tool + (subject ? ' · ' + subject.slice(0, 120) : '');
        // "Always allow" is offered only when zcode itself offers it. zcode persists the rule
        // (project-scoped = the session workspace, exact command match) in its own DB; the AA
        // side stores nothing and only forwards the action.
        // Keep the option's response object: zcode's reply schema for interaction/requestPermission
        // is strict ({decision, reason?, permissionUpdates?}); the whole option is rejected.
        const pick = (kinds) => { const o = opts.find((x) => x && x.response && x.response.decision === 'allow' && kinds.includes(x.kind) || x && x.response && x.response.decision === 'allow' && kinds.includes(x.optionId)); return (o && o.response) || null; };
        const always = pick(['allow_always', 'allow_project']);
        const sessionAlways = pick(['allow_session', 'allowSession']);
        const dir = sessionDirs.get(zsid) || '';
        const actions = [{ actionId: 'allow', label: '允许', style: 'primary' }];
        if (always) actions.push({ actionId: 'allow_project', label: '始终允许此命令' + (dir ? '（' + shortPath(dir) + '）' : '（本项目）'), style: 'primary' });
        if (sessionAlways) actions.push({ actionId: 'allow_session', label: '本会话不再询问 ' + tool, style: 'primary' });
        actions.push({ actionId: 'deny', label: '拒绝', style: 'danger' });
        pendingPerm.set(rid, { as: this, rawId: f.id, allow, deny, fallback, always, sessionAlways, at: Date.now(), zsid, title, dir });
        syncIngest('notice.upsert', {
          noticeId: 'zcperm:' + rid, sessionId: zsid, type: 'interaction',
          title, message: permSummary(p, subject), severity: 'warning', status: 'open', interactionType: 'approval', responseRequired: true,
          // AA's NoticeIn requires actions[].actionId (label/style optional); id/kind is rejected with 400.
          actions,
          source: { runtime: 'zcode-bridge' },
          context: {
            tool: p.toolName || null, subject: subject || null, riskLevel: p.riskLevel || null, reason: p.reason || null,
            options: opts.map((o) => o && ({ optionId: o.optionId || null, kind: o.kind || null, name: o.name || o.label || null, decision: (o.response && o.response.decision) || null })),
            sessionId: zsid, requestId: rid, toolCallId: p.toolCallId || null, turnId: p.turnId || null,
          },
          metadata: { zcodeRequestId: rid, timeoutMs: PERM_TIMEOUT_MS },
        });
        log('permission(pending->AA) id=' + rid + ' jsonrpc=' + f.id + ' zsid=' + zsid.slice(-8) + ' subject=' + subject.slice(0, 80) + ' keys=' + Object.keys(p).join(',') + ' opts=' + opts.map((o) => (o && o.optionId) || '?').join('/') + ' policy=' + (p.optionsPolicy || '-') + ' risk=' + (p.riskLevel || '-'));
        return;  // answered later via sessionRespond
      }
    }
    this.replyServer(f.id, reply);
  }
  replyServer(id, result) {
    try { this.proc.stdin.write(JSON.stringify({ id, result }) + '\n'); } catch (e) {}
  }
  stop() {
    if (this.proc) { try { this.proc.kill('SIGTERM'); } catch (e) {} }
  }
}

// ---------- bridge wiring ----------
let serverConn = null;
let clientConn = null;
const subscriptions = new Map();  // subId -> { seq, batch, nextBatch, inFlight, ws }
const pendingPerm = new Map();    // String(zcode params.requestId) -> { as, rawId (latest JSON-RPC id), allow, deny, fallback, at, zsid, title }
const PERM_TIMEOUT_MS = 10 * 60 * 1000;
const sessionDirs = new Map();  // zsid -> workspace path the session was created in (= zcode project)

function permSummary(p, subject) {
  const bits = [];
  if (subject) bits.push(String(subject).slice(0, 600));
  if (p.toolName) bits.push('tool: ' + String(p.toolName));
  for (const k of ['reason', 'message', 'description', 'detail']) {
    if (typeof p[k] === 'string' && p[k]) bits.push(p[k].slice(0, 400));
  }
  const opts = Array.isArray(p.options) ? p.options : [];
  for (const o of opts) {
    if (!o) continue;
    const label = o.name || o.label || o.optionId || '';
    const decision = (o.response && o.response.decision) || '';
    if (label || decision) bits.push('- ' + label + (decision ? ' (' + decision + ')' : ''));
  }
  return bits.join('\n');
}

function shortPath(p) {
  const h = process.env.HOME || '';
  return h && p.startsWith(h) ? '~' + p.slice(h.length) : p;
}

// Which zcode option an AA action maps to. An action AA did not offer resolves to a deny:
// never grant a broader permission than the one the user clicked.
function permissionResponseFor(pend, actionId) {
  // A reply without a decision can never be sent to zcode (strict schema): fall back to deny.
  const ok = (r) => !!(r && typeof r.decision === 'string');
  if (actionId === 'allow') return { resp: ok(pend.allow) ? pend.allow : pend.fallback, status: 'resolved' };
  if (actionId === 'deny') return { resp: ok(pend.deny) ? pend.deny : { decision: 'deny', reason: 'denied by user' }, status: 'cancelled' };
  if (actionId === 'allow_project' && ok(pend.always)) return { resp: pend.always, status: 'resolved' };
  if (actionId === 'allow_session' && ok(pend.sessionAlways)) return { resp: pend.sessionAlways, status: 'resolved' };
  return { resp: pend.deny || { decision: 'deny', reason: 'unsupported action ' + actionId }, status: 'cancelled' };
}

function closePermission(rid, status, reason) {
  const pend = pendingPerm.get(rid);
  if (!pend) return null;
  pendingPerm.delete(rid);
  syncIngest('notice.upsert', {
    noticeId: 'zcperm:' + rid, sessionId: pend.zsid, type: 'interaction', title: pend.title,
    severity: 'warning', status, interactionType: 'approval', responseRequired: false, actions: [],
    source: { runtime: 'zcode-bridge' }, metadata: { reason: reason || null, zcodeRequestId: rid },
  });
  return pend;
}

// Deny approvals nobody answered; also clears leftovers after an app-server exit.
const permSweep = setInterval(() => {
  const now = Date.now();
  for (const rid of Array.from(pendingPerm.keys())) {
    const pend = pendingPerm.get(rid);
    if (!pend || now - pend.at < PERM_TIMEOUT_MS) continue;
    closePermission(rid, 'expired', 'approval timed out');
    pend.as.replyServer(pend.rawId, pend.deny || { decision: 'deny', reason: 'approval timed out' });
    log('permission.timeout id=' + rid + ' -> deny');
  }
}, 30000);
if (permSweep.unref) permSweep.unref();

function flushSubscription(subId) {
  const sub = subscriptions.get(subId);
  if (!sub || sub.inFlight || sub.batch.length === 0) return;
  if (!clientConn) return;
  sub.inFlight = true;
  const callId = 'batch-' + subId.slice(0, 8) + '-' + sub.nextBatch;
  const payload = { batch: { subscriptionId: subId, batchNumber: sub.nextBatch, events: sub.batch.slice(0, 50) } };
  sub.pendingAck = sub.batch.length;
  clientConn.send(JSON.stringify({ kind: 'call.open', call_id: callId, service: SYNC, method: 'ingestBatch', payload, timeout_ms: 30000 }));
  sub.callId = callId;
}

function ackSubscription(callId, ok) {
  for (const [subId, sub] of subscriptions) {
    if (sub.callId !== callId) continue;
    sub.inFlight = false;
    if (ok) {
      sub.batch = sub.batch.slice(sub.pendingAck);
      sub.nextBatch += 1;
      flushSubscription(subId);
    }
    return;
  }
}

function syncIngest(method, params) {
  const raw = { method, params };
  for (const [subId, sub] of subscriptions) {
    if (sub.batch.length > 500) continue;  // backpressure guard
    sub.batch.push(raw);
    flushSubscription(subId);
  }
}

const app = new AppServer((method, params) => {
  if (method === 'session/event' || method === 'state.updated') {
    try { syncIngest(method, params); } catch (e) {}
  }
  if (method === 'session/event' && /^(turn\.(completed|failed|terminal|cancelled|aborted))$/.test(String(params.type || (params.payload && params.payload.kind) || ''))) {
    for (const rid of Array.from(pendingPerm.keys())) {
      const pend = pendingPerm.get(rid);
      if (pend && (!pend.zsid || !params.sessionId || pend.zsid === params.sessionId)) {
        closePermission(rid, 'closed', 'turn ended');
        log('permission.closed(turn-end) id=' + rid);
      }
    }
  }
});

function startKeepalive(w, role) {
  w._ponged = true;
  const t = setInterval(() => {
    if (!w.sock || w.sock.readyState !== 1) return;
    if (!w._ponged) { log(role + '.keepalive.dead — terminating'); try { w.sock.terminate(); } catch (e) {} return; }
    w._ponged = false;
    w.send(JSON.stringify({ kind: 'ping', nonce: randomBytes(8).toString('hex') }));
  }, 15000);
  if (t.unref) t.unref();
}

async function connectRouter(role) {
  log('connectRouter(' + role + ') from ' + (new Error().stack.split(String.fromCharCode(10))[2] || '?').trim().slice(0, 60));
  let rd;
  try { rd = JSON.parse(readFileSync(RENDEZVOUS, 'utf8')); } catch (e) { log('rendezvous.fail ' + e.message); return null; }
  const w = new WsUnix(rd.endpoint.unixPath);
  try { await w.open({ Authorization: 'Bearer ' + rd.key }); } catch (e) { log('upgrade.FAIL ' + e.message); return null; }
  log('upgrade.OK');
  w.on('message', (s) => {
    let f; try { f = JSON.parse(s); } catch (e) { log('frame.parse.fail len=' + s.length); return; }
    log(role + '<' + (f.kind || '?') + (f.method ? ':' + f.method : '') + (f.call_id ? ' id=' + String(f.call_id).slice(0, 14) : '') + '>');
    if (f.kind === 'ping') { w.send(JSON.stringify({ kind: 'pong', nonce: f.nonce })); return; }
    if (f.kind === 'pong') { w._ponged = true; return; }
    if (role === 'server') {
      if (f.kind === 'hello.ack') {
        w.send(JSON.stringify({
          kind: 'server.register', instance_id: INSTANCE,
          services: [{ name: SERVICE, methods: [
            { name: 'initialize', stream: 'unary', balance: { kind: 'disabled' } },
            { name: 'sessionStart', stream: 'unary', balance: { kind: 'disabled' } },
            { name: 'sessionSend', stream: 'unary', balance: { kind: 'disabled' } },
            { name: 'sessionStop', stream: 'unary', balance: { kind: 'disabled' } },
            { name: 'sessionList', stream: 'unary', balance: { kind: 'disabled' } },
            { name: 'modelCatalog', stream: 'unary', balance: { kind: 'disabled' } },
            { name: 'sessionSelect', stream: 'unary', balance: { kind: 'disabled' } },
            { name: 'sessionRespond', stream: 'unary', balance: { kind: 'disabled' } },
            { name: 'sync', stream: 'server_stream', balance: { kind: 'disabled' } },
            { name: 'shutdown', stream: 'unary', balance: { kind: 'disabled' } },
          ]}],
        }));
        log('sent server.register');
      }
      if (f.kind === 'server.register.ack') log('REGISTER.ACK');
      if (f.kind === 'call.open') handleCall(w, f);
      return;
    }
    // client connection: batch acknowledgements
    if (f.kind === 'call.result' || f.kind === 'call.error') {
      ackSubscription(f.call_id, f.kind === 'call.result');
      if (f.kind === 'call.error') log('ingestBatch rejected: ' + JSON.stringify(f.error).slice(0, 140));
    }
  });
  w.on('close', (code, reason) => { log(role + ' closed code=' + code + ' reason=' + (reason || '').slice(0, 100) + ' — reconnect 5s'); if (role === 'server') serverConn = null; else clientConn = null; });
  w.on('error', (e) => log(role + ' error ' + e.message));
  w.send(JSON.stringify({ kind: 'hello', protocol: 'meshcall/1', role, peer_id: 'aa-bridge-' + role, instance_id: INSTANCE }));
  startKeepalive(w, role);
  log(role + '.hello.sent');
  return w;
}

async function handleCall(w, f) {
  const m = f.method || '';
  const payload = f.payload || {};
  if (m === 'sync') {
      const subId = String(payload.subscriptionId || '');
      if (!subId) throw new Error('subscriptionId required');
      const sub = { seq: 0, batch: [], nextBatch: 1, inFlight: false, pendingAck: 0, callId: null };
      subscriptions.set(subId, sub);
      w.send(JSON.stringify({ kind: 'stream.item', call_id: f.call_id, direction: 'server', sequence: 0, payload: { kind: 'subscribed', subscriptionId: subId } }));
      log('sync.subscribed ' + subId.slice(0, 12) + ' call=' + String(f.call_id).slice(0, 10));
      w.on('close', () => { subscriptions.delete(subId); });
      return;  // stream stays open; more items can follow
    }
  const reply = (payload) => w.send(JSON.stringify({ kind: 'call.result', call_id: f.call_id, payload }));
  const fail = (code, message) => w.send(JSON.stringify({ kind: 'call.error', call_id: f.call_id, error: { code, message, retryable: false } }));
  try {
    if (f.method === 'initialize') {
      reply({ protocolVersion: '0.2', plugin: 'aa-bridge-v3.6.1', instance: INSTANCE, pid: process.pid, node: process.version });
    } else if (f.method === 'sessionStart') {
      const wsPath = (f.payload && f.payload.workspacePath) || WORKBASE;
      const r = await app.call('session/create', { workspace: { workspacePath: wsPath, workspaceKey: wsPath } }, 30000);
      const zsid = (r && r.session && r.session.sessionId) || '';
      if (zsid) sessionDirs.set(zsid, wsPath);
      try { await app.call('session/subscribe', { sessionId: zsid, deliveryKind: 'desktop-continuous' }, 15000); log('subscribe OK ' + zsid); } catch (e) { log('subscribe FAIL ' + e.message); }
      log('sessionStart -> ' + zsid);
      reply({ zcodeSessionId: zsid, raw: r || null });
    } else if (f.method === 'modelCatalog') {
      // 0.2.2: list providers/models from zcode's static provider config.
      // Catalog must be answerable without a live app-server session.
      const models = [];
      try {
        const pc = JSON.parse(readFileSync(HOME + '/.zcode/v2/provider_config.json', 'utf8'));
        const rules = ((pc.config || {}).providerConfigRules || {}).providerRules || [];
        const byId = new Map(rules.map((r) => [r.providerId, r]));
        for (const pid of ((pc.config || {}).providerOrder || [])) {
          const rule = byId.get(pid);
          if (!rule) continue;
          const name = rule.providerName || pid.slice(0, 8);
          for (const mid of ((rule.config || {}).personalModelIds || [])) {
            models.push({ providerId: pid, providerName: name, modelId: mid });
          }
        }
      } catch (e) { log('modelCatalog read fail: ' + e.message); }
      reply({ models });
    } else if (f.method === 'sessionSelect') {
      // 0.2.2: apply model / thought-level / mode selections to a session.
      // Level fallback ladder mirrors the proven in-process adapter.
      const zsid = f.payload && f.payload.zcodeSessionId;
      const applied = { model: false, mode: false };
      const errors = [];
      const model = f.payload && f.payload.model;
      if (model && model.providerId && model.modelId) {
        const cands = [];
        if (model.reasoningLevel) cands.push(model.reasoningLevel);
        cands.push('high', 'medium', 'low', 'xhigh', 'minimal', 'none', 'default');
        let done = false;
        for (const lv of cands) {
          if (done) break;
          try {
            await app.call('session/setModel', { sessionId: zsid, model: { providerId: model.providerId, modelId: model.modelId, options: { reasoningLevel: lv } } }, 15000);
            applied.model = true; done = true;
          } catch (e) {
            const t = e.message || String(e);
            if (t.includes('not supported') || t.includes('required')) continue;
            errors.push('setModel: ' + t.slice(0, 80));
            break;
          }
        }
        if (!done) {
          try {
            await app.call('session/setModel', { sessionId: zsid, model: { providerId: model.providerId, modelId: model.modelId } }, 15000);
            applied.model = true;
          } catch (e) { errors.push('setModel(no-opts): ' + (e.message || String(e)).slice(0, 80)); }
        }
      }
      const mode = f.payload && f.payload.mode;
      if (mode) {
        try {
          await app.call('session/setMode', { sessionId: zsid, mode }, 15000);
          applied.mode = true;
        } catch (e) { errors.push('setMode: ' + (e.message || String(e)).slice(0, 80)); }
      }
      log('sessionSelect ' + zsid + ' model=' + applied.model + ' mode=' + applied.mode + (errors.length ? ' err=' + errors.length : ''));
      reply({ applied, errors });
    } else if (f.method === 'sessionSend') {
      const zsid = f.payload && f.payload.zcodeSessionId;
      const content = (f.payload && f.payload.content) || '';
      const r = await app.call('session/send', { sessionId: zsid, content }, 30000);
      reply({ accepted: !!(r && r.accepted), raw: r || null });
    } else if (f.method === 'sessionStop') {
      const zsid = f.payload && f.payload.zcodeSessionId;
      const r = await app.call('session/stop', { sessionId: zsid }, 15000);
      reply({ stopped: true, raw: r || null });
    } else if (f.method === 'sessionList') {
      const r = await app.call('session/list', {}, 30000);
      reply({ sessions: (r && r.sessions) || [], count: (r && r.sessions && r.sessions.length) || 0 });
    } else if (f.method === 'sessionRespond') {
      // v3.4: AA answered a parked interaction/requestPermission.
      const rid = String((f.payload && f.payload.noticeId) || '').replace(/^zcperm:/, '');
      const actionId = String((f.payload && f.payload.actionId) || 'deny');
      const pend = pendingPerm.get(rid);
      if (!pend) { reply({ responded: false, reason: 'no pending permission', noticeId: 'zcperm:' + rid }); return; }
      pendingPerm.delete(rid);
      const { resp, status } = permissionResponseFor(pend, actionId);
      pend.as.replyServer(pend.rawId, resp);
      const rules = Array.isArray(resp && resp.permissionUpdates) ? ((resp.permissionUpdates[0] && resp.permissionUpdates[0].rules) || []) : [];
      if (rules.length) log('permission.rule-sent id=' + rid + ' zsid=' + pend.zsid + ' project=' + (pend.dir || '?') + ' rules=' + JSON.stringify(rules).slice(0, 300));
      syncIngest('notice.upsert', {
        noticeId: 'zcperm:' + rid, sessionId: pend.zsid, type: 'interaction', title: pend.title,
        severity: 'warning', status, interactionType: 'approval',
        responseRequired: false, actions: [], source: { runtime: 'zcode-bridge' },
        metadata: { zcodeRequestId: rid, actionId, persistedRules: rules.length ? rules : null, project: pend.dir || null },
      });
      log('permission.answered id=' + rid + ' -> ' + actionId + ' (' + (resp.decision || '?') + (rules.length ? ', rule requested' : '') + ')');
      reply({ responded: true, actionId, decision: resp.decision || null });
    } else if (f.method === 'shutdown') {
      reply({ bye: true });
      setTimeout(() => { app.stop(); process.exit(0); }, 200);
    } else {
      fail('method_not_found', 'unknown method ' + f.method);
    }
  } catch (e) {
    fail('internal', String(e.message || e).slice(0, 200));
  }
}

export async function main() {
  if (globalThis.__AA_BRIDGE_ACTIVATED) return;
  globalThis.__AA_BRIDGE_ACTIVATED = true;
  log('activate (guarded)');

  log('=== aa-bridge-v3 START pid=' + process.pid + ' workbase=' + WORKBASE);
  serverConn = await connectRouter('server');
  clientConn = await connectRouter('client');
  // v0.3.1: health-check supervision. A connection object can outlive its
  // socket (zombie: readyState !== 1 but never emits close), so null-checks
  // alone never reconnect. Terminate anything not OPEN, then reconnect; the
  // server connection re-registers its services on hello.ack.
  const connHealthy = (c) => c && c.sock && c.sock.readyState === 1;
  setInterval(async () => {
    if (!connHealthy(serverConn)) {
      try { if (serverConn && serverConn.sock) serverConn.sock.terminate(); } catch (e) {}
      serverConn = await connectRouter('server');
    }
    if (!connHealthy(clientConn)) {
      try { if (clientConn && clientConn.sock) clientConn.sock.terminate(); } catch (e) {}
      clientConn = await connectRouter('client');
    }
  }, 5000);
  const srv = createServer((s) => {
    s.on('data', () => { try { s.write(JSON.stringify({ proto: 'aa-bridge-v3', alive: true, ts: Date.now() }) + '\n'); } catch (e) {} });
  });
  srv.on('error', (e) => log('ops.sock.error ' + e.message));
  try { require_unlink(OPSOCK); } catch (e) {}
  try { srv.listen(OPSOCK); log('ops.listening'); } catch (e) { log('ops.fail ' + e.message); }
  process.on('SIGTERM', () => { log('SIGTERM bye'); app.stop(); process.exit(0); });
  return new Promise(() => {});
}
export function deactivate() { log('DEACTIVATE'); app.stop(); }
// ---------- rev5 note ----------
// The module already exports main() (above). The standalone __zcode-plugin-host
// imports and invokes it; a future desktop extension host would do the same.
// No duplicate exports: an extra main here once killed the whole module load
// (Identifier has already been declared) — keep this file single-declaration.
