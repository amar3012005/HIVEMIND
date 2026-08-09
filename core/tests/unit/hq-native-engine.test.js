import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_LIFE_ADMIN_CHECKIN_PLAYBOOK, resolveWorkResultTodo, adminCheckinDisposition, selectPendingPlaybookRun, shouldOfferFirstLifeAdminCheckin } from '../../src/hq-runtime/native-engine.js';

test('first-life admin check-in always declares its immutable playbook identity', () => {
  assert.deepEqual(FIRST_LIFE_ADMIN_CHECKIN_PLAYBOOK, {
    id: 'operations.browser-admin-checkin-to-status',
    version: 1,
  });
});

test('optional first-life check-in never freezes the company: unverified/terminated runs proceed to planning', () => {
  // A run still in progress holds planning (administrator may add context).
  assert.equal(adminCheckinDisposition('WAITING_EVENT'), 'wait');
  assert.equal(adminCheckinDisposition('ACTIVE'), 'wait');
  assert.equal(adminCheckinDisposition('WAITING_AUTHORITY'), 'wait');
  // A completed run proceeds with its captured status.
  assert.equal(adminCheckinDisposition('COMPLETED'), 'proceed');
  // The regression: an exhausted/terminated optional check-in must proceed
  // (previously it moved the runtime to BLOCKED forever → wake-loop).
  assert.equal(adminCheckinDisposition('NEEDS_INTERVENTION'), 'proceed_unverified');
  assert.equal(adminCheckinDisposition('TERMINATED'), 'proceed_unverified');
  assert.equal(adminCheckinDisposition('FAILED'), 'proceed_unverified');
  // Defensive: unknown/absent status must never block; wait rather than freeze.
  assert.equal(adminCheckinDisposition(null), 'wait');
  assert.equal(adminCheckinDisposition('nEeDs_InTeRvEnTiOn'), 'proceed_unverified');
});

test('first-life admin check-in gates diagnosis only while the initial plan is absent', () => {
  assert.equal(shouldOfferFirstLifeAdminCheckin({
    initialPlanAbsent: true, optionalAdminCheckin: true, runtimePlaybooksAvailable: true,
  }), true);
  assert.equal(shouldOfferFirstLifeAdminCheckin({
    initialPlanAbsent: false, optionalAdminCheckin: true, runtimePlaybooksAvailable: true,
  }), false);
});

test('active Room work outranks an older lifecycle wait in Runtime narration', () => {
  const waiting = { id: 'old-wait', status: 'WAITING_EVENT' };
  const authority = { id: 'approval', status: 'WAITING_AUTHORITY' };
  const active = { id: 'current-room', status: 'ACTIVE' };
  assert.equal(selectPendingPlaybookRun([waiting, authority, active]), active);
  assert.equal(selectPendingPlaybookRun([waiting, authority]), authority);
});

test('HQ work-result reconciliation never reads a missing work order or result', () => {
  assert.equal(resolveWorkResultTodo({ order: null, result: null }), null);
  assert.equal(resolveWorkResultTodo({ order: { inputSnapshot: { todo_id: 'todo-1' } }, result: null }), null);
  assert.equal(resolveWorkResultTodo({ order: null, result: { output: { todo_id: 'todo-1' } } }), null);
});

test('HQ work-result reconciliation prefers returned todo ownership and falls back to the Work Order snapshot', () => {
  const order = { inputSnapshot: { todo_id: 'todo-from-order' } };
  assert.deepEqual(
    resolveWorkResultTodo({ order, result: { output: { todo_id: 'todo-from-result', evidence: ['resource-1'] } } }),
    { todoId: 'todo-from-result', resultOutput: { todo_id: 'todo-from-result', evidence: ['resource-1'] } },
  );
  assert.deepEqual(
    resolveWorkResultTodo({ order, result: { output: null } }),
    { todoId: 'todo-from-order', resultOutput: {} },
  );
});
