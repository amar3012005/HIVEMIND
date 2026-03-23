#!/usr/bin/env node
/**
 * Reindex persisted memories into Qdrant.
 *
 * This is intended for operator use after changing embedding providers or
 * after creating a fresh Qdrant collection.
 */

import { getPrismaClient } from '../db/prisma.js';
import { getQdrantClient } from '../vector/qdrant-client.js';
import { getQdrantCollections } from '../vector/collections.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    userId: process.env.HIVEMIND_DEFAULT_USER_ID || null,
    orgId: process.env.HIVEMIND_DEFAULT_ORG_ID || null,
    limit: null,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--user-id':
      case '-u':
        options.userId = args[++i];
        break;
      case '--org-id':
        options.orgId = args[++i];
        break;
      case '--limit':
      case '-l':
        options.limit = parseInt(args[++i], 10);
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        break;
    }
  }

  return options;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

function toQdrantMemory(memory) {
  return {
    id: memory.id,
    user_id: memory.userId,
    org_id: memory.orgId,
    project: memory.project,
    content: memory.content,
    memory_type: memory.memoryType,
    tags: memory.tags || [],
    source: memory.sourcePlatform || memory.sourceMetadata?.sourcePlatform || null,
    source_metadata: memory.sourceMetadata
      ? {
          source_type: memory.sourceMetadata.sourceType || 'unknown',
          source_id: memory.sourceMetadata.sourceId || null,
          source_platform: memory.sourceMetadata.sourcePlatform || memory.sourcePlatform || null,
          source_url: memory.sourceMetadata.sourceUrl || null,
          thread_id: memory.sourceMetadata.threadId || null,
          parent_message_id: memory.sourceMetadata.parentMessageId || null,
          metadata: memory.sourceMetadata.metadata || {}
        }
      : {},
    is_latest: memory.isLatest ?? true,
    created_at: memory.createdAt || new Date().toISOString(),
    updated_at: memory.updatedAt || memory.createdAt || new Date().toISOString(),
    document_date: memory.documentDate || null,
    event_dates: memory.eventDates || [],
    importance_score: memory.importanceScore ?? 0.5,
    strength: memory.strength ?? 1.0,
    recall_count: memory.recallCount ?? 0,
    visibility: memory.visibility || 'private',
    embedding_version: memory.embeddingVersion ?? 1,
    temporal_status: memory.temporalStatus || 'active',
    metadata: memory.metadata || {}
  };
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    console.log(`
Reindex memories into Qdrant.

Usage: node reindex-vectors.js [options]

Options:
  --user-id, -u   User ID to reindex
  --org-id        Org ID filter
  --limit, -l     Limit number of memories
  --help, -h      Show help
`);
    process.exit(0);
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error('Prisma client unavailable');
  }

  const qdrantCollections = getQdrantCollections();
  const qdrantClient = getQdrantClient();

  console.log('Ensuring Qdrant collections...');
  await qdrantCollections.createAllCollections();

  const where = {
    deletedAt: null,
    isLatest: true
  };

  if (options.userId) {
    where.userId = options.userId;
  }
  if (options.orgId) {
    where.orgId = options.orgId;
  }

  console.log('Loading memories from Postgres...');
  const memories = await prisma.memory.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: options.limit || undefined,
    include: {
      sourceMetadata: true
    }
  });

  console.log(`Loaded ${memories.length} memories`);
  if (memories.length === 0) {
    console.log('Nothing to reindex.');
    await prisma.$disconnect();
    return;
  }

  const qdrantMemories = memories.map(toQdrantMemory);
  const batches = chunk(qdrantMemories, 25);

  let indexed = 0;
  for (const batch of batches) {
    await qdrantClient.storeMemoriesBatch(batch);
    indexed += batch.length;
    console.log(`Indexed ${indexed}/${qdrantMemories.length}`);
  }

  const stats = await qdrantClient.getStats();
  console.log('Qdrant stats:', JSON.stringify(stats, null, 2));

  await prisma.$disconnect();
}

main().catch(async error => {
  console.error('Reindex failed:', error.message);
  try {
    const prisma = getPrismaClient();
    if (prisma) await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
