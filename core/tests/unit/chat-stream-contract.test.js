import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySaver } from '@langchain/langgraph';

import { runUnifiedMetaAgent } from '../../src/agent/unified-langgraph-agent.js';

test('unified graph retains the existing SSE and final response fields consumed by Overview chat', async () => {
  const events = [];
  let call = 0;
  const prisma = { pendingWrite: {} };
  const result = await runUnifiedMetaAgent({
    message: 'What do we know about the release?',
    useTools: false,
    prisma,
    ctx: { orgId: 'o', userId: 'u', threadId: 't', language: 'en', prisma },
    checkpointer: new MemorySaver(),
    composio: {},
    onEvent: event => events.push(event),
    modelStep: async () => {
      call += 1;
      return call === 1
        ? { message: { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'hivemind_meta', arguments: '{"operation":"recall","recall":{"query":"release"}}' } }] } }
        : { message: { role: 'assistant', content: 'The release remains feature-gated.' } };
    },
    metaExecutor: async () => ({ successful: true, data: { memories: [{ title: 'Release decision', content: 'Keep the release feature-gated.' }] } }),
  });

  assert.equal(result.response, 'The release remains feature-gated.');
  assert.ok(Array.isArray(result.steps));
  assert.ok(Array.isArray(result.sources));
  assert.ok(Array.isArray(result.citations));
  assert.ok(Array.isArray(result.draftIds));
  assert.ok(Array.isArray(result.pendingActions));
  assert.deepEqual(events.filter(event => ['tool_start', 'tool_result', 'answer_delta', 'finish'].includes(event.type)).map(event => event.type), ['tool_start', 'tool_result', 'answer_delta', 'finish']);
  assert.deepEqual(events.filter(event => event.type === 'agent_state').map(event => event.state), ['running', 'sealed']);
});
