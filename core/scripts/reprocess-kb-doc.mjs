#!/usr/bin/env node
/**
 * Reprocess KB documents through the upgraded promotion pipeline
 * (boilerplate/quality gate + clean titles + deferred fact distillation)
 * WITHOUT re-parsing: segments are already stored in knowledge_segments.
 *
 * Per document:
 *   1. Soft-delete the OLD promoted memories (children via memory_evidence_links,
 *      distilled facts + children via the doc-id:<id> tag, the doc-parent via
 *      PartOf edges) and remove their Qdrant points.
 *   2. Re-run DocumentFirstIngestionService._promoteMemories over the stored
 *      segments — new quality gates apply, doc parent is rebuilt, and for big
 *      docs the deferred fact distillation runs (awaited here).
 *   3. Vector-index the new memories (route-level indexing doesn't run here).
 *
 * Usage (inside hm-core):
 *   DOC_TITLE_LIKE='%hauspost%' USER_ID=<uuid> docker exec -e DOC_TITLE_LIKE -e USER_ID hm-core node /app/scripts/reprocess-kb-doc.mjs --dry-run
 *   ... --commit
 */

import { PrismaClient } from '@prisma/client';
import { PrismaGraphStore } from '/app/src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '/app/src/memory/graph-engine.js';
import { SmartIngestRouter } from '/app/src/memory/smart-ingest-router.js';
import { getQdrantClient } from '/app/src/vector/qdrant-client.js';
import { DocumentFirstIngestionService } from '/app/src/knowledge/document-first-ingestion.js';

const COMMIT = process.argv.includes('--commit');
const TITLE_LIKE = process.env.DOC_TITLE_LIKE || null;
const USER_FILTER = process.env.USER_ID || null;
const DOC_IDS = (process.env.DOC_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!TITLE_LIKE && DOC_IDS.length === 0) {
  console.error('Set DOC_TITLE_LIKE or DOC_IDS');
  process.exit(2);
}

const prisma = new PrismaClient();
const store = new PrismaGraphStore(prisma);
const qc = getQdrantClient();

// Mirror server.js wiring (engine + router + vector store injection).
const engine = new MemoryGraphEngine({ store, vectorStore: qc, predictCalibrate: true });
const router = new SmartIngestRouter({ memoryStore: store });
if (typeof engine.setSmartIngestRouter === 'function') engine.setSmartIngestRouter(router);
const svc = new DocumentFirstIngestionService({
  db: prisma,
  smartIngestRouter: router,
  memoryGraphEngine: engine,
  doclingAdapter: null,        // not needed — segments already parsed
  embeddingService: null,      // not needed — promotion path doesn't embed segments
});

async function qdrantDelete(collection, ids) {
  if (!ids.length) return;
  await fetch(`${process.env.QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.QDRANT_API_KEY || '' },
    body: JSON.stringify({ points: ids }),
  }).catch(() => {});
}

async function main() {
  if (qc._litellmReady) { try { await qc._litellmReady; } catch { /* ignore */ } }
  const { resolveCollectionForOrg } = await import('/app/src/vector/container-router.js');

  const where = DOC_IDS.length
    ? `kd.id = ANY(ARRAY[${DOC_IDS.map(d => `'${d}'::uuid`).join(',')}])`
    : `kd.title ILIKE '${TITLE_LIKE.replace(/'/g, "''")}'${USER_FILTER ? ` AND kd.user_id='${USER_FILTER}'::uuid` : ''}`;
  const docs = await prisma.$queryRawUnsafe(
    `SELECT kd.id, kd.user_id, kd.org_id, kd.title,
            (SELECT count(*)::int FROM hivemind.knowledge_segments ks WHERE ks.document_id = kd.id) AS segs
       FROM hivemind.knowledge_documents kd
      WHERE ${where}
      ORDER BY kd.created_at ASC`,
  );
  console.log(`[reprocess] ${docs.length} document(s) matched | mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'}`);

  let gOldDeleted = 0, gPromoted = 0, gFacts = 0;
  for (const doc of docs) {
    // Old memory ids: evidence-linked children + doc-id tagged (children & facts) + PartOf parents.
    const oldRows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT m.id FROM hivemind.memories m
        WHERE m.deleted_at IS NULL AND (
          m.id IN (SELECT mel.memory_id FROM hivemind.memory_evidence_links mel WHERE mel.document_id = $1::uuid)
          OR m.tags && ARRAY['doc-id:' || $1]
          OR m.id IN (
            SELECT r.to_id FROM hivemind.relationships r
             WHERE r.from_id IN (SELECT mel.memory_id FROM hivemind.memory_evidence_links mel WHERE mel.document_id = $1::uuid)
               AND (r.type = 'PartOf' OR (r.metadata->>'subtype') = 'PartOf')
          )
        )`,
      doc.id,
    );
    const oldIds = oldRows.map(r => r.id);
    console.log(`\n— ${doc.title} (${doc.segs} segments): ${oldIds.length} old memories`);
    if (!COMMIT) continue;

    // 1. Soft-delete old + remove vectors.
    if (oldIds.length) {
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.memories SET deleted_at = now()
          WHERE id = ANY(ARRAY[${oldIds.map(i => `'${i}'::uuid`).join(',')}])`,
      );
      const collection = await resolveCollectionForOrg(doc.org_id);
      await qdrantDelete(collection, oldIds);
      gOldDeleted += oldIds.length;
    }

    // 2. Re-promote from stored segments through the NEW pipeline.
    const segments = await prisma.knowledgeSegment.findMany({
      where: { documentId: doc.id },
      orderBy: { segmentIndex: 'asc' },
    });
    const metadata = {
      filename: doc.title,
      documentTitle: doc.title,
      documentId: doc.id,
      documentHash: doc.id.slice(0, 16),
      tags: [],
      visibility: 'private', // parity with the original personal-scope uploads
    };
    const promoted = await svc._promoteMemories({ documentId: doc.id, segments, userId: doc.user_id, orgId: doc.org_id, metadata });
    const promotedIds = promoted.memories.filter(m => m?.id).map(m => m.id);
    gPromoted += promotedIds.length;
    console.log(`   promoted ${promotedIds.length} sections (candidates=${promoted.candidates.length})`);

    // 3. Await deferred distillation for this doc (fire-and-forget in prod).
    if (svc._distillPromise) {
      const d = await svc._distillPromise;
      if (d) { gFacts += d.created; console.log(`   distilled ${d.created} facts (failed=${d.failed})`); }
      svc._distillPromise = null;
    }

    // 4. Vector-index the new section memories (raw-content embed — avoids the
    //    extractFacts sync-regex hang; same pattern as reembed backfill).
    let indexed = 0;
    for (const id of promotedIds) {
      try {
        const mem = await store.getMemory(id);
        if (!mem?.content) continue;
        const vec = await Promise.race([
          qc.generateEmbedding(mem.content),
          new Promise((_, rej) => setTimeout(() => rej(new Error('embed timeout 20s')), 20000)),
        ]);
        if (vec) { await qc.storeMemory(mem, { vector: vec }); indexed++; }
      } catch (err) { console.warn(`   [index-fail] ${id}: ${err.message}`); }
    }
    console.log(`   vector-indexed ${indexed}/${promotedIds.length} sections`);
  }

  console.log(`\n[reprocess] DONE: oldDeleted=${gOldDeleted} promoted=${gPromoted} factsDistilled=${gFacts}`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error('[reprocess] fatal:', e); process.exit(1); });
