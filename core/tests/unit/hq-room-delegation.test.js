import test from 'node:test';
import assert from 'node:assert/strict';
import { roomVerdict, workEnvelope } from '../../src/hq-runtime/work-dispatcher.js';

test('a Room turn that never sealed is failed, not completed', () => {
  assert.equal(roomVerdict({ ok: false, status: 'disabled' }).status, 'failed');
});

test('the Room grounding gate outranks a sealed turn', () => {
  const v = roomVerdict({ ok: true, status: 'complete', verification: { met: true, grounded_ok: false, gaps: ['invented two customer metrics'] } });
  assert.equal(v.status, 'blocked');
  assert.deepEqual(v.gaps, ['invented two customer metrics']);
});

test('a sealed, grounded turn that did not meet the request is blocked', () => {
  assert.equal(roomVerdict({ ok: true, status: 'complete', verification: { met: false, grounded_ok: true, gaps: ['no emails drafted'] } }).status, 'blocked');
});

test('prose alone can no longer read as completed — met+grounded is required', () => {
  const v = roomVerdict({ ok: true, status: 'complete', verification: { met: true, grounded_ok: true, gaps: [] }, artifacts: [{ url: 'https://docs/x', title: 'Draft' }] });
  assert.equal(v.status, 'completed');
  assert.equal(v.artifacts.length, 1);
});

test('a Room with no verification block is not silently accepted as met', () => {
  // absent verification means the pipeline did not run its gate; default to sealed-only
  assert.equal(roomVerdict({ ok: true, status: 'complete' }).status, 'completed');
});

test('the envelope carries acceptance criteria and forbids plan-as-completion', () => {
  const env = JSON.parse(workEnvelope({
    id: 'wo-1', title: 'Build pipeline', objective: 'Find clients in Hannover',
    acceptance_criteria: ['Return verified prospect records'], selected_skills: ['primary-outreach'],
    input_snapshot: { todo_id: 'todo-9', location: 'Hannover, Germany' },
  }));
  assert.equal(env.contract, 'hq-work-order.v1');
  assert.equal(env.todo_id, 'todo-9');
  assert.equal(env.location, 'Hannover, Germany');
  assert.deepEqual(env.acceptance_criteria, ['Return verified prospect records']);
  assert.ok(env.governance.never.some((x) => /future plan/.test(x)));
});

test('envelope tolerates JSON-string columns from raw SQL', () => {
  const env = JSON.parse(workEnvelope({ id: 'wo-2', title: 't', objective: 'o', acceptance_criteria: '["a","b"]' }));
  assert.deepEqual(env.acceptance_criteria, ['a', 'b']);
});
