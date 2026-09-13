#!/usr/bin/env node
/**
 * Rebuild the disposable Qdrant projection from authoritative PostgreSQL rows.
 * Upserts are idempotent: memory/segment UUIDs are the Qdrant point IDs.
 *
 * Run inside hm-ingestion-worker:
 *   node /app/scripts/rebuild-qdrant-from-postgres.mjs --dry-run
 *   node /app/scripts/rebuild-qdrant-from-postgres.mjs --commit
 *   ORG_ID=<uuid> node /app/scripts/rebuild-qdrant-from-postgres.mjs --commit
 */

import { PrismaClient } from '@prisma/client';
import { PrismaGraphStore } from '/app/src/memory/prisma-graph-store.js';
import { contextualEmbedInputForSegment } from '/app/src/knowledge/contextual-embed-input.js';
import { assertEvidenceVectorPayload, buildEvidenceVectorPayload } from '/app/src/knowledge/provenance-metadata.js';
import { resolveCollectionForOrg } from '/app/src/vector/container-router.js';
import { getQdrantClient } from '/app/src/vector/qdrant-client.js';

const COMMIT = process.argv.includes('--commit');
const ORG_ID = process.env.ORG_ID || null;
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.CONCURRENCY || 3)));
const BATCH = Math.max(1, Math.min(500, Number(process.env.BATCH || 100)));
const QURL = String(process.env.QDRANT_URL || '').replace(/\/$/, '');
const QKEY = process.env.QDRANT_API_KEY || '';
const headers = { 'content-type': 'application/json', ...(QKEY ? { 'api-key': QKEY } : {}) };

const prisma = new PrismaClient();
const memoryStore = new PrismaGraphStore(prisma);
const qdrant = getQdrantClient();

async function mapConcurrent(rows, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      await fn(row);
    }
  }));
}

async function upsert(collection, points) {
  if (!points.length) return;
  const ready = await qdrant.ensureCollection(collection);
  if (!ready) throw new Error(`collection_unavailable:${collection}`);
  for (let offset = 0; offset < points.length; offset += 64) {
    const response = await fetch(`${QURL}/collections/${encodeURIComponent(collection)}/points?wait=true`, {
      method: 'PUT', headers, body: JSON.stringify({ points: points.slice(offset, offset + 64) }),
    });
    if (!response.ok) throw new Error(`qdrant_upsert_http_${response.status}`);
  }
}

async function rebuildMemories(summary) {
  const where = { deletedAt: null, isLatest: true, ...(ORG_ID ? { orgId: ORG_ID } : {}) };
  let cursor = null;
  while (true) {
    const rows = await prisma.memory.findMany({
      where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true }, orderBy: { id: 'asc' }, take: BATCH,
    });
    if (!rows.length) break;
    cursor = rows.at(-1).id;
    await mapConcurrent(rows, async ({ id }) => {
      try {
        const memory = await memoryStore.getMemory(id);
        if (!memory?.content?.trim()) { summary.memory.skipped += 1; return; }
        const vector = await qdrant.generateEmbedding(memory.content, { workload: 'maintenance', tenantId: memory.org_id });
        await qdrant.storeMemory(memory, { vector });
        summary.memory.rebuilt += 1;
      } catch (error) {
        summary.memory.failed += 1;
        console.warn(`[qdrant-rebuild] memory failed id=${id} code=${error?.code || 'REBUILD_FAILED'}`);
      }
    });
  }
}

async function rebuildEvidence(summary) {
  const where = { ...(ORG_ID ? { orgId: ORG_ID } : {}) };
  let cursor = null;
  while (true) {
    const rows = await prisma.knowledgeSegment.findMany({
      where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
      include: { document: { select: { title: true } } },
      orderBy: { id: 'asc' }, take: BATCH,
    });
    if (!rows.length) break;
    cursor = rows.at(-1).id;
    const byCollection = new Map();
    await mapConcurrent(rows, async (segment) => {
      try {
        if (!segment?.content?.trim()) { summary.evidence.skipped += 1; return; }
        segment.documentTitle = segment.document?.title || null;
        segment.embeddingModel = process.env.SINGULANCE_EMBED_MODEL
          || process.env.EMBEDDING_MODEL_NAME || process.env.OPENROUTER_EMBED_MODEL || 'bge-m3';
        segment.embeddingVersion = String(process.env.EMBEDDING_VERSION || process.env.EMBEDDING_MODEL_VERSION || '1');
        const vector = await qdrant.generateEmbedding(contextualEmbedInputForSegment(segment), {
          workload: 'maintenance', tenantId: segment.orgId,
        });
        const payload = assertEvidenceVectorPayload(buildEvidenceVectorPayload(segment));
        const collection = await resolveCollectionForOrg(segment.orgId);
        if (!byCollection.has(collection)) byCollection.set(collection, []);
        byCollection.get(collection).push({ id: segment.id, vector, payload });
      } catch (error) {
        summary.evidence.failed += 1;
        console.warn(`[qdrant-rebuild] evidence failed id=${segment.id} code=${error?.code || 'REBUILD_FAILED'}`);
      }
    });
    for (const [collection, points] of byCollection) {
      try {
        await upsert(collection, points);
        const ids = points.map((point) => point.id);
        await prisma.knowledgeSegment.updateMany({ where: { id: { in: ids } }, data: { vectorStored: true } });
        summary.evidence.rebuilt += points.length;
      } catch (error) {
        summary.evidence.failed += points.length;
        console.warn(`[qdrant-rebuild] evidence batch failed collection=${collection} count=${points.length} code=${error?.code || 'REBUILD_FAILED'}`);
      }
    }
  }
}

async function main() {
  const [memoryTotal, evidenceTotal] = await Promise.all([
    prisma.memory.count({ where: { deletedAt: null, isLatest: true, ...(ORG_ID ? { orgId: ORG_ID } : {}) } }),
    prisma.knowledgeSegment.count({ where: { ...(ORG_ID ? { orgId: ORG_ID } : {}) } }),
  ]);
  const summary = {
    mode: COMMIT ? 'commit' : 'dry-run', org: ORG_ID ? 'scoped' : 'all',
    memory: { expected: memoryTotal, rebuilt: 0, skipped: 0, failed: 0 },
    evidence: { expected: evidenceTotal, rebuilt: 0, skipped: 0, failed: 0 },
  };
  if (COMMIT) {
    await rebuildMemories(summary);
    await rebuildEvidence(summary);
  }
  console.log(JSON.stringify(summary));
  if (COMMIT && (summary.memory.failed || summary.evidence.failed)) process.exitCode = 2;
}

main().catch((error) => { console.error(`[qdrant-rebuild] fatal code=${error?.code || 'REBUILD_FATAL'}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
