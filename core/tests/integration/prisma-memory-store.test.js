import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '../../src/memory/graph-engine.js';

const prisma = getPrismaClient();

function randomId() {
  return crypto.randomUUID();
}

test('prisma memory graph persists update versions and search results', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const store = new PrismaGraphStore(prisma);
  const engine = new MemoryGraphEngine({ store });

  try {
    const base = await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'integration-alpha',
      content: 'The production API port is 3000',
      source_metadata: {
        source_type: 'gmail',
        source_platform: 'gmail',
        source_id: 'msg-integration-1'
      }
    });

    const updated = await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'integration-alpha',
      content: 'Updated: the production API port is 3010',
      relationship: { type: 'Updates', target_id: base.memoryId },
      source_metadata: {
        source_type: 'claude_session',
        source_platform: 'claude_session',
        source_id: 'session-integration-1'
      }
    });

    const memories = await store.listMemories({
      user_id: userId,
      org_id: orgId,
      project: 'integration-alpha',
      is_latest: undefined,
      limit: 10,
      offset: 0
    });

    const search = await store.searchMemories({
      user_id: userId,
      org_id: orgId,
      project: 'integration-alpha',
      query: 'production port 3010',
      n_results: 5,
      is_latest: true
    });

    const versions = await prisma.memoryVersion.findMany({
      where: { memoryId: updated.memoryId },
      orderBy: { createdAt: 'asc' }
    });
    const prior = await store.getMemory(base.memoryId);
    const current = await store.getMemory(updated.memoryId);

    assert.equal(memories.total, 2);
    assert.equal(prior.is_latest, false);
    assert.equal(current.is_latest, true);
    assert.ok(search.length >= 1);
    assert.equal(search[0].id, updated.memoryId);
    assert.ok(versions.length >= 1);
  } finally {
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
    await prisma.sourceMetadata.deleteMany({
      where: { memory: { userId } }
    });
    await prisma.codeMemoryMetadata.deleteMany({
      where: { memory: { userId } }
    });
    await prisma.memoryVersion.deleteMany({
      where: { memory: { userId } }
    });
    await prisma.memory.deleteMany({
      where: { userId }
    });
    await prisma.userOrganization.deleteMany({
      where: { userId }
    });
    await prisma.user.delete({
      where: { id: userId }
    });
    await prisma.organization.delete({
      where: { id: orgId }
    });
  }
});
