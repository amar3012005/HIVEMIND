import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRuntimeEvent,
  canTransitionWorkRun,
  cancelWorkRun,
  completeWorkRun,
  dispatchWorkRun,
  normalizeAgentScopeEvent,
  recoverWorkRun,
  validateWorkRunCompletion,
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

test('AgentScope tool input and output deltas retain the call identity for durable inspection', () => {
  const input = normalizeAgentScopeEvent({ type: 'TOOL_CALL_DELTA', tool_call_id: 'call-1', delta: '{"query":' });
  const output = normalizeAgentScopeEvent({ type: 'TOOL_RESULT_TEXT_DELTA', tool_call_id: 'call-1', delta: 'first result' });
  assert.deepEqual(input.t, 'tool.input.delta');
  assert.deepEqual(output.t, 'tool.output.delta');
  assert.equal(input.call_id, 'call-1');
  assert.equal(output.call_id, 'call-1');
});

test('native AgentScope team metadata becomes a durable WorkRun lifecycle event', () => {
  const normalized = normalizeAgentScopeEvent({
    type: 'TOOL_RESULT_END', tool_call_id: 'team-call', state: 'success', metadata: {
      hivemind_team: {
        action: 'member_created', team_id: 'team-1', team_name: 'Research',
        leader_session_id: 'leader-1', member: 'researcher',
        member_agent_id: 'agent-2', member_session_id: 'session-2', member_origin: 'created',
      },
    },
  });
  assert.equal(normalized.t, 'team.updated');
  assert.equal(normalized.team_id, 'team-1');
  assert.equal(normalized.member_session_id, 'session-2');
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

test('cancellation persists one terminal event after the lifecycle transition', async () => {
  let status = 'running';
  const events = [];
  const prisma = {
    $queryRawUnsafe: async (sql, ...params) => {
      if (sql.startsWith('SELECT id, status FROM')) return [{ id: 'run-1', status }];
      if (sql.startsWith('UPDATE "hivemind"."work_runs" SET status')) { status = 'cancelled'; return [{ id: 'run-1', status }]; }
      if (sql.startsWith('UPDATE "hivemind"."work_runs"\n       SET events')) { events.push(JSON.parse(params[2])[0]); return [{ id: 'run-1', status }]; }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const cancelled = await cancelWorkRun(prisma, 'run-1');
  assert.equal(cancelled.ok, true);
  assert.equal(status, 'cancelled');
  assert.equal(events[0].t, 'workrun.cancelled');
  assert.equal(events[0].reason, 'cancelled_by_user');
});

test('completion gate reads AgentScope task snapshots and playbook evidence rules', () => {
  const blocked = validateWorkRunCompletion({
    scope: { completion_contract: { requires_task_plan: true, min_artifacts: 1 } }, result_artifact_ids: [],
    events: [{ t: 'plan.updated', tasks: [{ id: '1', state: 'in_progress' }] }],
  });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.unmet.map(({ predicate }) => predicate), ['all_native_tasks_completed', 'has_min_artifacts']);
  const complete = validateWorkRunCompletion({
    scope: { completion_contract: { requires_task_plan: true, min_artifacts: 1 } }, result_artifact_ids: ['artifact-1'],
    events: [{ t: 'plan.updated', tasks: [{ id: '1', state: 'completed' }] }],
  });
  assert.equal(complete.ok, true);
});

test('dispatch creates the Core envelope before calling the AgentScope runtime', async () => {
  const calls = [];
  const prisma = {
    $queryRawUnsafe: async (sql, ...params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT id FROM "hivemind"."hyper_rooms"')) return [{ id: 'room-1' }];
      if (sql.startsWith('INSERT INTO "hivemind"."work_runs"')) return [{ id: 'run-1', status: 'queued' }];
      if (sql.startsWith('UPDATE "hivemind"."work_runs"\n       SET events')) return [{ id: 'run-1', status: 'queued' }];
      if (sql.startsWith('SELECT id, status FROM')) return [{ id: 'run-1', status: calls.filter((entry) => entry.sql.startsWith('UPDATE "hivemind"."work_runs" SET status')).length ? 'starting' : 'queued' }];
      if (sql.startsWith('UPDATE "hivemind"."work_runs"\n          SET scope')) return [{ id: 'run-1', status: 'starting' }];
      if (sql.startsWith('UPDATE "hivemind"."work_runs" SET status')) return [{ id: 'run-1', status: 'running' }];
      throw new Error(`unexpected query: ${sql}`);
    },
    $transaction: async (fn) => fn({ hyperTurn: {
      findFirst: async () => ({ seq: 4 }),
      create: async () => ({ id: 'turn-1' }),
    } }),
  };
  const result = await dispatchWorkRun({
    prisma, orgId: 'org-1', userId: 'user-1', goal: 'Reply exactly READY',
    runtimeFetch: async (_url, options) => {
      assert.equal(options.body.turn_id, 'turn-1');
      assert.equal(options.body.workrun_id, 'run-1');
      return { ok: true, json: async () => ({ session_id: 'session-1', agent_id: 'agent-1', workspace_id: 'workspace-1' }) };
    },
  });
  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.sessionId, 'session-1');
  assert.ok(calls.find((entry) => entry.sql.startsWith('INSERT INTO "hivemind"."work_runs"')));
  assert.ok(calls.find((entry) => entry.sql.startsWith('UPDATE "hivemind"."work_runs"\n          SET scope')));
});

test('recovery reattaches an existing session and never resends the WorkRun goal', async () => {
  const calls = [];
  const prisma = {
    $queryRawUnsafe: async (sql, ...params) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT id, status, agentscope_session_id')) {
        return [{ id: 'run-1', status: 'running', agentscope_session_id: 'session-1', workspace_id: 'workspace-1', turn_id: 'turn-1', room_id: 'room-1', scope: { runtime_binding: { agent_id: 'agent-1' } } }];
      }
      if (sql.startsWith('UPDATE "hivemind"."work_runs"\n       SET events')) return [{ id: 'run-1', status: 'running' }];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const result = await recoverWorkRun({
    prisma, workRunId: 'run-1', userId: 'user-1', orgId: 'org-1',
    runtimeFetch: async (url, options) => {
      assert.match(url, /\/workrun\/recover$/);
      assert.deepEqual(options.body, {
        workrun_id: 'run-1', agent_id: 'agent-1', session_id: 'session-1', turn_id: 'turn-1',
        room_id: 'room-1', org_id: 'org-1', workspace_id: 'workspace-1',
      });
      return { ok: true, json: async () => ({ recovered: true }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.some((call) => JSON.stringify(call.params).includes('Reply exactly')), false);
});
