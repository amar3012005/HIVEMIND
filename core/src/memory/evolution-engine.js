/**
 * HIVE-MIND — Self-evolving retrieval loop (Phase 3 / B4+B5).
 *
 * The EvolveMem AutoResearch loop, mapped onto the governance roles:
 *   Faraday  → diagnose()  : read TaskOutcome stats (0 tokens, pure SQL)
 *   Feynman  → propose()   : 1 cheap-model call → one RetrievalConfig delta
 *   Turing   → verifyGate() : replay memory-eval (Recall@K) before/after,
 *                             COMMIT iff recall↑ & p95 not worse → else REVERT
 * Every cycle writes a retrieval_evolution audit row (EVOLUTION.md as rows) and
 * dedupes proposals by delta_hash (rejected/seen-set → never re-propose).
 *
 * GATED: EVOLUTION_ENABLED!=='true' → no-op. Capability-preserving: a change is
 * kept only if it does not regress self-retrieval Recall@K. Cost ≈ 1 cheap LLM
 * call per org per run + deterministic replay (0 LLM).
 *
 * @module memory/evolution-engine
 */

import crypto from 'crypto';
import { getPrismaClient } from '../db/prisma.js';
import {
  getRetrievalConfig, applyRetrievalConfigDelta, clampTunable,
} from './retrieval-config.js';

const ENABLED       = process.env.EVOLUTION_ENABLED === 'true';
const MIN_OUTCOMES  = Number(process.env.EVOLUTION_MIN_OUTCOMES || 20);   // need signal
const P95_TOLERANCE = Number(process.env.EVOLUTION_P95_TOLERANCE || 1.5); // allow ≤1.5× p95
const EVAL_N        = Number(process.env.EVOLUTION_EVAL_N || 15);

export function isEvolutionEnabled() { return ENABLED; }

function deltaHash(delta) {
  const norm = JSON.stringify(Object.keys(delta).sort().reduce((o, k) => { o[k] = delta[k]; return o; }, {}));
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 64);
}

// ── Faraday role: diagnose from TaskOutcome stats (0 tokens) ────────────────
async function diagnose(prisma, orgId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n,
            AVG(returned_n)::float AS avg_returned,
            AVG(COALESCE(top_score,0))::float AS avg_top_score,
            SUM(CASE WHEN returned_n = 0 THEN 1 ELSE 0 END)::int AS empties,
            SUM(CASE WHEN COALESCE(top_score,0) < 0.3 THEN 1 ELSE 0 END)::int AS low_score
       FROM hivemind.task_outcome
      WHERE org_id = $1::uuid AND created_at > now() - interval '72 hours'`,
    orgId,
  );
  const s = rows?.[0] || {};
  const n = Number(s.n || 0);
  if (n < MIN_OUTCOMES) return { signal: false, reason: `insufficient outcomes (${n}<${MIN_OUTCOMES})`, stats: s };
  const emptyRate = n ? Number(s.empties || 0) / n : 0;
  const lowRate   = n ? Number(s.low_score || 0) / n : 0;
  // Signal when a meaningful share of recalls return nothing or weak top hits.
  if (emptyRate >= 0.15) return { signal: true, root: 'empty_recalls', emptyRate, lowRate, stats: s };
  if (lowRate   >= 0.40) return { signal: true, root: 'low_relevance', emptyRate, lowRate, stats: s };
  return { signal: false, reason: 'healthy', emptyRate, lowRate, stats: s };
}

// ── Feynman role: propose ONE config delta ─────────────────────────────────
// Rule-based + deterministic (0 tokens): a diagnosed root has an obvious knob
// step. The empirical replay-gate (Turing) validates it — so the proposal only
// needs to be a sensible bounded step, not a reasoned essay. This is cheaper
// AND more reliable than depending on a small model to emit strict JSON.
// EVOLUTION_STEP controls step size.
const STEP_THRESH = Number(process.env.EVOLUTION_STEP_THRESHOLD || 0.03);
const STEP_EF     = Number(process.env.EVOLUTION_STEP_EF || 64);
const STEP_WEIGHT = Number(process.env.EVOLUTION_STEP_WEIGHT || 0.03);

function tryDelta(delta, key, value, currentCfg) {
  const c = clampTunable(key, value);
  if (c != null && c !== currentCfg[key]) { delta[key] = c; return true; }
  return false;
}

function propose(diagnosis, currentCfg) {
  const delta = {};
  if (diagnosis.root === 'empty_recalls') {
    // Too strict / too narrow → loosen threshold, else widen ANN search.
    if (!tryDelta(delta, 'score_threshold', currentCfg.score_threshold - STEP_THRESH, currentCfg)) {
      tryDelta(delta, 'hnsw_ef', currentCfg.hnsw_ef + STEP_EF, currentCfg);
    }
  } else if (diagnosis.root === 'low_relevance') {
    // Noisy top hits → tighten threshold, else lean on salience.
    if (!tryDelta(delta, 'score_threshold', currentCfg.score_threshold + STEP_THRESH, currentCfg)) {
      tryDelta(delta, 'importance_weight', currentCfg.importance_weight + STEP_WEIGHT, currentCfg);
    }
  }
  if (!Object.keys(delta).length) return { delta: null, reason: 'no actionable delta (knob at bound)' };
  return { delta, reason: 'rule' };
}

/**
 * Run one self-evolution cycle for an org. No-op unless EVOLUTION_ENABLED.
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.userId  a member of the org (for the eval probe)
 * @param {string} args.apiKey  master/session key for /api/recall replay
 * @param {object} [args.logger]
 * @returns {Promise<object>} audit summary
 */
export async function runEvolution({ orgId, userId, apiKey, logger = console } = {}) {
  if (!ENABLED) return { skipped: 'disabled' };
  if (!orgId || !userId || !apiKey) return { skipped: 'missing orgId/userId/apiKey' };
  const prisma = getPrismaClient();
  const batchId = crypto.randomUUID();
  const audit = (decision, extra = {}) => _writeAudit(prisma, { orgId, batchId, decision, ...extra }, logger);

  // 1. diagnose (0 tokens)
  const dx = await diagnose(prisma, orgId);
  if (!dx.signal) { await audit('no_signal', { diagnosis: dx.reason }); return { decision: 'no_signal', diagnosis: dx.reason }; }

  // 2. propose (1 cheap call)
  const before = await getRetrievalConfig(orgId);
  const { delta, reason } = await propose(dx, before);
  if (!delta) { await audit('no_proposal', { diagnosis: dx.root }); return { decision: 'no_proposal', reason }; }
  const dh = deltaHash(delta);

  // dedupe: don't retry a delta tried in the last 7 days
  const seen = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM hivemind.retrieval_evolution
      WHERE org_id=$1::uuid AND delta_hash=$2 AND created_at > now()-interval '7 days' LIMIT 1`,
    orgId, dh,
  );
  if (Array.isArray(seen) && seen.length) {
    await audit('no_proposal', { diagnosis: dx.root, proposed_delta: delta, delta_hash: dh });
    return { decision: 'no_proposal', reason: 'delta already tried' };
  }

  // 3. verify gate — replay Recall@K before/after, commit-if-better else revert
  const { evalOrg } = await import('../../scripts/memory-eval.mjs');
  const baseUrl = `http://localhost:${process.env.PORT || 3000}`;
  const evBefore = await evalOrg({ orgId, userId, apiKey, baseUrl, n: EVAL_N, prisma });

  await applyRetrievalConfigDelta(orgId, delta, 'evolution');
  const evAfter = await evalOrg({ orgId, userId, apiKey, baseUrl, n: EVAL_N, prisma });

  const recallOk = (evAfter.recall_at_k || 0) >= (evBefore.recall_at_k || 0);
  const p95Ok = (evAfter.latency_ms?.p95 || 0) <= (evBefore.latency_ms?.p95 || 0) * P95_TOLERANCE || (evBefore.latency_ms?.p95 || 0) === 0;
  let decision;
  if (recallOk && p95Ok) {
    decision = 'committed';
  } else {
    await applyRetrievalConfigDelta(orgId, before, 'revert'); // restore prior config
    decision = 'reverted';
  }
  logger?.log?.(`[evolution] org=${orgId.slice(0,8)} ${decision} delta=${JSON.stringify(delta)} recall ${evBefore.recall_at_k}→${evAfter.recall_at_k}`);
  await audit(decision, {
    diagnosis: dx.root, proposed_delta: delta, delta_hash: dh,
    recall_before: evBefore.recall_at_k, recall_after: evAfter.recall_at_k,
    p95_before: evBefore.latency_ms?.p95, p95_after: evAfter.latency_ms?.p95,
  });
  return { decision, delta, recall_before: evBefore.recall_at_k, recall_after: evAfter.recall_at_k };
}

async function _writeAudit(prisma, row, logger) {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO hivemind.retrieval_evolution
         (org_id, batch_id, diagnosis, proposed_delta, delta_hash, recall_before, recall_after, p95_before, p95_after, decision)
       VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)`,
      row.orgId, row.batchId, row.diagnosis || null,
      JSON.stringify(row.proposed_delta || null), row.delta_hash || null,
      row.recall_before ?? null, row.recall_after ?? null,
      row.p95_before ?? null, row.p95_after ?? null, row.decision,
    );
  } catch (e) { logger?.warn?.(`[evolution] audit write failed: ${e.message}`); }
}
