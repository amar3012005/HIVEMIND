import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '../../src/memory/graph-engine.js';
import { queryPersistedMemories } from '../../src/memory/persisted-retrieval.js';

const prisma = getPrismaClient();

function randomId() {
  return crypto.randomUUID();
}

test('prisma code ingest persists code metadata for structural retrieval', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const store = new PrismaGraphStore(prisma);
  const engine = new MemoryGraphEngine({ store });
  const code = `
    class AuthService {
      async validateToken(token) {
        return token.length > 10;
      }
    }
  `;

  try {
    const result = await engine.ingestCodeMemory({
      content: code,
      filepath: 'core/src/auth/service.js',
      language: 'javascript',
      user_id: userId,
      org_id: orgId,
      project: 'integration-code',
      tags: ['auth'],
      source_metadata: {
        source_type: 'repository',
        source_platform: 'repository',
        source_id: 'core/src/auth/service.js'
      }
    });

    const persisted = await store.listMemories({
      user_id: userId,
      org_id: orgId,
      project: 'integration-code',
      limit: 20,
      offset: 0
    });
    const metadataCount = await prisma.codeMemoryMetadata.count({
      where: { memory: { userId } }
    });
    const structuralHits = await queryPersistedMemories(store, {
      pattern: 'structural_implementation',
      user_id: userId,
      org_id: orgId,
      project: 'integration-code',
      symbol: 'validateToken',
      filepath: 'core/src/auth/service.js'
    });

    assert.ok(result.chunk_count >= 1);
    assert.equal(persisted.total, result.chunk_count);
    assert.equal(metadataCount, result.chunk_count);
    assert.ok(persisted.memories.every(memory => memory.tags.includes('code')));
    assert.ok(persisted.memories.some(memory => memory.metadata.filepath === 'core/src/auth/service.js'));
    assert.ok(persisted.memories.some(memory => Array.isArray(memory.metadata.ast_metadata?.scopeChain)));
    assert.ok(structuralHits.length >= 1);
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
