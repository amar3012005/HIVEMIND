import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAgentScopeEvent } from '../../src/employees/work-runs.js';

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
