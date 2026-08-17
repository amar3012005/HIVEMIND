const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeFailure(error) {
  if (typeof error === 'string' && /^[a-z0-9_:-]{1,80}$/i.test(error)) return error;
  const type = String(error?.code || error?.status || error?.name || 'failed')
    .replace(/[^a-z0-9_.:-]/gi, '_').slice(0, 80);
  return `vector_sync_failed:${type}`;
}

async function client(db) {
  if (db) return db;
  const { getCentralPrismaClient } = await import('../db/prisma.js');
  return getCentralPrismaClient();
}

export function isTrackableManagedMemory(memory, { layer = 'memory', remote = false, personal = false } = {}) {
  return !remote && !personal
    && (layer === 'memory' || layer === 'cognitive')
    && UUID_RE.test(String(memory?.id || ''));
}

export async function markVectorPending(memory, collection, { db } = {}) {
  const prisma = await client(db);
  if (!prisma?.vectorEmbedding) return false;
  try {
    await prisma.vectorEmbedding.upsert({
      where: { memoryId: memory.id },
      create: {
        memoryId: memory.id,
        qdrantCollection: collection,
        qdrantPointId: memory.id,
        embeddingVersion: Number(memory.embedding_version || 1),
        syncStatus: 'pending',
        lastSyncAttempt: new Date(),
      },
      update: {
        qdrantCollection: collection,
        qdrantPointId: memory.id,
        embeddingVersion: Number(memory.embedding_version || 1),
        syncStatus: 'pending',
        lastSyncAttempt: new Date(),
        syncErrorMessage: null,
      },
    });
    return true;
  } catch {
    // Some legacy call sites invoke vector storage before the authoritative
    // memory transaction commits. The reconciler will establish the ledger
    // after the row exists; never invent a ledger row without its FK.
    return false;
  }
}

export async function markVectorSynced(memoryId, { db } = {}) {
  const prisma = await client(db);
  if (!prisma?.vectorEmbedding) return false;
  const result = await prisma.vectorEmbedding.updateMany({
    where: { memoryId },
    data: { syncStatus: 'synced', lastSyncAttempt: new Date(), syncErrorMessage: null },
  }).catch(() => ({ count: 0 }));
  return result.count === 1;
}

export async function markVectorFailed(memoryId, error, { db } = {}) {
  const prisma = await client(db);
  if (!prisma?.vectorEmbedding) return false;
  const result = await prisma.vectorEmbedding.updateMany({
    where: { memoryId },
    data: {
      syncStatus: 'failed',
      lastSyncAttempt: new Date(),
      // Persist a diagnostic class, never a provider body, URL, token, or
      // tenant content that may have been included in an exception message.
      syncErrorMessage: safeFailure(error),
    },
  }).catch(() => ({ count: 0 }));
  return result.count === 1;
}

export async function backfillSyncedVectors(memories, collection, { db } = {}) {
  const prisma = await client(db);
  const rows = (memories || []).filter((memory) => UUID_RE.test(String(memory?.id || '')));
  if (!prisma?.vectorEmbedding || rows.length === 0) return 0;
  const now = new Date();
  await prisma.vectorEmbedding.createMany({
    data: rows.map((memory) => ({
      memoryId: memory.id,
      qdrantCollection: collection,
      qdrantPointId: memory.id,
      embeddingVersion: Number(memory.embedding_version || 1),
      syncStatus: 'synced',
      lastSyncAttempt: now,
    })),
    skipDuplicates: true,
  });
  const result = await prisma.vectorEmbedding.updateMany({
    where: { memoryId: { in: rows.map((memory) => memory.id) } },
    data: {
      qdrantCollection: collection,
      syncStatus: 'synced',
      lastSyncAttempt: now,
      syncErrorMessage: null,
    },
  });
  return result.count;
}
