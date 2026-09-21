import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRuntimeEvent,
  canTransitionWorkRun,
  completeWorkRun,
  normalizeAgentScopeEvent,
} from '../../src/employees/work-runs.js';

test('AgentScope Task state is projected without creating another task authority', () => {
  const normalized = normalizeAgentScopeEvent({
    type: 'CUSTOM', name: 'state_updated', value: { tasks_context: { tasks: [{
      id: 'task-1', subject: 'Research', description: 'Find evidence', state: 'in_progress', blocked_by: [],
    }] } },
  });
  assert.equal(normalized.t, 'plan.updated');
  assert.deepEqual(normalized.tasks, [{
    id: 'task-1', subject: 'Research', description: 'Find evidence', state: 'in_progress', blocked_by: [], owner: null,
  }]);
});

test('tool completion reuses the matching start name', async () => {
  const calls = [];
  const prisma = {
    $queryRawUnsafe: async (sql, ...params) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT id, status, events')) {
        return [{ id: 'run-1', status: 'running', events: [{ t: 'tool.started', call_id: 'call-1', tool: 'hivemind_recall' }] }];
      }
      if (sql.startsWith('UPDATE "hivemind"."work_runs"\n       SET events')) return [{ id: 'run-1', status: 'running' }];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const result = await applyRuntimeEvent(prisma, 'run-1', { type: 'TOOL_RESULT_END', tool_call_id: 'call-1', output: { ok: true } });
  assert.equal(result.applied, true);
  assert.equal(result.event.tool, 'hivemind_recall');
});

test('lifecycle rejects resurrection and completes only once', async () => {
  assert.equal(canTransitionWorkRun('completed', 'running'), false);
  let status = 'running';
  const prisma = {
    $queryRawUnsafe: async (sql) => {
      if (sql.startsWith('SELECT id, status FROM')) return [{ id: 'run-1', status }];
      if (sql.startsWith('UPDATE "hivemind"."work_runs" SET status')) { status = 'completed'; return [{ id: 'run-1', status }]; }
      if (sql.startsWith('UPDATE "hivemind"."work_runs"\n       SET events')) return [{ id: 'run-1', status }];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const completed = await completeWorkRun(prisma, 'run-1', { result: { ok: true } });
  assert.equal(completed.ok, true);
  assert.equal(status, 'completed');
});
