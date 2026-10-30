import test from 'node:test';
import assert from 'node:assert/strict';
import { manageNativeEmployee } from '../src/employees/native-lifecycle.js';
import { openDotRemovalEndpoint, removeOpenDotEmployee, removeOpenDotEmployeeWithRetry } from '../src/employees/open-dot-removal.js';

const id = '11111111-1111-4111-8111-111111111111', org = '5f0c8c4e-0000-4000-8000-000000000001';
const env = { ACCOUNT_ERASURE_NATIVE_URL: 'http://100.64.0.1:3121/v1/account-erasure', ACCOUNT_ERASURE_NATIVE_TOKEN: 'secret-token' };
const reply = (body, ok = true) => async () => ({ ok, text: async () => JSON.stringify(body) });

test('endpoint is derived only from the erasure endpoint and needs the token', () => {
  assert.equal(openDotRemovalEndpoint(env).href, 'http://100.64.0.1:3121/v1/employee-removal');
  assert.equal(openDotRemovalEndpoint({ ...env, ACCOUNT_ERASURE_NATIVE_TOKEN: '' }), null);
  for (const bad of ['', 'nope', 'ftp://h/v1/account-erasure', 'http://u:p@h/v1/account-erasure', 'http://h/v1/other', 'http://h/v1/account-erasure?x=1'])
    assert.equal(openDotRemovalEndpoint({ ...env, ACCOUNT_ERASURE_NATIVE_URL: bad }), null, bad);
});

test('request carries only organization, employee and dot, with the bearer token', async () => {
  let seen;
  const result = await removeOpenDotEmployee({ orgId: org, employeeId: id, dotId: 'dot_x' }, { env, fetchImpl: async (url, init) => { seen = { url: String(url), init }; return reply({ verified: true, employeeId: id, dotsRemoved: 1, computersRemoved: true })(); } });
  assert.deepEqual(result, { status: 'verified', dotsRemoved: 1, alreadyRemoved: false });
  assert.equal(seen.init.headers.authorization, 'Bearer secret-token');
  assert.equal(seen.init.redirect, 'error');
  assert.deepEqual(JSON.parse(seen.init.body), { organizationId: org, employeeId: id, dotId: 'dot_x' });
});

test('anything unverified is pending and never leaks the token or throws', async () => {
  const cases = [
    [reply({ error: 'native_work_active' }, false), 'open_dot_native_work_active'],
    [reply({ verified: true, employeeId: 'other', computersRemoved: true }), 'open_dot_removal_unconfirmed'],
    [reply({ verified: true, employeeId: id, computersRemoved: false }), 'open_dot_removal_unconfirmed'],
    [async () => { throw Error('connect secret-token refused'); }, 'open_dot_removal_unreachable'],
    [async () => ({ ok: true, text: async () => 'not json' }), 'open_dot_removal_unreachable'],
  ];
  for (const [fetchImpl, reason] of cases) {
    const result = await removeOpenDotEmployee({ orgId: org, employeeId: id }, { env, fetchImpl });
    assert.deepEqual(result, { status: 'pending', reason });
  }
  assert.deepEqual(await removeOpenDotEmployee({ orgId: org, employeeId: id }, { env: {} }), { status: 'pending', reason: 'open_dot_removal_unconfigured' });
});

test('a pending cleanup is retried in the background until verified, then stops', async () => {
  const results = [{ status: 'pending', reason: 'open_dot_native_work_active' }, { status: 'pending', reason: 'open_dot_native_work_active' }, { status: 'verified', dotsRemoved: 1 }];
  const calls = [], timers = [];
  const first = await removeOpenDotEmployeeWithRetry({ orgId: org, employeeId: id }, { delays: [1, 2, 3], remove: async () => { calls.push(1); return results.shift(); }, schedule: (fn, ms) => { timers.push([fn, ms]); return {}; } });
  assert.equal(first.status, 'pending');
  assert.equal(timers.length, 1);
  await timers[0][0]();
  await timers[1][0]();
  assert.equal(calls.length, 3);
  assert.equal(timers.length, 2, 'no further retry after success');
});

test('retries stop after the last delay and an unconfigured channel is not retried', async () => {
  const logged = [], timers = [];
  const pending = { status: 'pending', reason: 'open_dot_removal_unreachable' };
  await removeOpenDotEmployeeWithRetry({ orgId: org, employeeId: id }, { delays: [1], remove: async () => pending, schedule: (fn) => { timers.push(fn); return {}; }, log: (...a) => logged.push(a) });
  await timers[0]();
  assert.equal(logged.length, 1);
  const none = [];
  await removeOpenDotEmployeeWithRetry({ orgId: org, employeeId: id }, { remove: async () => ({ status: 'pending', reason: 'open_dot_removal_unconfigured' }), schedule: fn => none.push(fn) });
  assert.equal(none.length, 0);
});

const admin = { userOrganization: { findUnique: async () => ({ isActive: true, role: 'admin' }) } };
test('removing an Open Dot employee deletes the row, then asks the controller to erase its data', async () => {
  const row = { id, name: 'Zozo', status: 'draft', archivedAt: null, policyRules: { native_lifecycle: { version: 1, phase: 'active', kind: 'durable', revision: 2 }, open_dot_employee: { version: 1, execution_backend: 'open-dot', state: 'bound', dot_id: 'dot_abc' } } };
  const order = [];
  const tx = { $queryRawUnsafe: async () => [], digitalEmployee: { findFirst: async () => row, delete: async () => { order.push('row'); return row; } } };
  const db = { ...admin, $transaction: async fn => fn(tx) };
  const calls = [];
  const result = await manageNativeEmployee(db, { orgId: org, userId: 'admin' }, { operation: 'remove', employee_id: id }, { openDotRemoval: async args => { order.push('dot'); calls.push(args); return { status: 'verified', dotsRemoved: 1 }; } });
  assert.equal(result.removed, true);
  assert.deepEqual(order, ['row', 'dot']);
  assert.deepEqual(calls, [{ orgId: org, employeeId: id, dotId: 'dot_abc' }]);
  assert.deepEqual(result.open_dot_cleanup, { status: 'verified', dotsRemoved: 1 });
});

test('a failed cleanup does not undo the removal and is reported as pending', async () => {
  const row = { id, policyRules: { native_lifecycle: { version: 1, phase: 'active', kind: 'durable', revision: 1 }, open_dot_employee: { version: 1 } } };
  const tx = { $queryRawUnsafe: async () => [], digitalEmployee: { findFirst: async () => row, delete: async () => row } };
  const result = await manageNativeEmployee({ ...admin, $transaction: async fn => fn(tx) }, { orgId: org, userId: 'admin' }, { operation: 'remove', employee_id: id },
    { openDotRemoval: async () => ({ status: 'pending', reason: 'open_dot_native_work_active' }) });
  assert.equal(result.removed, true);
  assert.equal(result.open_dot_cleanup.status, 'pending');
});

test('native (non Open Dot) employees never call the controller', async () => {
  const row = { id, policyRules: { native_lifecycle: { version: 1, phase: 'active', kind: 'durable', revision: 1 } } };
  const tx = { $queryRawUnsafe: async () => [], digitalEmployee: { findFirst: async () => row, delete: async () => row } };
  const result = await manageNativeEmployee({ ...admin, $transaction: async fn => fn(tx) }, { orgId: org, userId: 'admin' }, { operation: 'remove', employee_id: id },
    { openDotRemoval: async () => { throw Error('must not be called'); } });
  assert.equal(result.removed, true);
  assert.equal(result.open_dot_cleanup, undefined);
});

test('repeating a removal after the row is gone finishes a pending cleanup, and stays 404 when nothing is left', async () => {
  const tx = { $queryRawUnsafe: async () => [], digitalEmployee: { findFirst: async () => null } };
  const db = { ...admin, $transaction: async fn => fn(tx) };
  const done = await manageNativeEmployee(db, { orgId: org, userId: 'admin' }, { operation: 'remove', employee_id: id }, { openDotRemoval: async args => { assert.deepEqual(args, { orgId: org, employeeId: id }); return { status: 'verified', dotsRemoved: 1, alreadyRemoved: false }; } });
  assert.equal(done.removed, true);
  assert.equal(done.replayed, true);
  for (const cleanup of [{ status: 'verified', dotsRemoved: 0, alreadyRemoved: true }, { status: 'pending', reason: 'open_dot_removal_unreachable' }])
    await assert.rejects(manageNativeEmployee(db, { orgId: org, userId: 'admin' }, { operation: 'remove', employee_id: id }, { openDotRemoval: async () => cleanup }), /employee_not_found/);
});
