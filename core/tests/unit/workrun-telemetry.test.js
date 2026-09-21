import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORK_RUN_EVENT,
  normalizeAgentScopeEvent,
  workRunTelemetry,
} from '../../src/employees/work-runs.js';

test('workrun telemetry reports durable first-event milestones in order', () => {
  const submittedAt = 1_000;
  const source = [
    { type: 'REPLY_START', id: 'reply-1' },
    { type: 'THINKING_BLOCK_DELTA', id: 'thinking-1', delta: 'planning' },
    { type: 'TOOL_CALL_START', id: 'tool-1', tool_call_name: 'hivemind_company_context' },
    { type: 'TEXT_BLOCK_DELTA', id: 'answer-1', delta: 'Done.' },
    { type: 'REPLY_END', id: 'reply-end-1', finished_reason: 'completed' },
  ];
  const events = source.map((event, index) => ({
    ...normalizeAgentScopeEvent(event),
    ts: submittedAt + ((index + 1) * 10),
  }));

  const telemetry = workRunTelemetry(events, { submittedAt });
  assert.deepEqual(Object.keys(telemetry.marks), [
    'submit', 'acknowledgement', 'first_thinking', 'first_tool', 'first_answer', 'completion',
  ]);
  assert.deepEqual(telemetry.elapsed, {
    submit: 0,
    acknowledgement: 10,
    first_thinking: 20,
    first_tool: 30,
    first_answer: 40,
    completion: 50,
  });
  assert.equal(events[0].t, WORK_RUN_EVENT.STATUS);
  assert.equal(events[2].t, WORK_RUN_EVENT.TOOL_STARTED);
});

test('workrun telemetry tolerates a direct answer with no tool milestone', () => {
  const events = [
    { t: WORK_RUN_EVENT.STARTED, ts: 2_010 },
    { type: 'TEXT_BLOCK_DELTA', ts: 2_030 },
    { t: WORK_RUN_EVENT.COMPLETED, ts: 2_040 },
  ];
  const telemetry = workRunTelemetry(events, { submittedAt: 2_000 });
  assert.equal(telemetry.elapsed.first_tool, null);
  assert.equal(telemetry.elapsed.first_answer, 30);
  assert.equal(telemetry.elapsed.completion, 40);
});
