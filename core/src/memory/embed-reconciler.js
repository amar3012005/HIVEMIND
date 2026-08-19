/**
 * HIVE-MIND — Embedding reconciler. Guarantees every persisted memory eventually
 * lands in its org's Qdrant collection, regardless of which save path created it.
 *
 * WHY: memories are written to Postgres by ~16 call sites, but embedding into
 * Qdrant is a DECOUPLED `storeMemory` step that only some paths call (document
 * ingestion embeds; TARA-call summaries, chat-save, connector-email did NOT).
 * Result: a fraction of memories were absent from the vector store → invisible
 * to semantic recall (only the lexical lane could find them), so the top hit was
 * silently dropped. Auditing found ~21% of one org's memories un-embedded, and a
 * whole org 100% un-embedded. Chasing every save path is fragile (new paths
 * forget). This reconciler is the structural guarantee: a poll loop that finds
 * PG memories missing from Qdrant and embeds them with retry + loud logging.
 *
 * Stateless (no schema change): it batch-checks Qdrant presence by id via the
 * points-retrieve API (one call per ~batch ids), then embeds the absent ones
 * through the SAME storeMemory pipeline (routeCollection → per-tenant collection,
 * augmented-key embedding). Idempotent: an already-present id is skipped.
 *
 * @module src/memory/embed-reconciler
 */
import { runWithOrg } from '../db/prisma.js';
import { resolveCollectionForOrg, PER_TENANT } from '../vector/container-router.js';
import { backfillSyncedVectors } from '../vector/managed-vector-ledger.js';
import { isMnemeOrg, orgIsRemote } from '../vector/mneme/driver.js';

// resolveCollectionForOrg is ASYNC and plan-aware (enterprise → org_<id>, else the
// shared personal pool) — must be awaited, and it mirrors exactly what recall reads.
async function collectionForOrg(orgId) {
  return resolveCollectionForOrg(orgId);
}

// Which point ids of `ids` already exist in `collection` (one Qdrant retrieve call).
async function presentIds(collection, ids, { qUrl, qKey }) {
  if (!ids.length) return new Set();
  const res = await fetch(`${qUrl}/collections/${encodeURIComponent(collection)}/points`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(qKey ? { 'api-key': qKey } : {}) },
    body: JSON.stringify({ ids, with_payload: false, with_vector: false }),
  }).catch(() => null);
  if (!res || !res.ok) return null; // null = couldn't check (collection missing / error) → treat as unknown
  const j = await res.json().catch(() => ({}));
  return new Set((j?.result || []).map((p) => String(p.id)));
}

async function embedWithRetry(qdrantClient, memShape, logger, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const stored = await qdrantClient.storeMemory(memShape, {
        embeddingWorkload: 'maintenance',
      }); // routeCollection picks per-tenant collection
      if (!stored) throw new Error('vector_store_not_acknowledged');
      return true;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  logger.error(`[embed-reconciler] LOUD: embed FAILED after ${attempts} attempts for memory ${memShape.id} (org ${memShape.org_id}): ${lastErr?.message || lastErr}`);
  return false;
}

/**
 * One reconcile pass. Scans recent memories (fast drift catch) and, when
 * fullSweep is set, walks the whole backlog in pages.
 * @returns {Promise<{orgs:number,checked:number,missing:number,embedded:number,failed:number}>}
 */
export async function reconcileEmbeddingsOnce({
  prisma, qdrantClient, logger = console,
  sinceHours = 72, batch = 256, maxEmbedsPerCycle = 400, fullSweep = false,
}) {
  const qUrl = process.env.QDRANT_URL || process.env.QDRANT_CLOUD_URL;
  const qKey = process.env.QDRANT_API_KEY || '';
  const stats = { orgs: 0, checked: 0, missing: 0, embedded: 0, failed: 0 };
  if (!prisma || !qdrantClient || !qUrl) return stats;

  // Orgs with memories in scope. Fast mode: only orgs with recent activity.
  const orgRows = fullSweep
    ? await prisma.$queryRawUnsafe(`SELECT DISTINCT org_id::text org FROM hivemind.memories WHERE org_id IS NOT NULL AND deleted_at IS NULL AND is_latest=true`)
    : await prisma.$queryRawUnsafe(`SELECT DISTINCT org_id::text org FROM hivemind.memories WHERE org_id IS NOT NULL AND deleted_at IS NULL AND is_latest=true AND created_at > now() - ($1 || ' hours')::interval`, String(sinceHours));

  let embedBudget = maxEmbedsPerCycle;
  for (const { org } of orgRows) {
    if (embedBudget <= 0) break;
    const collection = await collectionForOrg(org);
    // Candidate memories for this org (recent window unless full sweep).
    const rows = await prisma.$queryRawUnsafe(
      fullSweep
        ? `SELECT id::text, user_id::text, org_id::text, content, memory_type, project, created_at, tags FROM hivemind.memories WHERE org_id=$1::uuid AND deleted_at IS NULL AND is_latest=true ORDER BY created_at DESC LIMIT 5000`
        : `SELECT id::text, user_id::text, org_id::text, content, memory_type, project, created_at, tags FROM hivemind.memories WHERE org_id=$1::uuid AND deleted_at IS NULL AND is_latest=true AND created_at > now() - ('${Number(sinceHours)} hours')::interval ORDER BY created_at DESC LIMIT 2000`,
      org,
    );
    if (!rows.length) continue;
    stats.orgs++;
    for (let i = 0; i < rows.length && embedBudget > 0; i += batch) {
      const slice = rows.slice(i, i + batch);
      const ids = slice.map((r) => r.id);
      const present = await presentIds(collection, ids, { qUrl, qKey });
      if (present === null) continue; // couldn't check → skip this batch, retry next cycle
      stats.checked += ids.length;
      const presentRows = slice.filter((r) => present.has(r.id));
      if (!isMnemeOrg(org) && !orgIsRemote(org)) {
        await backfillSyncedVectors(presentRows, collection, { prisma });
      }
      const missing = slice.filter((r) => !present.has(r.id));
      stats.missing += missing.length;
      for (const m of missing) {
        if (embedBudget <= 0) break;
        embedBudget--;
        const memShape = {
          id: m.id, user_id: m.user_id, org_id: m.org_id, content: m.content,
          memory_type: m.memory_type, is_latest: true, project: m.project, project_ids: [],
          created_at: m.created_at?.toISOString?.() || new Date().toISOString(),
          tags: Array.isArray(m.tags) ? m.tags : [],
        };
        // eslint-disable-next-line no-await-in-loop
        const ok = await runWithOrg(org, () => embedWithRetry(qdrantClient, memShape, logger));
        if (ok) stats.embedded++; else stats.failed++;
      }
    }
  }
  if (stats.missing > 0 || stats.failed > 0) {
    logger.warn(`[embed-reconciler] pass done: orgs=${stats.orgs} checked=${stats.checked} missing=${stats.missing} embedded=${stats.embedded} failed=${stats.failed}${fullSweep ? ' (full sweep)' : ''}`);
  }
  return stats;
}
