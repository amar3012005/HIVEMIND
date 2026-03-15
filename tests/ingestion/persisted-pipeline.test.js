const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { createIngestionPipeline } = require('../../src/ingestion');

function waitForEvent(emitter, eventName, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.removeListener(eventName, handler);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    function handler(payload) {
      clearTimeout(timeout);
      resolve(payload);
    }

    emitter.once(eventName, handler);
  });
}

async function loadCore() {
  const envPath = path.resolve(__dirname, '../../core/.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }

  const base = path.resolve(__dirname, '../../core/src');
  const { getPrismaClient } = await import(pathToFileURL(path.join(base, 'db/prisma.js')).href);

  return { prisma: getPrismaClient() };
}

test('pipeline persists code memories and creates a qdrant collection', async (t) => {
  const { prisma } = await loadCore();
  if (!prisma || !process.env.QDRANT_URL) {
    t.skip('DATABASE_URL or QDRANT_URL not configured');
    return;
  }

  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const pipeline = createIngestionPipeline({ queue: { forceInMemory: true } });
  const collectionName = `hivemind_${userId}`;

  try {
    const completion = waitForEvent(pipeline.eventBus, 'memory.ingested');
    const enqueued = await pipeline.ingest({
      source_type: 'code',
      user_id: userId,
      org_id: orgId,
      project: 'pipeline-integration',
      filepath: 'src/auth/service.js',
      content: 'class AuthService { async validateToken(token) { return token.length > 10; } }',
      tags: ['auth'],
      idempotency_key: `pipeline-${userId}`,
    });

    assert.ok(enqueued.jobId);
    const done = await completion;
    assert.equal(done.status, 'Done');

    const memories = await prisma.memory.findMany({
      where: { userId, orgId, project: 'pipeline-integration' },
      include: {
        codeMetadata: true,
        sourceMetadata: true,
      },
    });

    assert.ok(memories.length >= 1);
    assert.ok(memories.every((memory) => memory.codeMetadata));
    assert.ok(memories.every((memory) => memory.sourceMetadata));

    const collectionResponse = await fetch(`${process.env.QDRANT_URL}/collections/${collectionName}`, {
      headers: process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {},
    });
    assert.equal(collectionResponse.ok, true);
  } finally {
    await pipeline.close();
    await prisma.derivationJob.deleteMany({
      where: {
        OR: [
          { sourceMemory: { userId } },
          { targetMemory: { userId } },
        ],
      },
    });
    await prisma.relationship.deleteMany({
      where: {
        OR: [
          { fromMemory: { userId } },
          { toMemory: { userId } },
        ],
      },
    });
    await prisma.sourceMetadata.deleteMany({
      where: { memory: { userId } },
    });
    await prisma.codeMemoryMetadata.deleteMany({
      where: { memory: { userId } },
    });
    await prisma.memoryVersion.deleteMany({
      where: { memory: { userId } },
    });
    await prisma.memory.deleteMany({
      where: { userId },
    });
    await prisma.userOrganization.deleteMany({
      where: { userId },
    });
    await prisma.user.deleteMany({
      where: { id: userId },
    });
    await prisma.organization.deleteMany({
      where: { id: orgId },
    });
    await fetch(`${process.env.QDRANT_URL}/collections/${collectionName}`, {
      method: 'DELETE',
      headers: process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {},
    });
  }
});
