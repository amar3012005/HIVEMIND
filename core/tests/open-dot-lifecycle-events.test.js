import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  EVENT_KEY, openDotLifecycleTarget, signOpenDotRequest, lifecycleEventFor, deliverOpenDotLifecycleEvent, runtimeRemovalTarget,
  notifyRuntimeEmployeeRemoved, withRetries, announceEmployeeLifecycle, recoverPendingLifecycleEvents,
} from '../src/employees/open-dot-lifecycle-events.js';

const ORG = '33333333-3333-4333-8333-333333333333', USER = '22222222-2222-4222-8222-222222222222', EMP = '11111111-1111-4111-8111-111111111111';
const env = { OPEN_DOT_LIFECYCLE_EVENT_URL: 'https://dots.example/api/internal/hivemind/lifecycle', OPEN_DOT_LIFECYCLE_EVENT_SECRET: 'l'.repeat(40),
  HIVEMIND_EMPLOYEE_LIFECYCLE_URL: 'http://harness-runner:3080/internal/hivemind/employee-lifecycle', HIVE_HARNESS_RUNNER_SERVICE_SECRET: 'x'.repeat(48) };
const bound = (extra = {}) => ({ id: EMP, orgId: ORG, createdBy: USER, policyRules: { open_dot_employee: { version: 1, execution_backend: 'open-dot', state: 'bound', dot_id: 'dot_a', binding_revision: 1 },
  native_lifecycle: { phase: 'active', revision: 4, ...extra } } });

test('events exist only for an OpenDot-bound employee and carry a stable id', () => {
  const archived = lifecycleEventFor({ operation: 'pause_archive', employee: bound({ archive: { archived_at: '2026-10-30T10:00:00.000Z' } }), orgId: ORG });
  assert.equal(archived.type, 'archived'); assert.equal(archived.at, Date.parse('2026-10-30T10:00:00.000Z'));
  assert.deepEqual([archived.organizationId, archived.userId, archived.employeeId], [ORG, USER, EMP]);
  assert.equal(lifecycleEventFor({ operation: 'pause_archive', employee: bound({ archive: { archived_at: '2026-10-30T10:00:00.000Z' } }), orgId: ORG }).eventId, archived.eventId, 'a replay is the same event');
  assert.equal(lifecycleEventFor({ operation: 'unarchive', employee: bound({ unarchived_at: '2026-10-30T11:00:00.000Z' }), orgId: ORG }).type, 'unarchived');
  assert.equal(lifecycleEventFor({ operation: 'remove', employee: bound(), orgId: ORG, now: 5 }).at, 5);
  assert.equal(lifecycleEventFor({ operation: 'configure', employee: bound(), orgId: ORG }), null);
  assert.equal(lifecycleEventFor({ operation: 'pause_archive', employee: { id: EMP, createdBy: USER, policyRules: {} }, orgId: ORG }), null, 'a plain native employee has no OpenDot side');
  assert.equal(lifecycleEventFor({ operation: 'pause_archive', employee: { ...bound(), policyRules: { open_dot_employee: { version: 1, execution_backend: 'open-dot', state: 'provisioning' } } }, orgId: ORG }), null);
});

test('the target needs an https OpenDot URL on the exact path and a 32 byte secret', () => {
  assert.ok(openDotLifecycleTarget(env));
  for (const bad of [{}, { ...env, OPEN_DOT_LIFECYCLE_EVENT_URL: 'http://dots.example/api/internal/hivemind/lifecycle' }, { ...env, OPEN_DOT_LIFECYCLE_EVENT_URL: 'https://dots.example/other' },
    { ...env, OPEN_DOT_LIFECYCLE_EVENT_URL: 'https://u:p@dots.example/api/internal/hivemind/lifecycle' }, { ...env, OPEN_DOT_LIFECYCLE_EVENT_SECRET: 'short' }]) assert.equal(openDotLifecycleTarget(bad), null);
});

test('the signature is the OpenDot bridge scheme over the exact body', async () => {
  let seen;
  const event = { eventId: 'e1', type: 'archived', organizationId: ORG, userId: USER, employeeId: EMP, at: 1000 };
  const result = await deliverOpenDotLifecycleEvent(event, { env, fetchImpl: async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ received: true, applied: true }), { status: 200 }); } });
  assert.deepEqual(result, { status: 'delivered', applied: true });
  assert.equal(seen.init.redirect, 'error');
  const h = seen.init.headers, body = seen.init.body;
  const expected = createHmac('sha256', env.OPEN_DOT_LIFECYCLE_EVENT_SECRET).update(['POST', '/api/internal/hivemind/lifecycle', h['x-hivemind-bridge-timestamp'], h['x-hivemind-bridge-nonce'], createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
  assert.equal(h['x-hivemind-bridge-signature'], expected);
  assert.match(h['x-hivemind-bridge-nonce'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(JSON.parse(body), event);
  assert.notEqual(signOpenDotRequest('s'.repeat(40), { method: 'POST', path: '/p', body: 'x' })['x-hivemind-bridge-nonce'], signOpenDotRequest('s'.repeat(40), { method: 'POST', path: '/p', body: 'x' })['x-hivemind-bridge-nonce'], 'each attempt has its own nonce');
});

test('delivery never throws: unconfigured is skipped, failures and odd answers stay pending', async () => {
  const event = { eventId: 'e1', type: 'archived', organizationId: ORG, userId: USER, employeeId: EMP, at: 1 };
  assert.equal((await deliverOpenDotLifecycleEvent(event, { env: {}, fetchImpl: () => { throw Error('must not send'); } })).status, 'skipped');
  assert.equal((await deliverOpenDotLifecycleEvent(event, { env, fetchImpl: async () => { throw new TypeError('down'); } })).status, 'pending');
  assert.equal((await deliverOpenDotLifecycleEvent(event, { env, fetchImpl: async () => new Response('{"error":"x"}', { status: 503 }) })).status, 'pending');
  assert.equal((await deliverOpenDotLifecycleEvent(event, { env, fetchImpl: async () => new Response('not json', { status: 200 }) })).status, 'pending');
  assert.equal((await deliverOpenDotLifecycleEvent(event, { env, fetchImpl: async () => new Response('{"received":false}', { status: 200 }) })).status, 'pending');
});

test('the Runtime removal notice is a purpose separated token over the exact body', async () => {
  assert.equal(runtimeRemovalTarget({}), null);
  assert.equal(runtimeRemovalTarget({ ...env, HIVEMIND_EMPLOYEE_LIFECYCLE_URL: 'http://harness-runner:3080/wrong' }), null);
  let seen;
  const out = await notifyRuntimeEmployeeRemoved({ orgId: ORG, userId: USER, employeeId: EMP }, { env, fetchImpl: async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ status: 'removed', employeeId: EMP }), { status: 200 }); } });
  assert.equal(out.status, 'delivered');
  assert.equal(seen.url.pathname, '/internal/hivemind/employee-removed');
  const claims = JSON.parse(Buffer.from(seen.init.headers.authorization.slice(7).split('.')[1], 'base64url'));
  assert.equal(claims.aud, 'hivemind-employee-removed'); assert.equal(claims.sub, USER); assert.equal(claims.org_id, ORG);
  assert.equal(claims.body_sha256, createHash('sha256').update(seen.init.body).digest('hex'));
  assert.equal((await notifyRuntimeEmployeeRemoved({ orgId: ORG, userId: USER, employeeId: EMP }, { env, fetchImpl: async () => new Response(JSON.stringify({ status: 'removed', employeeId: 'other' }), { status: 200 }) })).status, 'pending');
  assert.equal((await notifyRuntimeEmployeeRemoved({ orgId: ORG, userId: USER, employeeId: EMP }, { env: {}, fetchImpl: () => { throw Error('no'); } })).status, 'skipped');
});

test('retries run on the schedule while pending and stop on success', async () => {
  const timers = []; let calls = 0;
  const outcomes = ['pending', 'pending', 'delivered'];
  const first = await withRetries(async () => ({ status: outcomes[calls++] ?? 'delivered' }), { delays: [10, 20, 30], schedule: (fn, ms) => { timers.push([fn, ms]); return {}; }, log: () => {} });
  assert.equal(first.status, 'pending'); assert.equal(timers.length, 1);
  await timers[0][0](); assert.equal(timers.length, 2, 'still pending: scheduled again');
  await timers[1][0](); assert.equal(timers.length, 2, 'delivered: no more retries'); assert.equal(calls, 3);
});

function fakeDb(rows) {
  const store = new Map(rows.map(r => [r.id, structuredClone(r)]));
  const tx = { digitalEmployee: { findUnique: async ({ where }) => structuredClone(store.get(where.id) ?? null), update: async ({ where, data }) => { store.set(where.id, { ...store.get(where.id), ...data }); } },
    $queryRawUnsafe: async () => [] };
  return { store, $transaction: async fn => fn(tx), digitalEmployee: tx.digitalEmployee,
    $queryRawUnsafe: async () => [...store.values()].filter(r => r.policyRules[EVENT_KEY]?.state === 'pending' && Number(r.policyRules[EVENT_KEY].next_attempt_at) <= 100).map(r => ({ id: r.id })) };
}

test('archive is recorded on the employee, delivered, and marked delivered', async () => {
  const employee = bound({ archive: { archived_at: '2026-10-30T10:00:00.000Z' } });
  const db = fakeDb([employee]); const sent = [];
  const out = await announceEmployeeLifecycle(db, { orgId: ORG, userId: USER }, 'pause_archive', { employee, replayed: false },
    { env, now: 50, deliver: async event => { sent.push(event); return { status: 'delivered' }; } });
  assert.equal(out.status, 'delivered'); assert.equal(sent.length, 1);
  const marker = db.store.get(EMP).policyRules[EVENT_KEY];
  assert.equal(marker.state, 'delivered'); assert.equal(marker.eventId, sent[0].eventId);
  assert.ok(db.store.get(EMP).policyRules.native_lifecycle, 'the lifecycle record is untouched');
});

test('a failed delivery stays pending with a backoff and the maintenance tick finishes it', async () => {
  const employee = bound({ unarchived_at: '2026-10-30T10:00:00.000Z' });
  const db = fakeDb([employee]);
  await announceEmployeeLifecycle(db, { orgId: ORG, userId: USER }, 'unarchive', { employee, replayed: false }, { env, now: 50, deliver: async () => ({ status: 'pending' }) });
  const marker = db.store.get(EMP).policyRules[EVENT_KEY];
  assert.equal(marker.state, 'pending'); assert.equal(marker.attempts, 1); assert.ok(marker.next_attempt_at > 50);
  assert.deepEqual(await recoverPendingLifecycleEvents(db, { env, now: () => 60, deliver: async () => { throw Error('not yet due'); } }), { attempted: 0, delivered: 0 });
  db.store.set(EMP, { ...db.store.get(EMP), policyRules: { ...db.store.get(EMP).policyRules, [EVENT_KEY]: { ...marker, next_attempt_at: 0 } } });
  const sent = [];
  const recovered = await recoverPendingLifecycleEvents(db, { env, now: () => 100, deliver: async event => { sent.push(event); return { status: 'delivered' }; } });
  assert.deepEqual(recovered, { attempted: 1, delivered: 1 });
  assert.equal(sent[0].type, 'unarchived'); assert.equal(sent[0].at, Date.parse('2026-10-30T10:00:00.000Z'));
  assert.equal(db.store.get(EMP).policyRules[EVENT_KEY].state, 'delivered');
});

test('nothing is recorded or sent while OpenDot events are unconfigured, and a plain native employee is ignored', async () => {
  const employee = bound({ archive: { archived_at: '2026-10-30T10:00:00.000Z' } });
  const db = fakeDb([employee]);
  assert.equal((await announceEmployeeLifecycle(db, { orgId: ORG, userId: USER }, 'pause_archive', { employee }, { env: {}, deliver: () => { throw Error('no'); } })).status, 'skipped');
  assert.equal(db.store.get(EMP).policyRules[EVENT_KEY], undefined);
  assert.equal((await announceEmployeeLifecycle(db, { orgId: ORG, userId: USER }, 'pause_archive', { employee: { id: EMP, policyRules: {} } }, { env })).status, 'ignored');
  assert.equal((await announceEmployeeLifecycle(db, { orgId: ORG, userId: USER }, 'configure', { employee }, { env })).status, 'ignored');
  assert.deepEqual(await recoverPendingLifecycleEvents(db, { env: {} }), { attempted: 0, delivered: 0 });
});

test('removal notifies Runtime and OpenDot through retries without any employee row', async () => {
  const employee = bound(); const calls = [];
  const retries = async attempt => attempt();
  const out = await announceEmployeeLifecycle(fakeDb([]), { orgId: ORG, userId: 'someone-else' }, 'remove', { employee, removed: true }, { env, now: 7, retries,
    notifyRuntime: async input => { calls.push(['runtime', input]); return { status: 'delivered' }; },
    deliver: async event => { calls.push(['open-dot', event]); return { status: 'delivered' }; } });
  assert.equal(out.status, 'delivered');
  assert.deepEqual(calls[0], ['runtime', { orgId: ORG, userId: USER, employeeId: EMP }], 'the room owner is the creator of the bound employee, not the caller');
  assert.equal(calls[1][1].type, 'removed'); assert.equal(calls[1][1].at, 7);
});

test('the attention routing check names a wrong runner or a malformed setting at start', async () => {
  const { describeRuntimeAttentionConfig } = await import('../src/connectors/composio/runtime-attention-bridge.js');
  const good = { HIVEMIND_RUNTIME_ATTENTION_URL: 'http://runtime-runner:3080/internal/hivemind/runtime-attention', HIVE_HARNESS_RUNNER_SERVICE_SECRET: 'x'.repeat(40) };
  assert.deepEqual(describeRuntimeAttentionConfig(good), { ok: true });
  const reason = env => describeRuntimeAttentionConfig(env).reason;
  assert.equal(reason({}), 'not_configured');
  assert.equal(reason({ ...good, HIVE_HARNESS_RUNNER_SERVICE_SECRET: 'short' }), 'secret_too_short');
  assert.equal(reason({ ...good, HIVEMIND_RUNTIME_ATTENTION_URL: 'not a url' }), 'invalid_url');
  assert.equal(reason({ ...good, HIVEMIND_RUNTIME_ATTENTION_URL: 'ftp://runtime-runner/internal/hivemind/runtime-attention' }), 'invalid_url');
  assert.equal(reason({ ...good, HIVEMIND_RUNTIME_ATTENTION_URL: 'http://runtime-runner:3080/other' }), 'wrong_path');
  assert.equal(reason({ ...good, HIVEMIND_RUNTIME_ATTENTION_URL: 'http://harness-runner:3080/internal/hivemind/runtime-attention' }), 'brain_runner');
  assert.equal(reason({ ...good, HIVEMIND_RUNTIME_ATTENTION_URL: 'http://hivemind-harness-runner-1:3080/internal/hivemind/runtime-attention' }), 'brain_runner');
});
