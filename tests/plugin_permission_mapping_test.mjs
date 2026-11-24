// Unit-tests the pure helpers of index.mjs by extracting their source.
// Targets the checked-in index.mjs, or the one AA_BRIDGE_ENTRY points at (the release packaging runs
// the same tests against the extracted zip).
// Run: node tests/plugin_permission_mapping_test.mjs [path/to/index.mjs]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
const factory = new Function(extract('shortPath') + '\n' + extract('permissionResponseFor') + '\nreturn { shortPath, permissionResponseFor };');
const { shortPath, permissionResponseFor } = factory({});

const once = { decision: 'allow', reason: 'Approved once' };
const always = { decision: 'allow', reason: 'Approved for this project', permissionUpdates: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'touch /tmp/x' }] }] };
const session = { decision: 'allow', reason: 'Approved for this session', sessionPermissionUpdates: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash' }] }] };
const deny = { decision: 'deny', reason: "The user doesn't want to proceed" };
const full = { allow: once, deny, fallback: once, always, sessionAlways: session };
const plain = { allow: once, deny, fallback: once, always: null, sessionAlways: null };

let n = 0;
const check = (name, ok) => { assert.ok(ok, name); n += 1; console.log('PASS ' + name); };

check('allow -> allow_once, resolved', permissionResponseFor(full, 'allow').resp === once && permissionResponseFor(full, 'allow').status === 'resolved');
check('deny -> deny, cancelled', permissionResponseFor(full, 'deny').resp === deny && permissionResponseFor(full, 'deny').status === 'cancelled');
const ap = permissionResponseFor(full, 'allow_project');
check('allow_project -> zcode allow_always response carrying permissionUpdates, resolved', ap.resp === always && ap.status === 'resolved' && ap.resp.permissionUpdates[0].rules[0].ruleContent === 'touch /tmp/x');
check('allow_session -> zcode session response, resolved', permissionResponseFor(full, 'allow_session').resp === session && permissionResponseFor(full, 'allow_session').status === 'resolved');
const notOffered = permissionResponseFor(plain, 'allow_project');
check('allow_project when zcode did not offer it -> deny, cancelled', notOffered.resp.decision === 'deny' && notOffered.status === 'cancelled');
check('unknown action -> deny, cancelled', permissionResponseFor(full, 'yolo').resp.decision === 'deny' && permissionResponseFor(full, 'yolo').status === 'cancelled');
check('missing pend.deny still denies', permissionResponseFor({ allow: once, fallback: once }, 'deny').resp.decision === 'deny');
const garbage = { allow: once, deny, fallback: once, always: { kind: 'allow_always', optionId: 'allow_project', response: always }, sessionAlways: null };
check('a non-response object in pend.always -> deny, never a malformed reply', permissionResponseFor(garbage, 'allow_project').resp.decision === 'deny');
check('missing allow falls back without a malformed reply', permissionResponseFor({ fallback: once }, 'allow').resp.decision === 'allow');
check('shortPath collapses HOME', shortPath(homedir() + '/x') === '~/x' && shortPath('/tmp/y') === '/tmp/y');
console.log('RESULT: ALL PASS (' + n + ')');
