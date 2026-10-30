import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { signOpenDotRequest } from '../src/employees/open-dot-lifecycle-events.js';
import { NOTICE_PATH, NoticeNonceCache, applyLifecycleNotice, noticeSecret, parseNotice, verifyNoticeSignature } from '../src/employees/open-dot-lifecycle-notice.js';

const SECRET = 'n'.repeat(40);
const ORG = '33333333-3333-4333-8333-333333333333', USER = '22222222-2222-4222-8222-222222222222', EMP = '11111111-1111-4111-8111-111111111111';
const notice = (over = {}) => ({ eventId: 'evt-removed', type: 'removed', organizationId: ORG, userId: USER, employeeId: EMP, at: 1234, ...over });
const request = (body, now = Date.now(), secret = SECRET) => ({ method: 'POST', path: NOTICE_PATH, body: Buffer.from(body),
  headers: signOpenDotRequest(secret, { method: 'POST', path: NOTICE_PATH, body }, now, randomUUID()) });

test('a notice signed in the lifecycle scheme verifies once, inside the window, for the exact body', () => {
  const nonces = new NoticeNonceCache();
  const body = JSON.stringify(notice());
  const signed = request(body);
  assert.equal(verifyNoticeSignature(SECRET, signed, Date.now(), nonces), 'verified');
  assert.equal(verifyNoticeSignature(SECRET, signed, Date.now(), nonces), 'rejected', 'a reused nonce is refused');
  assert.equal(verifyNoticeSignature(SECRET, { ...request(body), body: Buffer.from(body.replace('1234', '9999')) }, Date.now(), nonces), 'rejected', 'a changed body is refused');
  assert.equal(verifyNoticeSignature('x'.repeat(40), request(body), Date.now(), nonces), 'rejected', 'another secret is refused');
  assert.equal(verifyNoticeSignature(SECRET, request(body, Date.now() - 120_000), Date.now(), nonces), 'rejected', 'a stale signature is refused');
  assert.equal(verifyNoticeSignature(SECRET, { ...request(body), headers: {} }, Date.now(), nonces), 'rejected');
  assert.equal(verifyNoticeSignature(SECRET, { ...request(body), path: '/v1/other' }, Date.now(), nonces), 'rejected', 'the signature covers the path');
  const full = new NoticeNonceCache(1);
  assert.equal(verifyNoticeSignature(SECRET, request(body), Date.now(), full), 'verified');
  assert.equal(verifyNoticeSignature(SECRET, request(body), Date.now(), full), 'unavailable', 'a full nonce memory refuses instead of forgetting');
});

test('the secret needs 32 bytes and the body must be exactly a removal notice', () => {
  assert.equal(noticeSecret({ OPEN_DOT_LIFECYCLE_EVENT_SECRET: SECRET }), SECRET);
  assert.equal(noticeSecret({ OPEN_DOT_LIFECYCLE_EVENT_SECRET: 'short' }), null);
  assert.equal(noticeSecret({}), null);
  assert.deepEqual({ ...parseNotice(Buffer.from(JSON.stringify(notice()))) }, notice());
  for (const bad of [{ type: 'archived' }, { employeeId: 'nope' }, { at: 0 }, { organizationId: '../x' }, { eventId: '' }]) {
    assert.throws(() => parseNotice(Buffer.from(JSON.stringify(notice(bad)))), /invalid_lifecycle_notice/);
  }
  assert.throws(() => parseNotice(Buffer.from('{')), /invalid_lifecycle_notice/);
  assert.throws(() => parseNotice(Buffer.alloc(5000)), /lifecycle_notice_too_large/);
});

function database(row) {
  const calls = { deleted: [], locked: [] };
  const tx = { $queryRawUnsafe: async (_sql, key) => { calls.locked.push(key); return []; },
    digitalEmployee: { findFirst: async ({ where }) => row && row.id === where.id && row.orgId === where.orgId ? row : null, delete: async ({ where }) => { calls.deleted.push(where.id); } } };
  return { db: { $transaction: async fn => fn(tx) }, calls };
}
const openDotRow = (over = {}) => ({ id: EMP, orgId: ORG, createdBy: USER, policyRules: { open_dot_employee: { version: 1, execution_backend: 'open-dot', state: 'bound', dot_id: 'dot_a' }, native_lifecycle: { phase: 'active', revision: 3 } }, ...over });

test('a removal notice deletes the OpenDot employee of that user and announces it in the background', async () => {
  const { db, calls } = database(openDotRow());
  const announced = [];
  const result = await applyLifecycleNotice(db, parseNotice(Buffer.from(JSON.stringify(notice()))), { announce: async (...args) => { announced.push(args); } });
  assert.deepEqual(result, { received: true, applied: true });
  assert.deepEqual(calls.deleted, [EMP]);
  assert.deepEqual(calls.locked, [`${ORG}:${EMP}`]);
  assert.equal(announced.length, 1);
  assert.equal(announced[0][2], 'remove');
  assert.equal(announced[0][3].employee.id, EMP);
});

test('an employee Core no longer has is already removed; a repeated notice changes nothing', async () => {
  const { db, calls } = database(null);
  const result = await applyLifecycleNotice(db, parseNotice(Buffer.from(JSON.stringify(notice()))), { announce: async () => assert.fail('nothing to announce') });
  assert.deepEqual(result, { received: true, applied: false });
  assert.deepEqual(calls.deleted, []);
});

test('a notice can never remove a native employee, another user\'s employee or another organization\'s', async () => {
  for (const row of [openDotRow({ policyRules: { native_lifecycle: { phase: 'active' } } }), openDotRow({ createdBy: '99999999-9999-4999-8999-999999999999' })]) {
    const { db, calls } = database(row);
    await assert.rejects(applyLifecycleNotice(db, parseNotice(Buffer.from(JSON.stringify(notice())))), { code: 'employee_not_open_dot_owner', status: 409 });
    assert.deepEqual(calls.deleted, []);
  }
  const { db, calls } = database(openDotRow());
  const other = await applyLifecycleNotice(db, parseNotice(Buffer.from(JSON.stringify(notice({ organizationId: '44444444-4444-4444-8444-444444444444' })))));
  assert.deepEqual(other, { received: true, applied: false }, 'another organization has no such employee');
  assert.deepEqual(calls.deleted, []);
});
