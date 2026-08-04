import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_LIFE_ADMIN_CHECKIN_PLAYBOOK, resolveWorkResultTodo } from '../../src/hq-runtime/native-engine.js';

test('first-life admin check-in always declares its immutable playbook identity', () => {
  assert.deepEqual(FIRST_LIFE_ADMIN_CHECKIN_PLAYBOOK, {
    id: 'operations.browser-admin-checkin-to-status',
    version: 1,
  });
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
