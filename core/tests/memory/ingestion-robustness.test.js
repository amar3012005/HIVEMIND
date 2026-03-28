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

test('skipProcessing preserves raw memories without relationship merging', async () => {
  let classifierCalls = 0;
  const relationshipClassifier = {
    classifyRelationship() {
      classifierCalls += 1;
      return {
        operation: 'updated',
        relationship: {
          type: 'Updates',
          targetId: 'first-memory',
          confidence: 0.9
        }
      };
    }
  };

  const store = new InMemoryGraphStore();
  const engine = new MemoryGraphEngine({ store, relationshipClassifier, predictCalibrate: false });
  const userId = '00000000-0000-4000-8000-000000001211';
  const orgId = '00000000-0000-4000-8000-000000001212';

  const first = await engine.ingestMemory({
    id: 'first-memory',
    user_id: userId,
    org_id: orgId,
    project: 'benchmark',
    content: 'I attended the Effective Time Management workshop last Saturday.',
    metadata: { session_date: '2023/05/28 (Sun) 21:04' },
    skipProcessing: true
  });

  const second = await engine.ingestMemory({
    id: 'second-memory',
    user_id: userId,
    org_id: orgId,
    project: 'benchmark',
    content: 'I attended the Data Analysis using Python webinar two months ago.',
    metadata: { session_date: '2023/05/28 (Sun) 07:17' },
    skipProcessing: true
  });

  const latest = await store.listLatestMemories({ user_id: userId, org_id: orgId, project: 'benchmark' });
  const firstStored = await store.getMemory(first.memoryId);
  const secondStored = await store.getMemory(second.memoryId);

  assert.equal(classifierCalls, 0);
  assert.equal(first.operation, 'created');
  assert.equal(second.operation, 'created');
  assert.equal(latest.length, 2);
  assert.equal(firstStored.is_latest, true);
  assert.equal(secondStored.is_latest, true);
  assert.equal(firstStored.document_date, '2023-05-28T21:04:00.000Z');
  assert.equal(secondStored.document_date, '2023-05-28T07:17:00.000Z');
});

test('source metadata persistence keeps custom metadata payloads', async () => {
  const store = new InMemoryGraphStore();
  const engine = new MemoryGraphEngine({ store, predictCalibrate: false });
  const userId = '00000000-0000-4000-8000-000000001221';
  const orgId = '00000000-0000-4000-8000-000000001222';

  await engine.ingestMemory({
    user_id: userId,
    org_id: orgId,
    project: 'metadata',
    content: 'I attended a webinar on statistical graphics.',
    metadata: {
      session_date: '2023/05/28 (Sun) 07:17',
      question_id: 'gpt4_2487a7cb'
    },
    source_metadata: {
      source_type: 'manual',
      source_platform: 'benchmark'
    },
    skipProcessing: true
  });

  assert.ok(store.sources.length >= 1);
  const lastSource = store.sources.at(-1);
  assert.equal(lastSource.metadata.session_date, '2023/05/28 (Sun) 07:17');
  assert.equal(lastSource.metadata.question_id, 'gpt4_2487a7cb');
});
