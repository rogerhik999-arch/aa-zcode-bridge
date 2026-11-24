// Unit-tests the event sync queue of index.mjs (aa.zcode.v2.Sync): what is sent is
// what an ack removes, a connection loss does not stall a subscription, a call.cancel
// ends it, and a queue past its limit counts what it drops instead of losing it silently.
// The functions are extracted from the source and run against stand-ins for the maps,
// the connection and the log, the way plugin_permission_mapping_test.mjs does.
// Targets the checked-in index.mjs, or the one AA_BRIDGE_ENTRY points at (the release
// packaging runs the same tests against the extracted zip).
// Run: node tests/plugin_sync_queue_test.mjs [path/to/index.mjs]
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const file = process.argv[2] || process.env.AA_BRIDGE_ENTRY || fileURLToPath(new URL('../index.mjs', import.meta.url));
const src = readFileSync(file, 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found in ' + file);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 2);
}
const connOpen = src.match(/const connOpen = \(c\) => [^\n]+/);
assert.ok(connOpen, 'connOpen not found');

const NAMES = ['connOpen', 'flushSubscription', 'flushAll', 'releaseInFlight', 'retryTimedOut', 'ackSubscription', 'syncIngest', 'cancelSubscription', 'queuedEvents'];
const source = connOpen[0] + '\n' + NAMES.slice(1).map(extract).join('\n')
  + '\nreturn {' + NAMES.join(', ') + '};';

function world() {
  const subscriptions = new Map();
  const streamCalls = new Map();
  const sent = [];
  const logs = [];
  const conn = { sock: { readyState: 1 }, send: (text) => sent.push(JSON.parse(text)) };
  const api = new Function('subscriptions', 'streamCalls', 'clientConn', 'SYNC', 'MAX_BATCH_EVENTS', 'MAX_QUEUED_EVENTS', 'INGEST_TIMEOUT_MS', 'log', source)(
    subscriptions, streamCalls, conn, 'aa.zcode.v2.Sync', 50, 500, 35000, (m) => logs.push(m));
  const subscribe = (subId, callId) => {
    subscriptions.set(subId, { batch: [], nextBatch: 1, inFlight: false, pendingAck: 0, callId: null, attempt: 0, sentAt: 0, dropped: 0 });
    streamCalls.set(callId, subId);
  };
  return { api, subscriptions, streamCalls, sent, logs, conn, subscribe };
}
const clock = { now: 1000000 };
const realNow = Date.now;
Date.now = () => clock.now;

let n = 0;
const check = (name, ok) => { assert.ok(ok, name); n += 1; console.log('PASS ' + name); };
const numbers = (w) => w.sent.map((f) => f.payload.batch.batchNumber + ':' + f.payload.batch.events.length).join(' ');

try {
  // 1. a queue longer than one batch: every event is sent exactly once
  let w = world(); w.subscribe('abcdefgh1111', 'call-1');
  for (let i = 0; i < 120; i += 1) w.api.syncIngest('session/event', { i });
  // Stop-and-wait: the first event goes out at once, the other 119 queue up behind it. The queue
  // keeps the events in flight until they are acked: unsent is not the same as delivered.
  check('the first event goes out at once and the rest waits for the ack', numbers(w) === '1:1' && w.subscriptions.get('abcdefgh1111').batch.length === 120);
  w.api.ackSubscription(w.sent[0].call_id, true);
  check('the ack removes exactly the 1 sent and sends the next 50', numbers(w) === '1:1 2:50' && w.sent[1].payload.batch.events[0].params.i === 1);
  w.api.ackSubscription(w.sent[1].call_id, true);
  check('the next 50 follow', numbers(w) === '1:1 2:50 3:50' && w.sent[2].payload.batch.events[0].params.i === 51);
  w.api.ackSubscription(w.sent[2].call_id, true);
  check('the last 19 come last', numbers(w) === '1:1 2:50 3:50 4:19' && w.sent[3].payload.batch.events[0].params.i === 101);
  w.api.ackSubscription(w.sent[3].call_id, true);
  const seen = w.sent.flatMap((f) => f.payload.batch.events.map((e) => e.params.i));
  check('all 120 events were sent, each exactly once, in order', seen.length === 120 && seen.every((v, i) => v === i) && w.subscriptions.get('abcdefgh1111').batch.length === 0);

  // 2. events that arrive while a batch is in flight are kept
  w = world(); w.subscribe('abcdefgh2222', 'call-2');
  w.api.syncIngest('session/event', { i: 0 });
  w.api.syncIngest('session/event', { i: 1 });
  check('nothing is sent while a batch is in flight', w.sent.length === 1);
  w.api.ackSubscription(w.sent[0].call_id, true);
  check('the event queued behind the batch goes out next under the next number', numbers(w) === '1:1 2:1');

  // 3. a repeat answer must not remove events twice
  w = world(); w.subscribe('abcdefgh3333', 'call-3');
  for (let i = 0; i < 80; i += 1) w.api.syncIngest('session/event', { i });
  const first = w.sent[0].call_id;
  w.api.ackSubscription(first, true);
  const second = w.sent[1].call_id;
  w.api.ackSubscription(first, true);
  check('a repeat of the first ack changes nothing', w.sent.length === 2 && w.subscriptions.get('abcdefgh3333').batch.length === 79);
  w.api.ackSubscription(second, true);
  check('the second ack still removes its own 50', numbers(w) === '1:1 2:50 3:29' && w.subscriptions.get('abcdefgh3333').batch.length === 29);
  w.api.ackSubscription(w.sent[2].call_id, true);
  check('the third ack clears the queue', w.sent.length === 3 && w.subscriptions.get('abcdefgh3333').batch.length === 0);

  // 4. the client connection is lost while a batch is in flight
  w = world(); w.subscribe('abcdefgh4444', 'call-4');
  w.api.syncIngest('session/event', { i: 0 });
  w.conn.sock.readyState = 3;                       // the socket closed
  w.api.releaseInFlight('client-closed');
  w.api.syncIngest('session/event', { i: 1 });
  check('nothing is sent while there is no connection', w.sent.length === 1);
  w.conn.sock.readyState = 1;                       // reconnected
  w.api.flushAll();
  check('after the reconnect the same batch goes out again under its number', numbers(w) === '1:1 1:2' && w.sent[1].payload.batch.events.length === 2);
  check('the release is logged with its reason', w.logs.some((m) => m.startsWith('sync.release sub=abcdefgh batch=1 reason=client-closed')));
  w.api.ackSubscription(w.sent[0].call_id, true);   // a late answer to the lost attempt
  check('a late answer to the lost attempt is ignored', w.sent.length === 2 && w.subscriptions.get('abcdefgh4444').batch.length === 2);
  w.api.ackSubscription(w.sent[1].call_id, true);
  check('the answer to the new attempt clears the queue', w.subscriptions.get('abcdefgh4444').batch.length === 0);

  // 5. an ingest call that is never answered
  w = world(); w.subscribe('abcdefgh5555', 'call-5');
  w.api.syncIngest('session/event', { i: 0 });
  w.api.retryTimedOut(clock.now + 34999);
  check('before the timeout nothing is re-sent', w.sent.length === 1);
  w.api.retryTimedOut(clock.now + 35001);
  check('at the timeout the batch is sent again under the same number with a new call id',
    numbers(w) === '1:1 1:1' && w.sent[0].call_id !== w.sent[1].call_id && w.logs.some((m) => m.startsWith('sync.ingest-timeout sub=abcdefgh batch=1')));
  w.api.ackSubscription(w.sent[0].call_id, true);
  check('the answer to the timed-out attempt is ignored', w.subscriptions.get('abcdefgh5555').batch.length === 1 && w.sent.length === 2);
  w.api.ackSubscription(w.sent[1].call_id, true);
  check('the answer to the second attempt clears the queue', w.subscriptions.get('abcdefgh5555').batch.length === 0);

  // 6. a rejected call keeps its batch; the next event sends it again
  w = world(); w.subscribe('abcdefgh6666', 'call-6');
  w.api.syncIngest('session/event', { i: 0 });
  w.api.ackSubscription(w.sent[0].call_id, false);
  check('a rejected batch stays queued', w.subscriptions.get('abcdefgh6666').batch.length === 1);
  w.api.syncIngest('session/event', { i: 1 });
  check('the next event re-sends it under the same number', numbers(w) === '1:1 1:2');

  // 7. the queue limit counts what it drops
  w = world(); w.subscribe('abcdefgh7777', 'call-7');
  w.conn.sock.readyState = 3;                       // nothing can be sent, so the queue grows
  for (let i = 0; i < 502; i += 1) w.api.syncIngest('session/event', { i });
  const sub = w.subscriptions.get('abcdefgh7777');
  check('the queue stops at the limit and counts the two events beyond it', sub.batch.length === 500 && sub.dropped === 2);
  check('the drop is logged, once for the first and then per thousand', w.logs.filter((m) => m.startsWith('sync.queue-full')).length === 1 && /dropped=1$/.test(w.logs[0]));
  check('the ops status can report the queue', w.api.queuedEvents() === 500);

  // 8. call.cancel ends the subscription it names
  w = world(); w.subscribe('abcdefgh8888', 'call-8'); w.subscribe('abcdefgh9999', 'call-9');
  w.api.syncIngest('session/event', { i: 0 });
  check('cancelSubscription ends the stream it names and nothing else', w.api.cancelSubscription('call-8') === true && !w.subscriptions.has('abcdefgh8888') && w.subscriptions.has('abcdefgh9999'));
  w.api.syncIngest('session/event', { i: 1 });
  check('the cancelled subscription receives nothing further', w.sent.filter((f) => f.payload.batch.subscriptionId === 'abcdefgh8888').length === 1);
  check('an unknown call id is not an error', w.api.cancelSubscription('call-x') === false && w.logs.some((m) => m.startsWith('sync.cancelled abcdefgh9999 call=call-9')) === false);

  // 9. what the source wires up (these lines only run inside the plugin's sockets)
  check('the server connection answers call.cancel by ending the subscription', /if \(f\.kind === 'call\.cancel'\) \{ cancelSubscription\(String\(f\.call_id\)\); return; \}/.test(src));
  check('a sync call records its stream call id', /streamCalls\.set\(String\(f\.call_id\), subId\);/.test(src));
  check('losing the client connection releases the calls in flight', /releaseInFlight\('client-closed'\);/.test(src));
  check('the ingest timeout is swept and the queue flushed after a reconnect', /retryTimedOut\(Date\.now\(\)\);/.test(src) && (src.match(/flushAll\(\);/g) || []).length >= 2);
  check('the ops socket reports subscriptions and queue', /subscriptions: subscriptions\.size, queued: queuedEvents\(\)/.test(src));
} finally {
  Date.now = realNow;
}

console.log('RESULT: ALL PASS (' + n + ')');
