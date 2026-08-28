import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictDetector } from '../../src/memory/conflict-detector.js';
import { RelationshipClassifier } from '../../src/memory/relationship-classifier.js';
import { InMemoryGraphStore, MemoryGraphEngine } from '../../src/memory/graph-engine.js';

function createEngine() {
  const store = new InMemoryGraphStore();
  const conflictDetector = new ConflictDetector({ threshold: 0.92 });
  const classifier = new RelationshipClassifier({ conflictDetector });
  const engine = new MemoryGraphEngine({ store, conflictDetector, relationshipClassifier: classifier });
  return { store, engine };
}

test('Updates transitions old node to is_latest=false', async () => {
  const { store, engine } = createEngine();
  const base = await engine.ingestMemory({
    user_id: '00000000-0000-4000-8000-000000000011',
    org_id: '00000000-0000-4000-8000-000000000022',
    project: 'alpha',
    content: 'The API now listens on port 3000',
    claim_subject: 'api', claim_predicate: 'listen_port', claim_qualifiers: { object: 3000 },
    defer_entity_linking: true,
    source_metadata: { source_type: 'manual' }
  });

  const result = await engine.ingestMemory({
    user_id: '00000000-0000-4000-8000-000000000011',
    org_id: '00000000-0000-4000-8000-000000000022',
    project: 'alpha',
    content: 'Updated: the API now listens on port 3010',
    claim_subject: 'api', claim_predicate: 'listen_port', claim_qualifiers: { object: 3010 },
    defer_entity_linking: true,
    relationship: { type: 'Updates', target_id: base.memoryId },
    source_metadata: { source_type: 'manual' }
  });

  const oldMemory = await store.getMemory(base.memoryId);
  const newMemory = await store.getMemory(result.memoryId);

  assert.equal(result.operation, 'updated');
  assert.equal(oldMemory.is_latest, false);
  assert.ok(oldMemory.valid_to, 'Updates must close the predecessor valid-time window');
  assert.ok(new Date(oldMemory.valid_to) >= new Date(oldMemory.created_at));
  assert.equal(newMemory.is_latest, true);
  assert.equal(store.relationships.filter(edge => edge.type === 'Updates').length, 1);
});

test('Updates synchronizes indexed lifecycle metadata after the canonical transaction', async () => {
  const { store, engine } = createEngine();
  const tenant = {
    user_id: '00000000-0000-4000-8000-000000000041',
    org_id: '00000000-0000-4000-8000-000000000042',
  };
  const target = await engine.ingestMemory({
    ...tenant, content: 'The approval policy is version one', smartIngest: false,
    claim_subject: 'approval-policy', claim_predicate: 'version', claim_qualifiers: { object: 1 },
    defer_entity_linking: true,
    source_metadata: { source_type: 'manual' },
  });
  const source = await engine.ingestMemory({
    ...tenant, content: 'The approval policy is version two', smartIngest: false,
    claim_subject: 'approval-policy', claim_predicate: 'version', claim_qualifiers: { object: 2 },
    defer_entity_linking: true,
    source_metadata: { source_type: 'manual' },
  });
  const patches = [];
  engine.vectorStore = {
    async updateMemoryPayload(memoryId, payload, options) {
      patches.push({ memoryId, payload, options });
    },
  };

  await engine.applyUpdate(source.memoryId, target.memoryId, tenant);

  assert.equal(patches.length, 1);
  assert.equal(patches[0].memoryId, target.memoryId);
  assert.equal(patches[0].payload.is_latest, false);
  assert.ok(patches[0].payload.valid_to);
  assert.equal(patches[0].options.orgId, tenant.org_id);
  assert.equal((await store.getMemory(target.memoryId)).valid_to, patches[0].payload.valid_to);
});

test('inferred Updates without shared entity evidence remain non-destructive', async () => {
  const { store, engine } = createEngine();
  const base = await engine.ingestMemory({
    user_id: '00000000-0000-4000-8000-000000000031',
    org_id: '00000000-0000-4000-8000-000000000032',
    project: 'alpha',
    content: 'The API now listens on port 3000',
    defer_entity_linking: true,
    source_metadata: { source_type: 'manual' }
  });

  const inferred = await engine.ingestMemory({
    user_id: '00000000-0000-4000-8000-000000000031',
    org_id: '00000000-0000-4000-8000-000000000032',
    project: 'alpha',
    content: 'Updated: the API now listens on port 3010',
    defer_entity_linking: true,
    source_metadata: { source_type: 'manual' }
  });

  assert.equal(inferred.operation, 'created');
  assert.equal((await store.getMemory(base.memoryId)).is_latest, true);
  assert.equal(store.relationships.filter(edge => edge.type === 'Updates').length, 0);
});

test('Extends keeps both nodes latest', async () => {
  const { store, engine } = createEngine();
  const base = await engine.ingestMemory({
    user_id: '00000000-0000-4000-8000-000000000111',
    org_id: '00000000-0000-4000-8000-000000000222',
    project: 'alpha',
    content: 'Security proposal: enforce API keys',
    defer_entity_linking: true,
    source_metadata: { source_type: 'manual' }
  });

  const result = await engine.ingestMemory({
    user_id: '00000000-0000-4000-8000-000000000111',
    org_id: '00000000-0000-4000-8000-000000000222',
    project: 'alpha',
    content: 'Security proposal: enforce API keys with request signing details',
    defer_entity_linking: true,
    relationship: { type: 'Extends', target_id: base.memoryId },
    source_metadata: { source_type: 'manual' }
  });

  const oldMemory = await store.getMemory(base.memoryId);
  const newMemory = await store.getMemory(result.memoryId);

  assert.equal(result.operation, 'extended');
  assert.equal(oldMemory.is_latest, true);
  assert.equal(newMemory.is_latest, true);
});

test('Derives enforces confidence threshold', async () => {
  const { store, engine } = createEngine();
  const source = await store.createMemory({
    id: '00000000-0000-4000-8000-000000000213',
    user_id: '00000000-0000-4000-8000-000000000211',
    org_id: '00000000-0000-4000-8000-000000000222',
    content: 'Amar works on retrieval',
    smartIngest: false,
    skipProcessing: true,
    defer_entity_linking: true,
    source_metadata: { source_type: 'manual' }
  });

  const target = await store.createMemory({
    id: '00000000-0000-4000-8000-000000000214',
    user_id: '00000000-0000-4000-8000-000000000211',
    org_id: '00000000-0000-4000-8000-000000000222',
    content: 'Qdrant powers retrieval',
    smartIngest: false,
    skipProcessing: true,
    defer_entity_linking: true,
    source_metadata: { source_type: 'manual' }
  });

  const low = await engine.applyDerives(source.id, target.id, {
    user_id: '00000000-0000-4000-8000-000000000211',
    org_id: '00000000-0000-4000-8000-000000000222',
    confidence: 0.5
  });
  const high = await engine.applyDerives(source.id, target.id, {
    user_id: '00000000-0000-4000-8000-000000000211',
    org_id: '00000000-0000-4000-8000-000000000222',
    confidence: 0.82
  });

  assert.equal(low.edgesCreated.length, 0);
  assert.equal(high.edgesCreated.length, 1);
  assert.equal(store.relationships.filter(edge => edge.type === 'Derives').length, 1);
});

test('Conflict detector triggers update consideration above threshold', () => {
  const detector = new ConflictDetector({ threshold: 0.92 });
  const candidates = detector.detectCandidates(
    { content: 'The API now listens on port 3000' },
    [{ id: 'm1', content: 'The API now listens on port 3001', is_latest: true }]
  );

  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].similarity >= 0.92);
});

test('Concurrent ingests preserve is_latest invariant with advisory locking', async () => {
  const { store, engine } = createEngine();
  const base = await engine.ingestMemory({
    user_id: '00000000-0000-4000-8000-000000000311',
    org_id: '00000000-0000-4000-8000-000000000322',
    project: 'alpha',
    content: 'Current production port is 3000',
    claim_subject: 'production-api', claim_predicate: 'listen_port', claim_qualifiers: { object: 3000 },
    defer_entity_linking: true,
    source_metadata: { source_type: 'manual' }
  });

  const updates = await Promise.all([
    engine.ingestMemory({
      user_id: '00000000-0000-4000-8000-000000000311',
      org_id: '00000000-0000-4000-8000-000000000322',
      project: 'alpha',
      content: 'Updated: current production port is 3010',
      claim_subject: 'production-api', claim_predicate: 'listen_port', claim_qualifiers: { object: 3010 },
      defer_entity_linking: true,
      relationship: { type: 'Updates', target_id: base.memoryId },
      source_metadata: { source_type: 'manual' }
    }),
    engine.ingestMemory({
      user_id: '00000000-0000-4000-8000-000000000311',
      org_id: '00000000-0000-4000-8000-000000000322',
      project: 'alpha',
      content: 'Updated: current production port is 3020',
      claim_subject: 'production-api', claim_predicate: 'listen_port', claim_qualifiers: { object: 3020 },
      defer_entity_linking: true,
      relationship: { type: 'Updates', target_id: base.memoryId },
      source_metadata: { source_type: 'manual' }
    })
  ]);

  const latest = (await store.listLatestMemories({
    user_id: '00000000-0000-4000-8000-000000000311',
    org_id: '00000000-0000-4000-8000-000000000322',
    project: 'alpha'
  })).filter(memory => memory.content.includes('production port'));

  assert.equal(latest.length, 1);
  assert.equal((await store.getMemory(base.memoryId)).is_latest, false);
  const updateEdges = store.relationships.filter(edge => edge.type === 'Updates');
  assert.equal(updateEdges.length, 2);
  assert.equal(updateEdges.filter(edge => edge.to_id === base.memoryId).length, 1);
  assert.ok(updateEdges.some(edge => updates.some(result => edge.to_id === result.memoryId)));
});
