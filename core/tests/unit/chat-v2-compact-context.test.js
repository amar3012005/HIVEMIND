import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySaver } from '@langchain/langgraph';
import {
  compactContextLimits,
  compactThreadKey,
  createCompactContextGraph,
  hydrateCompactContext,
  recordCompactAssistantTurn,
} from '../../src/agent/v2/compact-context.js';

test('compact context is tenant-thread isolated and strictly bounded', async () => {
  const graph = createCompactContextGraph({ checkpointer: new MemorySaver() });
  const identity = { orgId: 'org-a', userId: 'user-a', threadId: 'browser-thread' };
  for (let index = 0; index < 10; index += 1) {
    await hydrateCompactContext({ ...identity, message: `user-${index}`, history: [] }, { graph });
    await recordCompactAssistantTurn({ ...identity, response: `assistant-${index}`, sources: [] }, { graph });
  }
  const state = await graph.getState({ configurable: { thread_id: compactThreadKey(identity) } });
  assert.equal(state.values.turns.length, compactContextLimits.turns);
  assert.deepEqual(state.values.turns.map((turn) => turn.content), [
    'user-7', 'assistant-7', 'user-8', 'assistant-8', 'user-9', 'assistant-9',
  ]);
  assert.equal(JSON.stringify(state.values).includes('evidence'), false);

  const other = await hydrateCompactContext({ ...identity, orgId: 'org-b', message: 'new', history: [] }, { graph });
  assert.deepEqual(other.history, []);
});

test('compact context preserves only bounded public source references', async () => {
  const graph = createCompactContextGraph({ checkpointer: new MemorySaver() });
  const identity = { orgId: 'org-a', userId: 'user-a', threadId: 'sources' };
  await hydrateCompactContext({ ...identity, message: 'search public pricing', history: [] }, { graph });
  await recordCompactAssistantTurn({
    ...identity,
    response: 'Public pricing summary.',
    sources: Array.from({ length: 12 }, (_, index) => ({ title: `S${index}`, url: `https://example.com/${index}` })),
  }, { graph });
  const next = await hydrateCompactContext({ ...identity, message: 'save this', history: [] }, { graph });
  assert.equal(next.sourceRefs.length, compactContextLimits.sourceRefs);
  assert.equal(next.sourceRefs[0].url, 'https://example.com/4');
  assert.equal(next.history.at(-1).content, 'Public pricing summary.');
});
