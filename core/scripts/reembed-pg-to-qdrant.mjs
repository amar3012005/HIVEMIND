#!/usr/bin/env node
/**
 * Re-embed Postgres memories into their per-tenant Qdrant collection.
 *
 * Closes the historical vector-coverage gap created by the collection-routing
 * bug (saves wrote to legacy 'BUNDB AGENT' / never embedded → recall read
 * per-tenant org_<id>/HIVEMIND_PERSONAL → keyword-only fallback). The forward
 * fix (qdrant-client.routeCollection) stops new mismatches; this backfills the
 * memories that are missing a vector.
 *
 * Idempotent: Qdrant point id == memory id, so storeMemory upserts (re-running
 * overwrites, never duplicates). Routing is handled by storeMemory itself
 * (memory.org_id → org_<id> for enterprise, HIVEMIND_PERSONAL for free).
 *
 * Only is_latest + non-deleted memories are backfilled (recall ignores the
 * rest). Skips memories with empty content (nothing to embed).
 *
 * Usage (inside hm-core):
 *   docker exec hm-core node /app/scripts/reembed-pg-to-qdrant.mjs --dry-run
 *   docker exec hm-core node /app/scripts/reembed-pg-to-qdrant.mjs --commit
 *   ORG_ID=<uuid> docker exec hm-core node /app/scripts/reembed-pg-to-qdrant.mjs --commit
 *   CONCURRENCY=6 BATCH=300 docker exec hm-core node /app/scripts/reembed-pg-to-qdrant.mjs --commit
 */

import { PrismaClient } from '@prisma/client';
import { PrismaGraphStore } from '/app/src/memory/prisma-graph-store.js';
import { getQdrantClient } from '/app/src/vector/qdrant-client.js';

const COMMIT = process.argv.includes('--commit');
const ORG_FILTER = process.env.ORG_ID || null;
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const BATCH = Number(process.env.BATCH || 300);

const prisma = new PrismaClient();
const store = new PrismaGraphStore(prisma);
const qc = getQdrantClient();

async function main() {
  if (qc._litellmReady) { try { await qc._litellmReady; } catch { /* ignore */ } }

  const where = { deletedAt: null, isLatest: true };
  if (ORG_FILTER) where.orgId = ORG_FILTER;

  const total = await prisma.memory.count({ where });
  console.log(`[reembed] target: ${total} latest memories${ORG_FILTER ? ` in org ${ORG_FILTER}` : ' (all orgs)'} | mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'} | concurrency=${CONCURRENCY}`);
  if (!COMMIT) {
    // Per-org breakdown so the operator sees the shape before committing.
    const byOrg = await prisma.memory.groupBy({ by: ['orgId'], where, _count: true, orderBy: { _count: { orgId: 'desc' } }, take: 15 });
    for (const o of byOrg) console.log(`  org ${o.orgId || '(null)'}: ${o._count} latest`);
    console.log('[reembed] dry-run only — re-run with --commit to embed + upsert.');
    await prisma.$disconnect();
    return;
  }

  let offset = Number(process.env.BATCH_OFFSET || 0);
  let done = 0, embedded = 0, skipped = 0, failed = 0;

  while (offset < total) {
    const rows = await prisma.memory.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      skip: offset,
      take: BATCH,
    });
    if (!rows.length) break;

    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= rows.length) return;
        const id = rows[i].id;
        try {
          // getMemory returns the fully-mapped shape (project_ids, scope, tags,
          // primary_team_id, content...) that storeMemory expects.
          const mem = await store.getMemory(id);
          if (!mem) { skipped++; continue; }
          if (!mem.content || !mem.content.trim()) { skipped++; continue; }
          // Pre-embed RAW content and pass {vector} so storeMemory SKIPS its
          // contextual-retrieval fact-augmentation (extractFacts in fact-extractor.js
          // is a synchronous regex that catastrophically backtracks on some content
          // → 99% CPU event-loop spin that hung the prior run). generateEmbedding is
          // an async network call, so the timeout backstop actually fires here.
          const vec = await Promise.race([
            qc.generateEmbedding(mem.content),
            new Promise((_, rej) => setTimeout(() => rej(new Error('embed timeout 20s')), 20000)),
          ]);
          if (!vec) { failed++; continue; }
          await qc.storeMemory(mem, { vector: vec }); // precomputed → no fact-extract; routes per-tenant + upserts (id == memory id)
          embedded++;
        } catch (err) {
          failed++;
          if (failed <= 40) console.warn(`  [fail] ${id}: ${err.message}`);
        } finally {
          done++;
          if (done % 100 === 0) console.log(`  …${done}/${total} (embedded=${embedded} skipped=${skipped} failed=${failed})`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    offset += rows.length;
  }

  console.log(`[reembed] DONE: embedded=${embedded} skipped=${skipped} failed=${failed} of ${total}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[reembed] fatal:', e); process.exit(1); });
