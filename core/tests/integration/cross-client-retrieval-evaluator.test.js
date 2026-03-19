import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '../../src/memory/graph-engine.js';
import { RetrievalEvaluator } from '../../src/external/evaluation/retrieval-evaluator.js';
import { getQdrantClient } from '../../src/vector/qdrant-client.js';

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

test('retrieval evaluator measures cross-client semantic recall for Antigravity memory', { skip: !prisma }, async (t) => {
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
      title: 'GroqCloud summarization note',
      content: 'Antigravity stored note: GroqCloud inference endpoints power our low-latency coding summarizer pipeline.',
      tags: ['antigravity', 'summaries', 'inference'],
      source_metadata: {
        source_type: 'webapp',
        source_platform: 'antigravity',
        source_id: 'eval-ag-1'
      }
    });
    createdMemoryIds.push(relevant.memoryId);

    const distractor = await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'cross-client-eval',
      title: 'Security cleanup note',
      content: 'Antigravity stored note: secret rotation and git scrub follow-up after repository exposure.',
      tags: ['antigravity', 'security'],
      source_metadata: {
        source_type: 'webapp',
        source_platform: 'antigravity',
        source_id: 'eval-ag-2'
      }
    });
    createdMemoryIds.push(distractor.memoryId);

    for (const memoryId of createdMemoryIds) {
      const memory = await store.getMemory(memoryId);
      await qdrantClient.storeMemory(memory, {
        collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT'
      });
    }

    const evaluation = await evaluator.evaluateQuery('Groq API', [relevant.memoryId], {
      userId,
      orgId,
      method: 'quick',
      limit: 5,
      category: 'cross-client'
    });
    const report = await evaluator.evaluateBatch([{
      query: 'Groq API',
      relevantMemories: [relevant.memoryId],
      category: 'cross-client',
      difficulty: 'medium',
      tags: ['antigravity', 'groq']
    }], {
      userId,
      orgId,
      methods: ['quick'],
      warmup: false,
      dataset: 'cross-client'
    });

    assert.equal(evaluation.error, undefined);
    assert.equal(evaluation.resultIds[0], relevant.memoryId);
    assert.ok(evaluation.metrics.recallAt5 >= 1);
    assert.ok(evaluation.metrics.mrr >= 1);
    assert.equal(evaluation.passed, true);
    assert.equal(report.schemaVersion, '2026-03-19');
    assert.equal(report.dataset, 'cross-client');
    assert.equal(report.queryMetadata[0].category, 'cross-client');
    assert.equal(report.bySearchMethod.quick.count, 1);
  } finally {
    await cleanupTenant(userId, orgId, createdMemoryIds);
  }
});
