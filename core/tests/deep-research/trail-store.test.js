/**
 * TrailStore Tests
 *
 * Tests for deep research trail persistence and graph layer generation.
 * Verifies that research trails, sources, and claims are properly stored
 * and retrieved for graph visualization.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { TrailStore, AGENT_TYPES, ACTION_TYPES } from '../../src/deep-research/trail-store.js';

const prisma = getPrismaClient();

function randomId() {
  return crypto.randomUUID();
}

test('TrailStore - persist and retrieve research trails with steps', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const memoryStore = new PrismaGraphStore(prisma);
  const trailStore = new TrailStore({ memoryStore, userId, orgId });

  const sessionId = randomId();
  const projectId = `research/test-${sessionId.slice(0, 8)}`;

  // Initialize trail
  const trailId = await trailStore.initTrail(sessionId, 'Test query for trail persistence', projectId, {
    blueprintUsed: null,
    blueprintCandidate: false,
    agentStates: {
      explorer: 'active',
      analyst: 'idle',
      verifier: 'idle',
      synthesizer: 'idle',
    },
  });

  assert.ok(trailId, 'Trail ID should be generated');

  // Record multiple steps
  await trailStore.recordStep(sessionId, {
    stepIndex: 0,
    agent: 'explorer',
    action: 'search_web',
    input: 'best practices memory-augmented language models 2025',
    output: 'Found 10 relevant sources about memory-augmented LLMs',
    confidence: 0.85,
    rejected: false,
  });

  await trailStore.recordStep(sessionId, {
    stepIndex: 1,
    agent: 'explorer',
    action: 'read_url',
    input: 'https://example.com/memory-models',
    output: 'Key findings: RAG architectures, external memory banks, attention mechanisms',
    confidence: 0.9,
    rejected: false,
  });

  await trailStore.recordStep(sessionId, {
    stepIndex: 2,
    agent: 'analyst',
    action: 'extract_claims',
    input: 'Extract claims from read results',
    output: 'Claim: RAG improves long-context retention by 40%',
    confidence: 0.88,
    rejected: false,
  });

  // Wait for async persistence
  await new Promise(resolve => setTimeout(resolve, 500));

  // Retrieve trail and verify
  const trail = trailStore.getTrail(sessionId);
  assert.ok(trail, 'Trail should exist in memory');
  assert.equal(trail.query, 'Test query for trail persistence');
  assert.equal(trail.steps.length, 3, 'Should have 3 steps recorded');

  // Verify step structure
  const step0 = trail.steps[0];
  assert.equal(step0.agent, 'explorer');
  assert.equal(step0.action, 'search_web');
  assert.ok(step0.output.includes('10 relevant sources'));

  // Verify trail has steps array (separate from metadata)
  assert.ok(Array.isArray(trail.steps), 'Trail should have steps array');
  assert.equal(trail.steps.length, 3, 'Trail steps should be 3');
});

test('TrailStore - record and detect contradictions', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const memoryStore = new PrismaGraphStore(prisma);
  const trailStore = new TrailStore({ memoryStore, userId, orgId });

  const sessionId = randomId();
  const projectId = `research/test-contradiction-${sessionId.slice(0, 8)}`;

  await trailStore.initTrail(sessionId, 'Contradiction detection test', projectId);

  // Record initial finding - use pattern that matches opposition pairs
  await trailStore.recordStep(sessionId, {
    stepIndex: 0,
    agent: 'explorer',
    action: 'search_web',
    input: 'memory models and performance',
    output: 'Study A shows memory models increases performance by 25%',
    confidence: 0.8,
    rejected: false,
  });

  // Record contradictory finding
  await trailStore.recordStep(sessionId, {
    stepIndex: 1,
    agent: 'explorer',
    action: 'search_web',
    input: 'memory models and performance',
    output: 'Study B shows memory models decreases performance by 15%',
    confidence: 0.75,
    rejected: false,
  });

  // Detect contradictions
  const contradiction = await trailStore.detectContradiction(sessionId, {
    content: 'Study B shows memory models decreases performance by 15%',
    source: 'web',
  }, 'factual');

  assert.ok(contradiction, 'Should detect contradiction between opposing claims');
  assert.ok(contradiction.unresolved, 'Contradiction should be unresolved');
  assert.ok(contradiction.claimA.content.includes('increases'), 'Should reference first claim');
  assert.ok(contradiction.claimB.content.includes('decreases'), 'Should reference second claim');

  // Verify contradiction was recorded in trail
  const trail = trailStore.getTrail(sessionId);
  assert.equal(trail.contradictions.length, 1, 'Trail should have 1 contradiction recorded');
});

test('TrailStore - serialize trail for storage', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const memoryStore = new PrismaGraphStore(prisma);
  const trailStore = new TrailStore({ memoryStore, userId, orgId });

  const sessionId = randomId();
  const projectId = `research/test-serialize-${sessionId.slice(0, 8)}`;

  await trailStore.initTrail(sessionId, 'Serialization test', projectId, {
    blueprintUsed: 'blueprint-123',
    blueprintCandidate: true,
  });

  await trailStore.recordStep(sessionId, {
    stepIndex: 0,
    agent: 'synthesizer',
    action: 'synthesize',
    input: 'Combine all findings',
    output: 'Final report: Memory-augmented models show promising results across multiple domains.',
    confidence: 0.95,
    rejected: false,
  });

  // Get serialized content
  const trail = trailStore.getTrail(sessionId);
  const serialized = trailStore._serializeTrail(trail);

  assert.ok(serialized.includes('Research Trail: Serialization test'));
  assert.ok(serialized.includes(sessionId), 'Should include session ID');
  // blueprintUsed is 'none' when null, so check for the value we set
  assert.ok(serialized.includes('blueprint-123'), 'Should include blueprint ID');
  assert.ok(serialized.includes('**Blueprint Candidate:** true'), 'Should include blueprint candidate flag');
  assert.ok(serialized.includes('Steps (1)'));
  assert.ok(serialized.includes('synthesizer/synthesize'));
  assert.ok(serialized.includes('Confidence: 0.95'));
});

test('TrailStore - finalize trail with report', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const memoryStore = new PrismaGraphStore(prisma);
  const trailStore = new TrailStore({ memoryStore, userId, orgId });

  const sessionId = randomId();
  const projectId = `research/test-finalize-${sessionId.slice(0, 8)}`;

  await trailStore.initTrail(sessionId, 'Finalization test', projectId);

  await trailStore.recordStep(sessionId, {
    stepIndex: 0,
    agent: 'explorer',
    action: 'search_web',
    input: 'test query',
    output: 'Test results',
    confidence: 0.8,
    rejected: false,
  });

  const report = {
    summary: 'Research completed successfully',
    findings: ['Finding 1', 'Finding 2'],
    confidence: 0.85,
  };

  const finalized = await trailStore.finalizeTrail(sessionId, report);

  assert.ok(finalized, 'Should return finalized trail');
  assert.equal(finalized.metadata.status, 'completed');
  assert.equal(finalized.metadata.report.summary, report.summary);
  assert.ok(finalized.metadata.completedAt, 'Should have completion timestamp');
});

test('TrailStore - query by project', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const memoryStore = new PrismaGraphStore(prisma);
  const trailStore = new TrailStore({ memoryStore, userId, orgId });

  const sessionId1 = randomId();
  const sessionId2 = randomId();
  const projectId = `research/test-project-${randomId().slice(0, 8)}`;

  await trailStore.initTrail(sessionId1, 'Query test 1', projectId);
  await trailStore.initTrail(sessionId2, 'Query test 2', projectId);

  const trails = await trailStore.queryByProject(projectId);

  assert.equal(trails.length, 2, 'Should return 2 trails for project');
});

test('Agent Types and Action Types constants', () => {
  assert.ok(Array.isArray(AGENT_TYPES), 'AGENT_TYPES should be an array');
  assert.ok(AGENT_TYPES.includes('explorer'), 'Should include explorer agent');
  assert.ok(AGENT_TYPES.includes('analyst'), 'Should include analyst agent');
  assert.ok(AGENT_TYPES.includes('verifier'), 'Should include verifier agent');
  assert.ok(AGENT_TYPES.includes('synthesizer'), 'Should include synthesizer agent');

  assert.ok(Array.isArray(ACTION_TYPES), 'ACTION_TYPES should be an array');
  assert.ok(ACTION_TYPES.includes('search_web'), 'Should include search_web action');
  assert.ok(ACTION_TYPES.includes('search_memory'), 'Should include search_memory action');
  assert.ok(ACTION_TYPES.includes('read_url'), 'Should include read_url action');
  assert.ok(ACTION_TYPES.includes('extract_claims'), 'Should include extract_claims action');
  assert.ok(ACTION_TYPES.includes('synthesize'), 'Should include synthesize action');
});
