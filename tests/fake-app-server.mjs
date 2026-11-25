// A stand-in for `zcode app-server`: the JSONL protocol over stdio that index.mjs speaks, without
// zcode. Run by the plugin as its app-server (tests/plugin_session_resume_test.mjs points
// AA_ZCODE_BOOTSTRAP at this file). Every request is appended to the file named by AA_TEST_APPLOG
// before it is answered, so a test can read the order the plugin issued them in.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.env.AA_TEST_APPLOG;
const answer = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');

createInterface({ input: process.stdin }).on('close', () => process.exit(0)).on('line', (line) => {
  let f;
  try { f = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = f;
  if (log) appendFileSync(log, JSON.stringify(f) + '\n');
  // What zcode answers for a session it has no record of / has not loaded.
  if (method === 'session/resume' && params.sessionId === 'sess_gone') {
    answer({ id, error: { code: -32004, message: 'Session not found: ' + params.sessionId } });
    return;
  }
  if (method === 'session/subscribe' && params.sessionId === 'sess_nosub') {
    answer({ id, error: { code: -32004, message: 'Session is not active: ' + params.sessionId } });
    return;
  }
  const results = {
    'session/list': { sessions: [] },
    'session/create': { session: { sessionId: 'sess_new' } },
    'session/resume': { session: { sessionId: params.sessionId, workspace: { workspacePath: '/fixture/project' } } },
    'session/subscribe': { eventSeq: 0, events: [], sessionId: params.sessionId },
    'session/send': { accepted: true },
  };
  answer({ id, result: results[method] || {} });
});
