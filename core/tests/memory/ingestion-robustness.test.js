import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryGraphEngine, InMemoryGraphStore } from '../../src/memory/graph-engine.js';
import { MemoryProcessor } from '../../src/memory/memory-processor.js';

test('ingestion still runs memory processing when predict-calibrate is skipped', async () => {
  const original = MemoryProcessor.prototype.process;
  MemoryProcessor.prototype.process = async function mockedProcess() {
    return {
      relationship: { action: 'EXTEND', targetId: 'base-memory', reason: 'mocked' },
      observation: 'User confirmed the new deployment preference.',
      facts: { entities: ['deployment'], dates: ['2026-03-28'] },
      priority: 'high'
    };
  };

  const store = new InMemoryGraphStore();
  const engine = new MemoryGraphEngine({ store, predictCalibrate: false });
  const userId = '00000000-0000-4000-8000-000000001201';
  const orgId = '00000000-0000-4000-8000-000000001202';

  try {
    const base = await engine.ingestMemory({
      id: 'base-memory',
      user_id: userId,
      org_id: orgId,
      project: 'alpha',
      content: 'The deployment process uses blue-green rollout.',
      skipProcessing: true,
      source_metadata: { source_type: 'manual' }
    });

    const result = await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'alpha',
      content: 'We now prefer blue-green rollout with staged verification.',
      skipPredictCalibrate: true,
      skipProcessing: false,
      source_metadata: { source_type: 'manual' }
    });

    const stored = await store.getMemory(result.memoryId);
    const latest = await store.listLatestMemories({ user_id: userId, org_id: orgId, project: 'alpha' });
    const observation = latest.find(memory => (memory.tags || []).includes('observation'));

    assert.equal(base.operation, 'created');
    assert.equal(result.operation, 'extended');
    assert.deepEqual(stored.metadata.extracted_facts.entities, ['deployment']);
    assert.equal(stored.metadata.memory_priority, 'high');
    assert.ok(observation);
    assert.ok(observation.content.includes('User confirmed'));
  } finally {
    MemoryProcessor.prototype.process = original;
  }
});
