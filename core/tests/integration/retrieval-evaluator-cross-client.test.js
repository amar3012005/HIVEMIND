import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '../../src/memory/graph-engine.js';
import { getQdrantClient } from '../../src/vector/qdrant-client.js';
import { RetrievalEvaluator } from '../../src/evaluation/retrieval-evaluator.js';

const prisma = getPrismaClient();
const qdrantClient = getQdrantClient();

function randomId() {
  return crypto.randomUUID();
}

async function cleanupTenant(userId, orgId, memoryIds = []) {
  for (const memoryId of memoryIds) {
    await qdrantClient.deleteMemory(memoryId).catch(() => {});
  }

  await prisma.derivationJob.deleteMany({
    where: {
      OR: [
        { sourceMemory: { userId } },
        { targetMemory: { userId } }
      ]
    }
  });
  await prisma.relationship.deleteMany({
    where: {
      OR: [
        { fromMemory: { userId } },
        { toMemory: { userId } }
      ]
    }
  });
  await prisma.sourceMetadata.deleteMany({ where: { memory: { userId } } });
  await prisma.codeMemoryMetadata.deleteMany({ where: { memory: { userId } } });
  await prisma.memoryVersion.deleteMany({ where: { memory: { userId } } });
  await prisma.memory.deleteMany({ where: { userId } });
  await prisma.userOrganization.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.organization.delete({ where: { id: orgId } });
}

test('retrieval evaluator measures cross-client semantic recall', { skip: !prisma }, async (t) => {
  const connected = await qdrantClient.isConnected();
  if (!connected) {
    t.skip('Qdrant unavailable');
    return;
  }

  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const store = new PrismaGraphStore(prisma);
  const engine = new MemoryGraphEngine({ store });
  const evaluator = new RetrievalEvaluator({
    vectorStore: qdrantClient,
    graphStore: store,
    llmClient: null
  });
  const createdMemoryIds = [];

  try {
    const relevant = await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'cross-client-eval',
      title: 'Groq semantic eval note',
      content: 'Antigravity session note: GroqCloud low-latency inference endpoints power automated coding summaries.',
      tags: ['antigravity', 'semantic', 'eval'],
      source_metadata: {
        source_type: 'webapp',
        source_platform: 'antigravity',
        source_id: 'ag-eval-1'
      }
    });
    createdMemoryIds.push(relevant.memoryId);

    const distractor = await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'cross-client-eval',
      title: 'Unrelated session note',
      content: 'Claude session note about cleanup tasks and token rotation with no inference provider details.',
      tags: ['claude', 'security'],
      source_metadata: {
        source_type: 'webapp',
        source_platform: 'claude',
        source_id: 'claude-eval-1'
      }
    });
    createdMemoryIds.push(distractor.memoryId);

    for (const memoryId of createdMemoryIds) {
      const memory = await store.getMemory(memoryId);
      await qdrantClient.storeMemory(memory, {
        collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT'
      });
    }

    const relevantIds = [relevant.memoryId];
    const quickEvaluation = await evaluator.evaluateQuery('Groq API', relevantIds, {
      userId,
      orgId,
      method: 'quick',
      limit: 1,
      category: 'cross-platform'
    });
    const recallEvaluation = await evaluator.evaluateQuery('Groq API', relevantIds, {
      userId,
      orgId,
      method: 'recall',
      limit: 1,
      category: 'cross-platform'
    });
    const report = await evaluator.evaluateBatch([{
      query: 'Groq API',
      relevantMemories: relevantIds,
      category: 'cross-platform',
      difficulty: 'medium',
      description: 'Antigravity to Claude semantic recall'
    }], {
      userId,
      orgId,
      methods: ['quick', 'recall'],
      warmup: false,
      dataset: 'cross-client'
    });

    assert.equal(quickEvaluation.resultIds[0], relevant.memoryId);
    assert.equal(recallEvaluation.resultIds[0], relevant.memoryId);
    assert.equal(quickEvaluation.metrics.recallAt10, 1);
    assert.equal(recallEvaluation.metrics.recallAt10, 1);
    assert.equal(quickEvaluation.metrics.mrr, 1);
    assert.equal(recallEvaluation.metrics.mrr, 1);
    assert.equal(report.schemaVersion, '2026-03-19');
    assert.equal(report.dataset, 'cross-client');
    assert.equal(report.summary.successfulQueries, 2);
    assert.equal(report.bySearchMethod.quick.count, 1);
    assert.equal(report.bySearchMethod.recall.count, 1);
    assert.equal(report.queryMetadata[0].category, 'cross-platform');
  } finally {
    await cleanupTenant(userId, orgId, createdMemoryIds);
  }
});
