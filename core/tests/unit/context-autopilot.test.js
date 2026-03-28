import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextAutopilot, scoreForRetention } from '../../src/memory/context-autopilot.js';
import { InMemoryGraphStore } from '../../src/memory/graph-engine.js';

test('context autopilot persists a session summary memory node during compaction', async () => {
  const store = new InMemoryGraphStore();
  const autopilot = new ContextAutopilot({ store, criticalMemoryCount: 2 });
  const userId = '00000000-0000-4000-8000-000000000901';
  const orgId = '00000000-0000-4000-8000-000000000902';

  await store.createMemory({
    id: 'mem-a',
    user_id: userId,
    org_id: orgId,
    project: 'alpha',
    content: 'User prefers concise architecture notes.',
    memory_type: 'preference',
    tags: ['preference'],
    is_latest: true,
    version: 1,
    created_at: '2026-03-28T00:00:00.000Z',
    updated_at: '2026-03-28T00:00:00.000Z',
    metadata: {}
  });

  autopilot.archiveTurns('sess-1', [
    { role: 'user', content: 'Please summarize the architecture decisions.' },
    { role: 'assistant', content: 'I will keep the notes concise and organized.' }
  ]);

  const result = await autopilot.compactSession('sess-1', {
    userId,
    orgId,
    project: 'alpha'
  });

  const stored = await store.listLatestMemories({ user_id: userId, org_id: orgId, project: 'alpha' });
  const summaryNode = stored.find(memory => (memory.tags || []).includes('session-summary'));

  assert.ok(result.summaryMemoryId);
  assert.ok(summaryNode);
  assert.equal(summaryNode.id, result.summaryMemoryId);
  assert.ok(summaryNode.content.includes('Session:'));
  assert.ok((summaryNode.tags || []).includes('session:sess-1'));
});

test('retention scoring prefers richer and more frequently recalled memories', () => {
  const low = scoreForRetention({
    content: 'Short note',
    recall_count: 0,
    version: 1,
    updated_at: new Date().toISOString(),
    importance_score: 0.4
  });
  const high = scoreForRetention({
    content: 'Detailed preference note with more semantic density and stronger importance signals for future recall.',
    recall_count: 4,
    version: 2,
    updated_at: new Date().toISOString(),
    importance_score: 0.9
  });

  assert.ok(high.score > low.score);
});
