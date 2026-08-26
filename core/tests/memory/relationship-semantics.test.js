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

test('LLM co-mention linker preserves Derives edge type', async () => {
  const store = new InMemoryGraphStore();
  const memoryChatClient = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          entities: ['Project Zephyr'],
          temporal: {},
          memory_type: 'fact',
          links: [{
            index: 0,
            entity: 'Project Zephyr',
            type: 'Derives',
            confidence: 0.9,
            reason: 'new claim synthesizes the prior source',
          }],
        }),
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const engine = new MemoryGraphEngine({ store, predictCalibrate: false, memoryChatClient });
  const userId = '00000000-0000-4000-8000-000000009201';
  const orgId = '00000000-0000-4000-8000-000000009202';

  const source = await store.createMemory({
    id: '00000000-0000-4000-8000-000000009203',
    user_id: userId,
    org_id: orgId,
    content: 'Source A says Project Zephyr should use the Berlin deployment route.',
    title: 'Source A',
    memory_type: 'fact',
    is_latest: true,
    tags: ['entity:project-zephyr'],
    created_at: new Date().toISOString(),
  });

  const derived = await store.createMemory({
    id: '00000000-0000-4000-8000-000000009204',
    user_id: userId,
    org_id: orgId,
    content: 'Project Zephyr deployment plan derives from Source A and validates the Berlin route.',
    title: 'Derived claim',
    memory_type: 'fact',
    is_latest: true,
    tags: ['entity:project-zephyr'],
    created_at: new Date().toISOString(),
  });

  await engine._attachEntityCoMentionEdges(derived, store, [source]);

  const deriveEdges = store.relationships.filter(edge => edge.type === 'Derives');
  assert.equal(deriveEdges.length, 1);
  assert.equal(deriveEdges[0].from_id, derived.id);
  assert.equal(deriveEdges[0].to_id, source.id);
  assert.equal(deriveEdges[0].metadata.classification_source, 'llm');
});

test('malformed entity-link output retains structured entities and explicit type', async () => {
  const previousAttempts = process.env.ENTITY_LINK_MAX_ATTEMPTS;
  process.env.ENTITY_LINK_MAX_ATTEMPTS = '1';
  try {
    const store = new InMemoryGraphStore();
    const memoryChatClient = async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"entities":["truncated"' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const engine = new MemoryGraphEngine({ store, predictCalibrate: false, memoryChatClient });
    const memory = await store.createMemory({
      id: '00000000-0000-4000-8000-000000009304',
      user_id: '00000000-0000-4000-8000-000000009301',
      org_id: '00000000-0000-4000-8000-000000009302',
      content: 'Consolidate HIVEMIND and BRAIN into one product.',
      title: 'Product consolidation',
      memory_type: 'decision',
      is_latest: true,
      tags: ['talk-to-hive'],
      metadata: { extracted_entities: ['HIVEMIND', { name: 'BRAIN', kind: 'product' }] },
      created_at: new Date().toISOString(),
    });

    const result = await engine._attachEntityCoMentionEdges(memory, store, []);
    const stored = await store.getMemory(memory.id);

    assert.equal(result.ok, false);
    assert.equal(result.status, 'fallback');
    assert.ok(stored.tags.includes('entity:hivemind'));
    assert.ok(stored.tags.includes('entity:brain'));
    assert.equal(stored.memory_type, 'decision');
  } finally {
    if (previousAttempts === undefined) delete process.env.ENTITY_LINK_MAX_ATTEMPTS;
    else process.env.ENTITY_LINK_MAX_ATTEMPTS = previousAttempts;
  }
});

test('canonical linker prompt requests rich source-supported entities from every memory save', async () => {
  const store = new InMemoryGraphStore();
  let capturedPrompt = '';
  let capturedModel = '';
  const memoryChatClient = async (_url, options) => {
    const request = JSON.parse(options.body);
    capturedPrompt = request.messages[0].content;
    capturedModel = request.model;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        entities: ['Leo', 'insulated container', 'housing interior', 'lid area'],
        temporal: {}, memory_type: 'fact', links: [],
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const engine = new MemoryGraphEngine({ store, predictCalibrate: false, memoryChatClient });
  const memory = await store.createMemory({
    id: '00000000-0000-4000-8000-000000009404',
    user_id: '00000000-0000-4000-8000-000000009401',
    org_id: '00000000-0000-4000-8000-000000009402',
    title: 'Long-term heat retention in the Leo',
    content: 'Heat stored in the Leo is retained for a long time due to the insulated container, including the housing interior and lid area.',
    memory_type: 'fact', is_latest: true, tags: [], created_at: new Date().toISOString(),
  });

  await engine._attachEntityCoMentionEdges(memory, store, []);

  assert.match(capturedPrompt, /ALL materially useful, source-supported entities/);
  assert.match(capturedPrompt, /specific components, subsystems, or named features/);
  assert.match(capturedPrompt, /exact model names, components, mechanisms, quantities, units/);
  assert.match(capturedPrompt, /never infer the mechanism from co-occurrence alone/);
  assert.match(capturedPrompt, /If no CANDIDATE matches, return "links":\[\] but STILL extract/);
  assert.equal(capturedModel, 'google/gemini-2.5-flash-lite');
  const stored = await store.getMemory(memory.id);
  assert.ok(stored.tags.includes('entity:leo'));
  assert.ok(stored.tags.includes('entity:insulated-container'));
  assert.ok(stored.tags.includes('entity:housing-interior'));
  assert.ok(stored.tags.includes('entity:lid-area'));
});
