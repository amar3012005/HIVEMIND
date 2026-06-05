/**
 * HIVE-MIND — per-org RetrievalConfig (Phase 2 / B2).
 *
 * The EvolveMem "action space": the tunable retrieval parameters the
 * self-evolution loop adjusts (deliver_limit, score_threshold, hnsw_ef,
 * ranking weights). Recall reads this with fallback to env/constant defaults,
 * so an org with no row behaves exactly as before (dark-safe).
 *
 * Raw SQL (not Prisma client) — the loop must never block on a client regen lag.
 *
 * @module memory/retrieval-config
 */

import { getPrismaClient } from '../db/prisma.js';

// Defaults mirror the current hard-coded constants — an org with no config row
// (or when the table is unreachable) gets identical pre-Phase-2 behavior.
export const DEFAULT_RETRIEVAL_CONFIG = Object.freeze({
  deliver_limit:     Number(process.env.RECALL_DELIVER_LIMIT || 5),
  score_threshold:   Number(process.env.HIVEMIND_VECTOR_SCORE_THRESHOLD || 0.15),
  hnsw_ef:           Number(process.env.QDRANT_HNSW_EF || 128),
  similarity_weight: 0.45,
  recency_weight:    0.15,
  vector_weight:     0.20,
  importance_weight: 0.10,
  graph_weight:      0.05,
  revision:          1,
});

// Tunable keys the evolution loop is allowed to change + their safe bounds.
// Any proposed delta outside these is rejected (capability-preserving guard).
export const TUNABLE_BOUNDS = Object.freeze({
  deliver_limit:     [3, 12],
  score_threshold:   [0.05, 0.45],
  hnsw_ef:           [64, 512],
  similarity_weight: [0.2, 0.7],
  recency_weight:    [0.0, 0.4],
  vector_weight:     [0.1, 0.5],
  importance_weight: [0.0, 0.3],
  graph_weight:      [0.0, 0.2],
});

const _cache = new Map(); // orgId → { cfg, ts }
const TTL_MS = 5 * 60 * 1000;

export function invalidateRetrievalConfig(orgId) {
  _cache.delete(orgId);
}

/**
 * Load the effective RetrievalConfig for an org (cached). Falls back to
 * defaults for any missing column / missing row / DB error.
 * @param {string|null} orgId
 * @returns {Promise<object>}
 */
export async function getRetrievalConfig(orgId) {
  if (!orgId) return { ...DEFAULT_RETRIEVAL_CONFIG };
  const hit = _cache.get(orgId);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.cfg;

  let cfg = { ...DEFAULT_RETRIEVAL_CONFIG };
  try {
    const prisma = getPrismaClient();
    const rows = await prisma.$queryRawUnsafe(
      `SELECT deliver_limit, score_threshold, hnsw_ef, similarity_weight,
              recency_weight, vector_weight, importance_weight, graph_weight, revision
         FROM hivemind.retrieval_config WHERE org_id = $1::uuid LIMIT 1`,
      orgId,
    );
    if (Array.isArray(rows) && rows[0]) {
      const r = rows[0];
      cfg = {
        deliver_limit:     Number(r.deliver_limit ?? DEFAULT_RETRIEVAL_CONFIG.deliver_limit),
        score_threshold:   Number(r.score_threshold ?? DEFAULT_RETRIEVAL_CONFIG.score_threshold),
        hnsw_ef:           Number(r.hnsw_ef ?? DEFAULT_RETRIEVAL_CONFIG.hnsw_ef),
        similarity_weight: Number(r.similarity_weight ?? DEFAULT_RETRIEVAL_CONFIG.similarity_weight),
        recency_weight:    Number(r.recency_weight ?? DEFAULT_RETRIEVAL_CONFIG.recency_weight),
        vector_weight:     Number(r.vector_weight ?? DEFAULT_RETRIEVAL_CONFIG.vector_weight),
        importance_weight: Number(r.importance_weight ?? DEFAULT_RETRIEVAL_CONFIG.importance_weight),
        graph_weight:      Number(r.graph_weight ?? DEFAULT_RETRIEVAL_CONFIG.graph_weight),
        revision:          Number(r.revision ?? 1),
      };
    }
  } catch {
    // table missing / db hiccup → defaults (dark-safe)
  }
  _cache.set(orgId, { cfg, ts: Date.now() });
  return cfg;
}

/** Clamp a value to its tunable bound; returns null if the key isn't tunable. */
export function clampTunable(key, value) {
  const b = TUNABLE_BOUNDS[key];
  if (!b || !Number.isFinite(Number(value))) return null;
  return Math.max(b[0], Math.min(b[1], Number(value)));
}

/**
 * Apply a config delta (upsert), clamped to safe bounds, bumping revision.
 * @param {string} orgId
 * @param {object} delta  partial config (only tunable keys honored)
 * @param {string} updatedBy
 * @returns {Promise<object>} the new effective config
 */
export async function applyRetrievalConfigDelta(orgId, delta = {}, updatedBy = 'evolution') {
  const current = await getRetrievalConfig(orgId);
  const next = { ...current };
  for (const [k, v] of Object.entries(delta)) {
    const clamped = clampTunable(k, v);
    if (clamped != null) next[k] = clamped;
  }
  const prisma = getPrismaClient();
  await prisma.$executeRawUnsafe(
    `INSERT INTO hivemind.retrieval_config
       (org_id, deliver_limit, score_threshold, hnsw_ef, similarity_weight,
        recency_weight, vector_weight, importance_weight, graph_weight, revision, updated_by, updated_at)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (org_id) DO UPDATE SET
       deliver_limit=$2, score_threshold=$3, hnsw_ef=$4, similarity_weight=$5,
       recency_weight=$6, vector_weight=$7, importance_weight=$8, graph_weight=$9,
       revision=$10, updated_by=$11, updated_at=now()`,
    orgId, next.deliver_limit, next.score_threshold, next.hnsw_ef, next.similarity_weight,
    next.recency_weight, next.vector_weight, next.importance_weight, next.graph_weight,
    (current.revision || 1) + 1, updatedBy,
  );
  invalidateRetrievalConfig(orgId);
  return { ...next, revision: (current.revision || 1) + 1 };
}

/**
 * Fire-and-forget TaskOutcome log row (the feedback signal). Never throws.
 */
export async function logTaskOutcome({ orgId, userId, query, returnedN, topScore, outcome = 'retrieved' }) {
  if (!orgId) return;
  try {
    const prisma = getPrismaClient();
    await prisma.$executeRawUnsafe(
      `INSERT INTO hivemind.task_outcome (org_id, user_id, query, returned_n, top_score, outcome)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
      orgId, userId || null, String(query || '').slice(0, 500), Number(returnedN || 0),
      Number.isFinite(topScore) ? Number(topScore) : null, outcome,
    );
  } catch { /* non-blocking */ }
}
