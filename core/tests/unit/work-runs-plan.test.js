import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRuntimeEvent,
  completeWorkRun,
  normalizeAgentScopeEvent,
  WORK_RUN_EVENT,
} from '../../src/employees/work-runs.js';

describe('WorkRun Task tools → plan events (Phase 1)', () => {
  it('maps TaskCreate start to plan.updated, not a generic tool', () => {
    const ev = normalizeAgentScopeEvent({
      type: 'TOOL_CALL_START',
      tool_call_name: 'TaskCreate',
      tool_call_id: 'tc_1',
    });
    assert.equal(ev.t, WORK_RUN_EVENT.PLAN);
    assert.equal(ev.family, 'task');
    assert.equal(ev.tool, 'TaskCreate');
  });

  it('maps hivemind_recall to tool.started', () => {
    const ev = normalizeAgentScopeEvent({
      type: 'TOOL_CALL_START',
      tool_call_name: 'hivemind_recall',
      tool_call_id: 'r_1',
    });
    assert.equal(ev.t, WORK_RUN_EVENT.TOOL_STARTED);
    assert.equal(ev.tool, 'hivemind_recall');
  });

  it('maps REPLY_END error to user-visible workrun.failed', () => {
    const ev = normalizeAgentScopeEvent({
      type: 'REPLY_END',
      finished_reason: 'error',
      error: { type: 'invalid_request', message: 'The request to the model was rejected as invalid.' },
    });
    assert.equal(ev.t, WORK_RUN_EVENT.FAILED);
    assert.equal(ev.status, 'failed');
    assert.equal(ev.reason, 'error');
  });

  it('preserves the parked reply and tool calls required for confirmation resume', () => {
    const toolCall = { id: 'bash-1', name: 'Bash', input: { command: 'pwd' } };
    const ev = normalizeAgentScopeEvent({
      type: 'REQUIRE_USER_CONFIRM',
      reply_id: 'reply-1',
      tool_calls: [toolCall],
    });
    assert.equal(ev.t, WORK_RUN_EVENT.APPROVAL_REQUESTED);
    assert.equal(ev.reply_id, 'reply-1');
    assert.equal(ev.call_id, 'bash-1');
    assert.deepEqual(ev.tool_calls, [toolCall]);
  });

  it('recovers a tool name on result events from the matching call id', async () => {
    const appended = [];
    const prisma = {
      $queryRawUnsafe: async (sql, ...params) => {
        if (sql.startsWith('SELECT id, status, events')) {
          return [{
            id: '11111111-1111-4111-8111-111111111111',
            status: 'running',
            events: [{
              t: WORK_RUN_EVENT.TOOL_STARTED,
              tool: 'hivemind_recall',
              call_id: 'tool_1',
            }],
          }];
        }
        if (sql.startsWith('UPDATE "hivemind"."work_runs"')) {
          appended.push(JSON.parse(params[2])[0]);
          return [{ id: '11111111-1111-4111-8111-111111111111', status: 'running' }];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };

    const result = await applyRuntimeEvent(prisma, '11111111-1111-4111-8111-111111111111', {
      type: 'TOOL_RESULT_END',
      tool_call_id: 'tool_1',
    });

    assert.deepEqual(result, { applied: true });
    assert.equal(appended[0].t, WORK_RUN_EVENT.TOOL_COMPLETED);
    assert.equal(appended[0].tool, 'hivemind_recall');
  });

  it('keeps a bounded tool-result preview for reconnect-safe disclosure', () => {
    const ev = normalizeAgentScopeEvent({
      type: 'TOOL_RESULT_END',
      tool_call_name: 'hivemind_recall',
      tool_call_id: 'call-1',
      output: { memories: [{ id: 'm-1', content: 'Known company fact' }] },
    });
    assert.equal(ev.t, WORK_RUN_EVENT.TOOL_COMPLETED);
    assert.match(ev.result, /Known company fact/);
    assert.equal(ev.state, 'success');
  });

  it('projects HIVE external approvals from a tool result without creating an AgentScope confirmation prompt', async () => {
    const appended = [];
    const prisma = {
      $queryRawUnsafe: async (sql, ...params) => {
        if (sql.startsWith('SELECT id, status, events')) {
          return [{ id: '11111111-1111-4111-8111-111111111111', status: 'running', events: [] }];
        }
        if (sql.startsWith('UPDATE "hivemind"."work_runs"')) {
          appended.push(JSON.parse(params[2])[0]);
          return [{ id: '11111111-1111-4111-8111-111111111111', status: 'running' }];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    const result = await applyRuntimeEvent(prisma, '11111111-1111-4111-8111-111111111111', {
      type: 'TOOL_RESULT_END',
      tool_call_name: 'hivemind_composio_execute',
      tool_call_id: 'call-1',
      output: {
        status: 'approval_required',
        approval: { id: 'draft-1', summary: 'gmail/GMAIL_SEND_EMAIL', expiresAt: '2026-10-01T00:00:00.000Z' },
      },
    });
    assert.deepEqual(result, { applied: true });
    assert.equal(appended[0].t, WORK_RUN_EVENT.TOOL_COMPLETED);
    assert.equal(appended[0].approval.id, 'draft-1');
    assert.deepEqual(appended[1], {
      t: WORK_RUN_EVENT.EXTERNAL_ACTION_PENDING,
      approval_id: 'draft-1',
      tool: 'hivemind_composio_execute',
      call_id: 'call-1',
      summary: 'gmail/GMAIL_SEND_EMAIL',
      expires_at: '2026-10-01T00:00:00.000Z',
      ts: appended[0].ts,
    });
  });

  it('does not terminally complete a selected playbook without its durable evidence', async () => {
    const appended = [];
    const prisma = {
      $queryRawUnsafe: async (sql, ...params) => {
        if (sql.startsWith('SELECT scope, events, result_artifact_ids')) {
          return [{
            scope: { completion_contract: { artifacts: { min_count: 1 } } },
            events: [],
            result_artifact_ids: [],
          }];
        }
        if (sql.startsWith('UPDATE "hivemind"."work_runs"')) {
          appended.push(JSON.parse(params[2])[0]);
          return [{ id: '11111111-1111-4111-8111-111111111111', status: 'running' }];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    const outcome = await completeWorkRun(prisma, '11111111-1111-4111-8111-111111111111');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'completion_contract_unmet');
    assert.deepEqual(outcome.verdict.unmet, [{ predicate: 'artifacts.min_count', expected: 1, actual: 0 }]);
    assert.equal(appended[0].t, WORK_RUN_EVENT.COMPLETION_BLOCKED);
  });

  it('projects AgentScope state_updated tasks without duplicating task ownership', () => {
    const ev = normalizeAgentScopeEvent({
      type: 'CUSTOM',
      name: 'state_updated',
      value: {
        tasks_context: {
          tasks: [{
            id: 'task_1',
            subject: 'Verify sources',
            description: 'Use first-party evidence.',
            state: 'in_progress',
            blocked_by: ['task_0'],
            owner: 'lead',
            private_field: 'not projected',
          }],
        },
      },
    });
    assert.equal(ev.t, WORK_RUN_EVENT.PLAN);
    assert.deepEqual(ev.tasks, [{
      id: 'task_1',
      subject: 'Verify sources',
      description: 'Use first-party evidence.',
      state: 'in_progress',
      blocked_by: ['task_0'],
      owner: 'lead',
    }]);
  });
});
