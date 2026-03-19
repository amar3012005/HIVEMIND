import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '../../src/memory/graph-engine.js';
import { recallPersistedMemories } from '../../src/memory/persisted-retrieval.js';
import { ThreeTierRetrieval } from '../../src/external/search/three-tier-retrieval.js';
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

test('Antigravity-saved memory is recalled by Claude through semantic quick search', { skip: !prisma }, async (t) => {
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
  const retrieval = new ThreeTierRetrieval({
    vectorStore: qdrantClient,
    graphStore: store,
    llmClient: null
  });
  const createdMemoryIds = [];

  try {
    const antigravitySaved = await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'cross-client-memory',
      title: 'Semantic Groq integration note',
      content: 'Antigravity session note: we route auto-summarization through GroqCloud inference endpoints for low-latency coding assistance.',
      tags: ['antigravity', 'summaries', 'inference'],
      source_metadata: {
        source_type: 'webapp',
        source_platform: 'antigravity',
        source_id: 'ag-session-1'
      }
    });
    createdMemoryIds.push(antigravitySaved.memoryId);

    await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'cross-client-memory',
      title: 'Distractor session cleanup',
      content: 'Antigravity session summary about git history cleanup and token rotation with no inference provider details.',
      tags: ['antigravity', 'session', 'security'],
      source_metadata: {
        source_type: 'webapp',
        source_platform: 'antigravity',
        source_id: 'ag-session-2'
      }
    }).then(result => {
      createdMemoryIds.push(result.memoryId);
      return result;
    });

    for (const memoryId of createdMemoryIds) {
      const memory = await store.getMemory(memoryId);
      await qdrantClient.storeMemory(memory, {
        collectionName: process.env.QDRANT_COLLECTION || 'BUNDB AGENT'
      });
    }

    const recall = await recallPersistedMemories(store, {
      query_context: 'Groq API',
      user_id: userId,
      org_id: orgId,
      project: 'cross-client-memory',
      preferred_source_platforms: ['claude', 'antigravity'],
      max_memories: 5
    });

    const quick = await retrieval.quickSearch('Groq API', {
      userId,
      orgId,
      limit: 5,
      scoreThreshold: 0.15
    });

    const topRecall = recall.memories[0];
    const topQuick = quick.results[0];

    assert.ok(recall.memories.length >= 1);
    assert.equal(topRecall.id, antigravitySaved.memoryId);
    assert.match(topRecall.content, /GroqCloud inference endpoints/i);

    assert.ok(quick.results.length >= 1);
    assert.equal(topQuick.id, antigravitySaved.memoryId);
    assert.equal(topQuick.source, 'vector');
    assert.ok((topQuick.vectorScore || 0) > 0);
    assert.ok((topQuick.scoreBreakdown?.vector || 0) > 0);
    assert.ok((topQuick.keywordScore || 0) >= 0);

    const isolated = await retrieval.quickSearch('Groq API', {
      userId: randomId(),
      orgId: randomId(),
      limit: 5,
      scoreThreshold: 0.15
    });

    assert.equal(isolated.results.length, 0);
  } finally {
    await cleanupTenant(userId, orgId, createdMemoryIds);
  }
});
