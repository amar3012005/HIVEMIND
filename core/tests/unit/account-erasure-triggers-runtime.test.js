// Account erasure clears connected-app triggers (disable, never delete; shared triggers kept) and asks Runtime to archive
// the account's sessions with a signed, verified receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { eraseAccountTriggers } from '../../src/security/account-erasure-triggers.js';
import { eraseRuntimeAccount } from '../../src/security/account-erasure-runtime.js';

const user = '11111111-1111-4111-8111-111111111111';

function triggerDb({ shared = [] } = {}) {
  const updates = [];
  return { updates, $queryRawUnsafe: async (sql, ...args) => sql.includes('SELECT DISTINCT remote_id') ? [{ remote_id: 'ti_a' }, { remote_id: 'ti_b' }, { remote_id: 'ti_gone' }] : (shared.includes(args[0]) ? [{ '?column?': 1 }] : []),
    $executeRawUnsafe: async (sql, id) => { updates.push([sql.match(/status='(\w+)'/)[1], id]); return 3; } };
}

test('disables triggers only this account uses, keeps shared ones, tolerates gone ones, and marks subscriptions removed', async () => {
  const db = triggerDb({ shared: ['ti_b'] });
  const calls = [];
  const request = async (method, path, body) => { calls.push([method, path, body]); if (path.endsWith('ti_gone')) throw Object.assign(new Error('nf'), { status: 404 }); return {}; };
  const receipt = await eraseAccountTriggers(db, user, { request });
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['PATCH', '/trigger_instances/manage/ti_a'], ['PATCH', '/trigger_instances/manage/ti_gone']]);
  assert.deepEqual(calls[0][2], { status: 'disable' });
  assert.deepEqual(receipt, { disabled: 1, alreadyGone: 1, sharedKept: 1, removed: 3 });
  assert.deepEqual(db.updates, [['removed', user]]);
});

test('a Composio failure throws before any subscription is marked removed', async () => {
  const db = triggerDb();
  await assert.rejects(eraseAccountTriggers(db, user, { request: async () => { throw Object.assign(new Error('x'), { status: 502 }); } }), error => error.code === 'COMPOSIO_TRIGGER_ERASURE_UNAVAILABLE');
  assert.deepEqual(db.updates, []);
});

const secret = 's'.repeat(40);
const env = { HIVEMIND_EMPLOYEE_LIFECYCLE_URL: 'https://runner.example/internal/hivemind/employee-lifecycle', HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret };

test('Runtime erasure posts a signed body to the account-erasure path and requires a matching verified receipt', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url: String(url), init }; return new Response(JSON.stringify({ verified: true, operationId: 'op', archivedSessions: 3, removedWakes: 2 })); };
  const receipt = await eraseRuntimeAccount({ operationId: 'op', userId: user, orgIds: ['b', 'a'] }, { env, fetchImpl });
  assert.deepEqual(receipt, { verified: true, operationId: 'op', archivedSessions: 3, removedWakes: 2 });
  assert.equal(seen.url, 'https://runner.example/internal/hivemind/account-erasure');
  const token = seen.init.headers.authorization.slice(7);
  const [header, claims, signature] = token.split('.');
  assert.equal(signature, createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url'));
  const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(decoded.aud, 'hivemind-account-erasure');
  assert.equal(decoded.sub, user);
  assert.equal(decoded.body_sha256, createHash('sha256').update(seen.init.body).digest('hex'));
  assert.deepEqual(JSON.parse(seen.init.body).orgIds, ['a', 'b']);
});

test('Runtime erasure fails closed when unconfigured or unverified', async () => {
  await assert.rejects(eraseRuntimeAccount({ operationId: 'op', userId: user, orgIds: [] }, { env: {}, fetchImpl: async () => { throw new Error('unreachable'); } }), error => error.code === 'RUNTIME_ERASURE_UNAVAILABLE');
  for (const body of [{ verified: false }, { verified: true, operationId: 'other', archivedSessions: 0, removedWakes: 0 }]) {
    await assert.rejects(eraseRuntimeAccount({ operationId: 'op', userId: user, orgIds: [] }, { env, fetchImpl: async () => new Response(JSON.stringify(body)) }), error => error.code === 'RUNTIME_ERASURE_INCOMPLETE');
  }
  await assert.rejects(eraseRuntimeAccount({ operationId: 'op', userId: user, orgIds: [] }, { env, fetchImpl: async () => { throw new Error('down'); } }), error => error.code === 'RUNTIME_ERASURE_INCOMPLETE');
});
