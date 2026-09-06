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
    await recordCompactAssistantTurn({ ...identity, userMessage: `user-${index}`, response: `assistant-${index}`, sources: [] }, { graph });
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

test('no implicit thread is created and hydration never commits an active turn', async () => {
  const graph = createCompactContextGraph({ checkpointer: new MemorySaver() });
  assert.equal(compactThreadKey({ orgId: 'org-a', userId: 'user-a' }), null);
  const identity = { orgId: 'org-a', userId: 'user-a', threadId: 'explicit-thread' };
  const hydrated = await hydrateCompactContext({ ...identity, message: 'this turn later fails', history: [] }, { graph });
  assert.deepEqual(hydrated.history, []);
  const state = await graph.getState({ configurable: { thread_id: compactThreadKey(identity) } });
  assert.deepEqual(state.values || {}, {});
});

test('compact context preserves only bounded public source references', async () => {
  const graph = createCompactContextGraph({ checkpointer: new MemorySaver() });
  const identity = { orgId: 'org-a', userId: 'user-a', threadId: 'sources' };
  await hydrateCompactContext({ ...identity, message: 'search public pricing', history: [] }, { graph });
  await recordCompactAssistantTurn({
    ...identity,
    response: 'Public pricing summary.',
    sources: Array.from({ length: 12 }, (_, index) => ({
      title: `S${index}`,
      url: `https://example.com/${index}`,
      source_type: 'public_web',
    })),
  }, { graph });
  const next = await hydrateCompactContext({ ...identity, message: 'save this', history: [] }, { graph });
  assert.equal(next.sourceRefs.length, compactContextLimits.sourceRefs);
  assert.equal(next.sourceRefs[0].url, 'https://example.com/4');
  assert.equal(next.sourceContext.answer, 'Public pricing summary.');
  assert.equal(next.history.at(-1).content, 'Public pricing summary.');
});

test('a later non-web assistant answer clears stale public source context', async () => {
  const graph = createCompactContextGraph({ checkpointer: new MemorySaver() });
  const identity = { orgId: 'org-a', userId: 'user-a', threadId: 'replaceable-sources' };
  await recordCompactAssistantTurn({
    ...identity,
    response: 'Public pricing summary.',
    sources: [{ title: 'Pricing', url: 'https://example.com/pricing', source_type: 'public_web' }],
  }, { graph });
  assert.ok((await hydrateCompactContext({ ...identity, message: 'which source?' }, { graph })).sourceContext);

  await recordCompactAssistantTurn({ ...identity, response: 'Hello Amar.', sources: [] }, { graph });
  const next = await hydrateCompactContext({ ...identity, message: 'new topic' }, { graph });
  assert.equal(next.sourceContext, null);
});

test('hydrating the next user turn preserves replaceable source context', async () => {
  const graph = createCompactContextGraph({ checkpointer: new MemorySaver() });
  const identity = { orgId: 'org-a', userId: 'user-a', threadId: 'source-follow-up' };
  await recordCompactAssistantTurn({
    ...identity,
    response: 'The answer came from the pricing page.',
    sources: [{ title: 'Pricing', url: 'https://example.com/pricing', source_type: 'public_web' }],
  }, { graph });
  const hydrated = await hydrateCompactContext({
    ...identity,
    message: 'Which source did you use?',
    history: [],
  }, { graph });
  assert.equal(hydrated.sourceContext.answer, 'The answer came from the pricing page.');
  assert.equal(hydrated.sourceContext.refs[0].url, 'https://example.com/pricing');
});

test('the shared checkpoint retains context across capability toggles', async () => {
  const graph = createCompactContextGraph({ checkpointer: new MemorySaver() });
  const identity = { orgId: 'org', userId: 'user', threadId: 'shared-toggle' };
  await recordCompactAssistantTurn({
    ...identity,
    userMessage: 'What do you know about Richards, Sullivan?',
    response: 'Richards, Sullivan, Brock & Associates was the design firm for the competition.',
  }, { graph });
  const connectedTurn = await hydrateCompactContext({ ...identity, history: [] }, { graph });
  assert.equal(connectedTurn.history.at(-1).role, 'assistant');
  assert.match(connectedTurn.history.at(-1).content, /design firm for the competition/);
});
