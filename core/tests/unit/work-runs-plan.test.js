import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRuntimeEvent,
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
});
