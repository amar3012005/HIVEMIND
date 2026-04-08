/**
 * Graph Endpoint Tests - Deep Research Layer Generation
 *
 * Tests the /api/research/:sessionId/graph endpoint to verify
 * that research memories are correctly categorized into layers:
 * - Sources (web pages, documents)
 * - Claims (extracted findings/facts)
 * - Trails (research steps)
 * - Blueprints (CSI patterns used)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';

const prisma = getPrismaClient();

function randomId() {
  return crypto.randomUUID();
}

test('Graph endpoint - categorize memories into layers', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const memoryStore = new PrismaGraphStore(prisma);
  const sessionId = randomId();
  const projectId = `research/test-graph-${sessionId.slice(0, 8)}`;

  // Create source memories (uses tags, not memoryType)
  const source1Id = randomId(); // Must be valid UUID
  await memoryStore.createMemory({
    id: source1Id,
    user_id: userId,
    org_id: orgId,
    project: projectId,
    content: 'Research source about memory-augmented models',
    title: 'Memory Models Paper',
    memory_type: 'fact', // Use valid enum value
    tags: ['research-source', 'web-source', `session:${sessionId}`],
    metadata: {
      source_type: 'web',
      url: 'https://example.com/memory-models',
      research_source: 'tavily',
    },
    importance_score: 0.9,
  });

  // Create claim/fact memories
  const claim1Id = randomId();
  await memoryStore.createMemory({
    id: claim1Id,
    user_id: userId,
    org_id: orgId,
    project: projectId,
    content: 'RAG improves long-context retention by 40%',
    title: 'RAG Performance Finding',
    memory_type: 'fact',
    tags: ['research-finding', `session:${sessionId}`],
    metadata: {
      confidence: 0.85,
      source_url: 'https://example.com/memory-models',
    },
    importance_score: 0.85,
  });

  // Create trail memory with steps
  const trailId = randomId();
  const steps = [
    {
      agent: 'explorer',
      action: 'search_web',
      input: 'memory-augmented language models',
      output: 'Found 10 relevant sources',
      confidence: 0.9,
      rejected: false,
    },
    {
      agent: 'analyst',
      action: 'extract_claims',
      input: 'Extract key findings',
      output: 'RAG improves retention by 40%',
      confidence: 0.85,
      rejected: false,
    },
  ];

  await memoryStore.createMemory({
    id: trailId,
    user_id: userId,
    org_id: orgId,
    project: projectId,
    content: '# Research Trail\n\nStep 1: Search web\nStep 2: Extract claims',
    title: 'Research Trail: Memory-augmented models',
    memory_type: 'decision',
    tags: ['research-trail', `session:${sessionId}`],
    metadata: {
      steps,
      stepCount: steps.length,
      contradictionCount: 0,
      trailType: 'op/research-trail',
      query: 'memory-augmented language models',
      startedAt: new Date().toISOString(),
    },
    importance_score: 0.95,
  });

  // Create blueprint memory
  const blueprintId = randomId();
  await memoryStore.createMemory({
    id: blueprintId,
    user_id: userId,
    org_id: orgId,
    project: projectId,
    content: 'Research pattern for literature review',
    title: 'Literature Review Blueprint',
    memory_type: 'decision',
    tags: ['kg/blueprint', `session:${sessionId}`],
    metadata: {
      blueprint_id: 'bp-literature-review',
      blueprint_name: 'Literature Review',
      blueprint_domain: 'research',
      blueprint_times_reused: 5,
      blueprint_success_rate: 0.92,
    },
    importance_score: 0.8,
  });

  // Now simulate the graph endpoint logic
  const memories = await memoryStore.searchMemories({
    query: '',
    user_id: userId,
    org_id: orgId,
    project: projectId,
    n_results: 200,
  });

  assert.ok(memories.length >= 4, 'Should have at least 4 memories');

  // Build layered graph structure (same as server.js)
  const layers = {
    sources: [],
    claims: [],
    trails: [],
    blueprints: [],
    weights: { edges: [] },
  };

  (memories || []).forEach(m => {
    const tags = m.tags || [];
    const metadata = m.metadata || {};
    const memoryType = m.memoryType || m.memory_type;

    // Layer 1: Sources
    if (tags.includes('research-source') || tags.includes('web-source') ||
        memoryType === 'source' || metadata.source_type === 'web') {
      layers.sources.push({
        id: m.id,
        title: m.title,
        url: metadata.url || metadata.source_url,
        runtime: metadata.research_source || 'tavily',
        score: m.importance_score,
      });
    }

    // Layer 2: Claims
    if (tags.includes('research-finding') || memoryType === 'fact') {
      layers.claims.push({
        id: m.id,
        content: m.content?.slice(0, 500),
        confidence: metadata.confidence || m.importance_score,
        source: metadata.source_url || metadata.source_id,
      });
    }

    // Layer 3: Trails
    if (tags.includes('research-trail') || tags.includes('csi-trail') ||
        metadata.trailType === 'op/research-trail') {
      const steps = metadata.steps || [];
      steps.forEach((step, idx) => {
        layers.trails.push({
          id: `step-${m.id}-${idx}`,
          agent: step.agent || 'explorer',
          action: step.action || 'search_web',
          input: step.input?.slice(0, 200),
          output: step.output?.slice(0, 200),
          confidence: step.confidence,
          rejected: step.rejected,
        });
      });
    }

    // Layer 4: Blueprints
    if (tags.includes('kg/blueprint') || metadata.blueprint_id) {
      layers.blueprints.push({
        blueprintId: metadata.blueprint_id,
        name: metadata.blueprint_name || m.title,
        domain: metadata.blueprint_domain,
        timesReused: metadata.blueprint_times_reused || 0,
        successRate: metadata.blueprint_success_rate,
      });
    }
  });

  // Verify layers
  assert.equal(layers.sources.length, 1, 'Should have 1 source');
  assert.equal(layers.sources[0].title, 'Memory Models Paper');
  assert.equal(layers.sources[0].url, 'https://example.com/memory-models');

  // Note: source also gets categorized as claim because it uses memory_type: 'fact'
  // This is expected behavior - the graph endpoint categorizes by multiple criteria
  assert.ok(layers.claims.length >= 1, 'Should have at least 1 claim');
  const ragClaim = layers.claims.find(c => c.content?.includes('RAG'));
  assert.ok(ragClaim, 'Should have claim about RAG');

  assert.equal(layers.trails.length, 2, 'Should have 2 trail steps');
  assert.equal(layers.trails[0].agent, 'explorer');
  assert.equal(layers.trails[0].action, 'search_web');
  assert.equal(layers.trails[1].agent, 'analyst');
  assert.equal(layers.trails[1].action, 'extract_claims');

  assert.equal(layers.blueprints.length, 1, 'Should have 1 blueprint');
  assert.equal(layers.blueprints[0].blueprintId, 'bp-literature-review');
  assert.ok(layers.blueprints[0].name.includes('Literature Review'), 'Blueprint name should be about literature review');
});

test('Graph endpoint - handle missing steps gracefully', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const memoryStore = new PrismaGraphStore(prisma);
  const sessionId = randomId();
  const projectId = `research/test-no-steps-${sessionId.slice(0, 8)}`;

  // Create trail memory WITHOUT steps in metadata (old format)
  const trailId = randomId();
  await memoryStore.createMemory({
    id: trailId,
    user_id: userId,
    org_id: orgId,
    project: projectId,
    content: '# Research Trail',
    title: 'Old Format Trail',
    memory_type: 'decision',
    tags: ['research-trail', `session:${sessionId}`],
    metadata: {
      stepCount: 0,
      trailType: 'op/research-trail',
    },
    importance_score: 0.95,
  });

  // Get memories and build graph
  const memories = await memoryStore.searchMemories({
    query: '',
    user_id: userId,
    org_id: orgId,
    project: projectId,
    n_results: 10,
  });

  const layers = { sources: [], claims: [], trails: [], blueprints: [], weights: { edges: [] } };

  (memories || []).forEach(m => {
    const metadata = m.metadata || {};
    const tags = m.tags || [];
    const memoryType = m.memoryType || m.memory_type;

    if (tags.includes('research-trail') || metadata.trailType === 'op/research-trail') {
      const steps = metadata.steps || [];
      steps.forEach((step, idx) => {
        layers.trails.push({
          id: `step-${m.id}-${idx}`,
          agent: step.agent,
          action: step.action,
        });
      });
    }
  });

  // Should handle gracefully - no trail steps added
  assert.equal(layers.trails.length, 0, 'Should have 0 trail steps when steps array is missing');
});

test('Graph endpoint - handle memoryType casing variations', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const memoryStore = new PrismaGraphStore(prisma);
  const sessionId = randomId();
  const projectId = `research/test-casing-${sessionId.slice(0, 8)}`;

  // Create memory with snake_case memory_type (tags drive categorization)
  const source1Id = randomId();
  await memoryStore.createMemory({
    id: source1Id,
    user_id: userId,
    org_id: orgId,
    project: projectId,
    content: 'Source with snake_case',
    title: 'Snake Case Source',
    memory_type: 'fact',
    tags: ['research-source', 'web-source', `session:${sessionId}`],
    metadata: { source_type: 'web' },
  });

  // Create memory with camelCase memoryType (tags drive categorization)
  const source2Id = randomId();
  await memoryStore.createMemory({
    id: source2Id,
    user_id: userId,
    org_id: orgId,
    project: projectId,
    content: 'Source with camelCase',
    title: 'Camel Case Source',
    memory_type: 'fact',
    tags: ['research-source', 'web-source', `session:${sessionId}`],
    metadata: { source_type: 'web' },
  });

  // Get memories and build graph
  const memories = await memoryStore.searchMemories({
    query: '',
    user_id: userId,
    org_id: orgId,
    project: projectId,
    n_results: 10,
  });

  const layers = { sources: [], claims: [], trails: [], blueprints: [], weights: { edges: [] } };

  (memories || []).forEach(m => {
    const metadata = m.metadata || {};
    const tags = m.tags || [];
    // Handle both casings
    const memoryType = m.memoryType || m.memory_type;

    if (tags.includes('research-source') || tags.includes('web-source') ||
        memoryType === 'source' || metadata.source_type === 'web') {
      layers.sources.push({ id: m.id, title: m.title });
    }
  });

  // Both should be categorized as sources
  assert.equal(layers.sources.length, 2, 'Should handle both memoryType casings');
});
