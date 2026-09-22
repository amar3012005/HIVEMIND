import test from 'node:test';
import assert from 'node:assert/strict';

import { appendWorkRunEvent, normalizeAgentScopeEvent, workRunTelemetry } from '../../src/employees/work-runs.js';

test('derives durable first-event telemetry without exposing content', () => {
  const telemetry = workRunTelemetry([
    { t: 'workrun.started', ts: 1_000 },
    { t: 'agent.status', type: 'THINKING_BLOCK_DELTA', ts: 1_120 },
    { t: 'tool.started', ts: 1_250 },
    { t: 'assistant.delta', type: 'TEXT_BLOCK_DELTA', ts: 1_400 },
    { t: 'workrun.completed', ts: 1_900 },
  ], { submittedAt: 900 });

  assert.deepEqual(telemetry.elapsed, {
    submit: 0,
    acknowledgement: 100,
    first_thinking: 220,
    first_tool: 350,
    first_answer: 500,
    completion: 1_000,
  });
  assert.equal(Object.hasOwn(telemetry, 'text'), false);
});

test('preserves typed AgentScope transcript deltas for durable replay', () => {
  const text = normalizeAgentScopeEvent({
    id: 'event-text-1', type: 'TEXT_BLOCK_DELTA', block_id: 'answer-1', reply_id: 'reply-1', delta: 'First chunk',
  });
  const thinking = normalizeAgentScopeEvent({
    id: 'event-thinking-1', type: 'THINKING_BLOCK_DELTA', block_id: 'think-1', delta: 'Checking context',
  });

  assert.equal(text.t, 'assistant.delta');
  assert.equal(text.type, 'TEXT_BLOCK_DELTA');
  assert.equal(text.block_id, 'answer-1');
  assert.equal(text.reply_id, 'reply-1');
  assert.equal(text.source_event_id, 'event-text-1');
  assert.equal(text.delta, 'First chunk');
  assert.equal(thinking.type, 'THINKING_BLOCK_DELTA');
  assert.equal(thinking.delta, 'Checking context');
});

test('retains stable tool identity, input, and streamed output', () => {
  const started = normalizeAgentScopeEvent({
    id: 'event-tool-start', type: 'TOOL_CALL_START', tool_call_id: 'call-1', tool_call_name: 'hivemind_recall', input: { query: 'recent work' },
  });
  const output = normalizeAgentScopeEvent({
    id: 'event-tool-output', type: 'TOOL_RESULT_TEXT_DELTA', tool_call_id: 'call-1', tool_call_name: 'hivemind_recall', delta: '{"memories":[',
  });

  assert.equal(started.type, 'TOOL_CALL_START');
  assert.equal(started.tool_call_id, 'call-1');
  assert.deepEqual(started.input, { query: 'recent work' });
  assert.equal(output.t, 'tool.output.delta');
  assert.equal(output.tool_call_id, 'call-1');
  assert.equal(output.source_event_id, 'event-tool-output');
});

test('rejects a replayed native event atomically by source_event_id', async () => {
  let query = '';
  const prisma = {
    async $queryRawUnsafe(sql) {
      query = sql;
      return [];
    },
  };

  const result = await appendWorkRunEvent(prisma, '00000000-0000-4000-8000-000000000001', {
    t: 'assistant.delta', source_event_id: 'native-event-1', delta: 'chunk',
  });

  assert.equal(result, null);
  assert.match(query, /source_event_id/);
  assert.match(query, /jsonb_build_array/);
  assert.match(query, /jsonb_array_elements/);
  assert.doesNotMatch(query, /events\s*->\s*-\(/);
});
