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

// Incremental full-history repair for targeted recall-quality users. The cursor
// advances only after the checked page has been handled, so a restart or Qdrant
// failure replays safely. The old reconciler remains the only path when every
// Flagship evaluation is off.
export async function reconcileQualityVectorsOnce({
  prisma, qdrantClient, qualityClient, logger = console,
  pageSize = 256, maxRowsPerOrg = 4096, maxEmbedsPerCycle = 400,
}) {
  const stats = { checked: 0, dense_repaired: 0, sparse_synced: 0, failed: 0 };
  if (!prisma || !qdrantClient || !qualityClient) return stats;
  const qUrl = process.env.QDRANT_URL || process.env.QDRANT_CLOUD_URL;
  if (!qUrl) return stats;
  const qKey = process.env.QDRANT_API_KEY || '';
  const orgs = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT m.org_id::text AS org, c.updated_at
    FROM hivemind.memories m
    LEFT JOIN hivemind.recall_quality_reconciliation_cursor c ON c.org_id=m.org_id
    WHERE m.org_id IS NOT NULL AND m.deleted_at IS NULL AND m.is_latest=true
    ORDER BY c.updated_at ASC NULLS FIRST LIMIT 2`);
  let embedBudget = maxEmbedsPerCycle;
  for (const { org } of orgs) {
    if (embedBudget <= 0) break;
    if (isMnemeOrg(org) || orgIsRemote(org)) continue;
    const cursorRows = await prisma.$queryRawUnsafe(
      `SELECT created_at_cursor, memory_id_cursor::text FROM hivemind.recall_quality_reconciliation_cursor WHERE org_id=$1::uuid`, org);
    const cursor = cursorRows[0] || {};
    const rows = await prisma.$queryRawUnsafe(
      `SELECT m.id::text, m.user_id::text, m.org_id::text, m.content, m.title, m.memory_type,
              m.project, m.project_id::text, m.scope, m.primary_team_id::text, m.created_at, m.tags,
              COALESCE(m.created_at, '1970-01-01'::timestamptz) AS cursor_created_at,
              COALESCE((SELECT array_agg(mp.project_id::text) FROM hivemind.memory_projects mp WHERE mp.memory_id=m.id), '{}') AS project_ids
       FROM hivemind.memories m
       WHERE m.org_id=$1::uuid AND m.deleted_at IS NULL AND m.is_latest=true
         AND ($2::timestamptz IS NULL OR (COALESCE(m.created_at, '1970-01-01'::timestamptz), m.id) < ($2::timestamptz, $3::uuid))
       ORDER BY COALESCE(m.created_at, '1970-01-01'::timestamptz) DESC, m.id DESC LIMIT $4`,
      org, cursor.created_at_cursor || null, cursor.memory_id_cursor || null, maxRowsPerOrg);
    if (!rows.length && cursor.created_at_cursor) {
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.recall_quality_reconciliation_cursor SET created_at_cursor=NULL, memory_id_cursor=NULL, updated_at=now() WHERE org_id=$1::uuid`, org);
      continue;
    }
    const collection = await collectionForOrg(org);
    const modes = new Map();
    let lastProcessed = null;
    let paused = false;
    for (let offset = 0; offset < rows.length; offset += pageSize) {
      const page = rows.slice(offset, offset + pageSize);
      const targeted = [];
      const unseenUsers = [...new Set(page.map((row) => row.user_id))].filter((id) => !modes.has(id));
      const evaluated = await Promise.all(unseenUsers.map((userId) =>
        qualityClient.modeFor({ orgId: org, userId }).catch(() => 'off')));
      unseenUsers.forEach((id, index) => modes.set(id, evaluated[index]));
      for (const row of page) {
        if (modes.get(row.user_id) !== 'off') targeted.push(row);
      }
      if (!targeted.length) { lastProcessed = page.at(-1); continue; }
      const present = await presentIds(collection, targeted.map((row) => row.id), { qUrl, qKey });
      if (present === null) { paused = true; stats.failed++; break; }
      stats.checked += targeted.length;
      const missing = targeted.filter((row) => !present.has(row.id));
      if (missing.length > embedBudget) { paused = true; break; }
      const ready = targeted.filter((row) => present.has(row.id));
      for (const row of missing) {
        embedBudget--;
        const shape = {
          id: row.id, user_id: row.user_id, org_id: org, content: row.content,
          title: row.title, memory_type: row.memory_type, project: row.project,
          project_id: row.project_id, project_ids: row.project_ids || [],
          primary_team_id: row.primary_team_id, scope: row.scope,
          created_at: row.created_at?.toISOString?.() || row.created_at,
          tags: row.tags || [], is_latest: true,
        };
        if (await runWithOrg(org, () => embedWithRetry(qdrantClient, shape, logger))) {
          ready.push(row);
          stats.dense_repaired++;
        } else stats.failed++;
      }
      await backfillSyncedVectors(ready, collection, { prisma });
      const synced = await prisma.$queryRawUnsafe(
        `SELECT s.memory_id::text AS id FROM hivemind.recall_sparse_sync s
         LEFT JOIN hivemind.vector_embeddings v ON v.memory_id=s.memory_id
         WHERE s.memory_id = ANY($1::uuid[]) AND (v.last_sync_attempt IS NULL OR s.updated_at >= v.last_sync_attempt)`,
        ready.map((row) => row.id));
      const syncedIds = new Set(synced.map((row) => row.id));
      const pending = ready.filter((row) => !syncedIds.has(row.id));
      if (pending.length) {
        const success = await runWithOrg(org, () => qdrantClient.updateRecallSparseVectors(org, pending));
        if (success) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO hivemind.recall_sparse_sync (memory_id) SELECT unnest($1::uuid[]) ON CONFLICT (memory_id) DO UPDATE SET updated_at=now()`,
            pending.map((row) => row.id));
          stats.sparse_synced += pending.length;
        } else stats.failed++;
      }
      lastProcessed = page.at(-1);
    }
    if (lastProcessed) {
      const complete = !paused && rows.length < maxRowsPerOrg;
      await prisma.$executeRawUnsafe(
        `INSERT INTO hivemind.recall_quality_reconciliation_cursor (org_id, created_at_cursor, memory_id_cursor)
         VALUES ($1::uuid, $2::timestamptz, $3::uuid)
         ON CONFLICT (org_id) DO UPDATE SET created_at_cursor=$2::timestamptz, memory_id_cursor=$3::uuid, updated_at=now()`,
        org, complete ? null : lastProcessed.cursor_created_at, complete ? null : lastProcessed.id);
    }
  }
  if (stats.checked || stats.failed) logger.info('[recall-quality-reconcile]', stats);
  return stats;
}
