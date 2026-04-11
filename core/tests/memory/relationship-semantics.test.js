import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObservationPayload } from '../../src/memory/observation-store.js';
import { InMemoryGraphStore, MemoryGraphEngine } from '../../src/memory/graph-engine.js';

test('buildObservationPayload includes normalized derive semantics', () => {
  const payload = buildObservationPayload({
    userId: '00000000-0000-4000-8000-000000009001',
    orgId: '00000000-0000-4000-8000-000000009002',
    observationText: '🟡 [2026-04-11] The report synthesizes two sources.',
    observationDate: '2026-04-11T00:00:00.000Z',
    project: 'alpha',
    semanticRole: 'finding',
    relationship: {
      type: 'Derives',
      sourceIds: ['src-a', 'src-b'],
      confidence: 0.84,
      reason: 'multi_source_synthesis',
    },
    sourceIds: ['src-a', 'src-b'],
    sourceRefs: [
      { id: 'src-a', title: 'Source A' },
      { id: 'src-b', title: 'Source B' },
    ],
  });

  assert.equal(payload.metadata.semantic_role, 'finding');
  assert.equal(payload.metadata.semantic_relationship.type, 'Derives');
  assert.deepEqual(payload.metadata.semantic_relationship.sourceIds, ['src-a', 'src-b']);
  assert.deepEqual(payload.metadata.semantic_provenance.source_ids, ['src-a', 'src-b']);
});

test('ingestMemory persists explicit Derives semantics and creates derive edges', async () => {
  const store = new InMemoryGraphStore();
  const engine = new MemoryGraphEngine({ store, predictCalibrate: false });
  const userId = '00000000-0000-4000-8000-000000009101';
  const orgId = '00000000-0000-4000-8000-000000009102';

  const sourceA = await engine.ingestMemory({
    user_id: userId,
    org_id: orgId,
    project: 'alpha',
    content: 'Source A explains the first half of the topic.',
    source_metadata: { source_type: 'manual' },
    skipProcessing: true,
  });

  const sourceB = await engine.ingestMemory({
    user_id: userId,
    org_id: orgId,
    project: 'alpha',
    content: 'Source B explains the second half of the topic.',
    source_metadata: { source_type: 'manual' },
    skipProcessing: true,
  });

  const derived = await engine.ingestMemory({
    user_id: userId,
    org_id: orgId,
    project: 'alpha',
    content: 'This synthesis combines both sources into one claim.',
    relationship: {
      type: 'Derives',
      sourceIds: [sourceA.memoryId, sourceB.memoryId],
      confidence: 0.91,
    },
    source_metadata: { source_type: 'manual' },
    skipProcessing: true,
  });

  const stored = await store.getMemory(derived.memoryId);
  const deriveEdges = store.relationships.filter(edge => edge.type === 'Derives');

  assert.equal(derived.operation, 'derived');
  assert.equal(stored.metadata.semantic_relationship.type, 'Derives');
  assert.deepEqual(stored.metadata.semantic_relationship.sourceIds.sort(), [sourceA.memoryId, sourceB.memoryId].sort());
  assert.equal(deriveEdges.length, 2);
  assert.ok(deriveEdges.every(edge => edge.metadata.semantic_relationship.type === 'Derives'));
});
