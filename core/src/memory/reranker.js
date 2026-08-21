/**
 * HIVE-MIND — Cross-encoder reranker (Stage 4 / P1 of the 10M roadmap).
 *
 * Retrieve-wide → rerank → deliver-narrow. After the algorithmic rank
 * (RRF + MMR + salience), an optional cross-encoder rescues precision@k by
 * scoring each (query, candidate) pair jointly. +17–40% nDCG@10 typical.
 *
 * GATED + NO-OP BY DEFAULT. With RERANK_ENABLED!=='true' this returns the
 * candidates unchanged — zero latency, zero prod impact. Flip on only once a
 * cross-encoder endpoint exists (TEI self-host on GPU, or Cohere Rerank):
 *   RERANK_ENABLED=true
 *   RERANK_PROVIDER=tei|cohere
 *   RERANK_URL=<endpoint>            # OpenRouter: .../api/v1/rerank
 *   RERANK_MODEL=voyageai/rerank-2.5
 *   RERANK_API_KEY=<key>             # OpenRouter or compatible endpoint
 *   RERANK_POOL=100                  # candidates to rerank (cap 200 — pointwise
 *                                    #   rerankers DEGRADE past ~500, arXiv 2411.11767)
 *   RERANK_TIMEOUT_MS=1500
 *
 * Never throws: any error/timeout → original order (graceful degrade).
 *
 * @module memory/reranker
 */

import { gatewayFirstFetch } from '../llm/cloudflare-gateway.js';
import { currentStageSignal, remainingStageMs } from '../runtime/stage-deadline.js';

const ENABLED   = process.env.RERANK_ENABLED === 'true';
const PROVIDER  = (process.env.RERANK_PROVIDER || 'cohere').toLowerCase();
const URL       = (process.env.RERANK_URL || '').replace(/\/+$/, '');
const MODEL     = process.env.RERANK_MODEL || 'voyageai/rerank-2.5';
const API_KEY   = process.env.RERANK_API_KEY || '';
const FALLBACK_URL = (process.env.RERANK_FALLBACK_URL || '').replace(/\/+$/, '');
const FALLBACK_PROVIDER = (process.env.RERANK_FALLBACK_PROVIDER || 'cohere').toLowerCase();
const FALLBACK_MODEL = process.env.RERANK_FALLBACK_MODEL || '';
const FALLBACK_API_KEY = process.env.RERANK_FALLBACK_API_KEY || process.env.OPENROUTER_API_KEY || '';
const POOL      = Math.min(Number(process.env.RERANK_POOL || 100), 200); // hard cap 200
// The self-hosted endpoint accepts the complete 150-document pool and batches
// internally on one GPU. One request avoids multiplied network overhead and
// keeps the provider receipt/latency attributable to one authoritative rerank.
// Sharding remains an explicit emergency knob but is no longer the default.
const PRIMARY_SHARDS = Math.max(1, Math.min(4, Number(process.env.RERANK_PRIMARY_SHARDS || 1)));
const PRIMARY_SHARD_MIN_DOCS = Math.max(2, Number(process.env.RERANK_PRIMARY_SHARD_MIN_DOCS || 18));
const PROJECT_TO_CHARS = Math.max(0, Math.min(2000, Number(process.env.RERANK_PROJECT_TO_CHARS || 0)));
// 1500ms was too tight: Cohere-via-OpenRouter is ~300ms normally but spikes to
// 1-2s under burst/queueing, tripping the abort → the cross-encoder pass got
// silently dropped exactly when load was highest. 2500ms covers spikes while
// still bounding the answer path.
const TIMEOUT   = Number(process.env.RERANK_TIMEOUT_MS || 2500);
// One request receives one wall-clock budget across primary, retry and
// fallback providers. Previously each combination received a fresh 2.5s,
// allowing the chain to outlive the recall response by many seconds.
// The self-hosted BGE service scores the complete mixed pool in one request.
// A 1.2s shared budget gave it only ~600ms after reserving the provider
// fallback, while a real 45–52-row request can legitimately take 0.8–2.2s
// end-to-end even though GPU compute is much shorter. That configuration
// guaranteed an abort, then lane interleaving made unrelated evidence compete
// with the requested topic. Keep a bounded fallback window, but let the
// authoritative primary finish a normal full-pool request.
const TOTAL_TIMEOUT = Math.max(100, Number(process.env.RERANK_TOTAL_TIMEOUT_MS || 3500));
const MAX_ATTEMPTS_TOTAL = Math.max(1, Number(process.env.RERANK_MAX_ATTEMPTS_TOTAL || 2));
// The managed fallback needs a real warm request budget. Reserving 350ms
// made a timeout on the self-hosted primary leave Voyage Lite only ~350ms,
// which is below its observed normal tail and caused a needless degradation.
// With the production two-attempt contract, split the 1.2s total budget into
// two viable ~600ms attempts. Operators can still tune this explicitly.
const FALLBACK_RESERVE = Math.max(50, Number(process.env.RERANK_FALLBACK_RESERVE_MS || 600));
// One transient retry (abort/timeout/429/5xx) so a single slow attempt doesn't
// drop the rerank — ensures Cohere is actually used, not just when the network
// is calm. Non-transient errors degrade immediately (no load amplification).
const RETRIES   = Number(process.env.RERANK_RETRIES || 1);
const RETRYABLE = /abort|timeout|429|50[0-9]|network|fetch failed|ECONNRESET|ETIMEDOUT/i;

// MODEL FALLBACK CHAIN — losing the cross-encoder is not a small degradation. Without it
// deliverHybrid interleaves lanes instead of comparing them, which is what buries the
// German `E3DC Zähler` row. So a single model being unavailable must not cost us the pass.
//
// Production evaluation on 2026-08-18 compared every generally available
// text reranker exposed by OpenRouter. Voyage rerank-2.5 retained every
// required multilingual, small-detail, negation, source-specific and 150-row
// late-pool fact. Its measured p95 was 501ms. Voyage 2.5 Lite provides the
// first rapid fallback; it also retained every fact and served the 150-row
// pool in 252-266ms. One shared 1200ms budget gives the quality model enough
// room while reserving one warm-sized fallback attempt. The code-level chain
// remains a safety net for environments that do not load prod-defaults.conf.
// NOT in the chain: nvidia/llama-nemotron-rerank-vl-1b-v2:free is free but returned HTTP 404
// "No endpoints available matching your guardrail restrictions" on this account — a free
// model that cannot be called is not a fallback.
const MODEL_CHAIN = [...new Set([
  MODEL,
  // An explicitly empty setting means no same-endpoint legacy fallbacks. The
  // managed RERANK_FALLBACK_URL is the one authorized secondary route. Using
  // `||` here accidentally restored three historical models whenever the
  // production setting was blank, turning the intended two-provider chain
  // into five attempts.
  ...String(process.env.RERANK_FALLBACK_MODELS ?? '')
    .split(',').map((m) => m.trim()).filter(Boolean),
])];

// A fallback model is not necessarily served by the primary endpoint. Keep the
// route together with its model/provider/key so a self-hosted primary can fail
// over to a managed provider without sending an unsupported model to the
// primary host. Legacy RERANK_FALLBACK_MODELS remain same-endpoint fallbacks.
const TARGET_CHAIN = [];
const seenTargets = new Set();
function addTarget(target) {
  if (!target?.url || !target?.model) return;
  const key = `${target.provider}|${target.url}|${target.model}`;
  if (seenTargets.has(key)) return;
  seenTargets.add(key);
  TARGET_CHAIN.push(target);
}
addTarget({ role: 'primary', provider: PROVIDER, url: URL, model: MODEL, apiKey: API_KEY });
if (FALLBACK_URL && FALLBACK_MODEL) {
  addTarget({
    role: 'fallback',
    provider: FALLBACK_PROVIDER,
    url: FALLBACK_URL,
    model: FALLBACK_MODEL,
    apiKey: FALLBACK_API_KEY,
  });
}
for (const model of MODEL_CHAIN.slice(1)) {
  addTarget({ role: 'legacy-fallback', provider: PROVIDER, url: URL, model, apiKey: API_KEY });
}

export function isRerankEnabled() {
  return ENABLED && !!URL;
}

let warmupInFlight = null;

/**
 * Prime the remote reranker independently of tenant data.
 *
 * A tenant recall is not a reliable warm-up: an empty/single-result tenant
 * never reaches the provider, leaving the first real mixed result to pay the
 * provider's scale-from-idle latency. Two synthetic documents guarantee one
 * harmless inference while containing no customer data. Concurrent boot and
 * keep-warm calls coalesce into the same request.
 */
export async function warmUpReranker({
  enabled = isRerankEnabled(),
  run = rerank,
} = {}) {
  if (!enabled) return { ok: false, skipped: true };
  if (warmupInFlight) return warmupInFlight;

  warmupInFlight = run(
    'hivemind retrieval readiness probe',
    [
      { id: 'warm-relevant', content: 'retrieval readiness probe' },
      { id: 'warm-control', content: 'unrelated control passage' },
    ],
    { topN: 1 },
  ).then((rows) => ({
    ok: Number.isFinite(rows?.[0]?.rerank_score),
    skipped: false,
  })).finally(() => {
    warmupInFlight = null;
  });

  return warmupInFlight;
}

function textOf(c, maxChars = 2000) {
  return [c.title, typeof c.content === 'string' ? c.content : '']
    .filter(Boolean).join('\n').slice(0, maxChars > 0 ? maxChars : undefined);
}

function validateScores(scored, expectedCount, model) {
  if (!Array.isArray(scored) || scored.length !== expectedCount) {
    throw new Error(`invalid rerank row count (${model}): got ${scored?.length ?? 'none'}, want ${expectedCount}`);
  }
  const seen = new Set();
  for (const row of scored) {
    if (!Number.isInteger(row.index) || row.index < 0 || row.index >= expectedCount
        || seen.has(row.index) || !Number.isFinite(row.score)) {
      throw new Error(`invalid rerank score contract (${model})`);
    }
    seen.add(row.index);
  }
  return scored;
}

async function callTei(query, texts, signal, target) {
  // HuggingFace TEI reranker: { query, texts } → [{ index, score }]
  const r = await gatewayFirstFetch(`${target.url}/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}) },
    body: JSON.stringify({ query, texts, model: target.model }),
    signal,
  });
  if (!r.ok) throw new Error(`TEI rerank ${r.status} (${target.model})`);
  const j = await r.json();
  return validateScores(
    (Array.isArray(j) ? j : j.results || []).map((x) => ({ index: x.index, score: x.score ?? x.relevance_score })),
    texts.length,
    target.model,
  );
}

async function callCohere(query, texts, signal, target) {
  // Cohere Rerank: { model, query, documents } → { results:[{ index, relevance_score }] }
  const r = await gatewayFirstFetch(`${target.url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}) },
    body: JSON.stringify({
      model: target.model,
      query,
      documents: texts,
      top_n: texts.length,
      // Singulance's self-hosted route selects the most query-relevant window
      // before BGE scoring. Full candidate content remains untouched for final
      // synthesis. Never send this custom extension to managed fallbacks.
      ...(target.role === 'primary' && PROJECT_TO_CHARS > 0
        ? { project_to_chars: PROJECT_TO_CHARS }
        : {}),
    }),
    signal,
  });
  if (!r.ok) throw new Error(`Cohere rerank ${r.status} (${target.model})`);
  const j = await r.json();
  return validateScores(
    (j.results || []).map((x) => ({ index: x.index, score: x.relevance_score })),
    texts.length,
    target.model,
  );
}

async function callTarget(query, texts, signal, target) {
  if (target.provider !== 'cohere') return callTei(query, texts, signal, target);
  // BGE cross-encoder scores are pointwise: each query/document score is
  // independent and therefore comparable across batches. Split only the
  // self-hosted primary's wide pool; this removes serial GPU queue time while
  // avoiding multiplied calls/cost on a managed fallback.
  if (target.role !== 'primary' || PRIMARY_SHARDS === 1 || texts.length < PRIMARY_SHARD_MIN_DOCS) {
    return callCohere(query, texts, signal, target);
  }
  const shardCount = Math.min(PRIMARY_SHARDS, texts.length);
  const shardSize = Math.ceil(texts.length / shardCount);
  const batches = [];
  for (let offset = 0; offset < texts.length; offset += shardSize) {
    const shard = texts.slice(offset, offset + shardSize);
    batches.push(callCohere(query, shard, signal, target)
      .then((rows) => rows.map((row) => ({ ...row, index: row.index + offset }))));
  }
  return validateScores((await Promise.all(batches)).flat(), texts.length, target.model);
}

/**
 * Rerank candidates by cross-encoder relevance to query. No-op when disabled.
 * @param {string} query
 * @param {Array<object>} candidates  ranked memory objects (title/content)
 * @param {object} [opts]
 * @param {number} [opts.topN]  return only the top-N after rerank
 * @returns {Promise<Array<object>>}
 */
export async function rerank(query, candidates, { topN } = {}) {
  if (!isRerankEnabled() || !query || !Array.isArray(candidates) || candidates.length <= 1) {
    return topN ? candidates.slice(0, topN) : candidates;
  }
  const pool = candidates.slice(0, POOL);
  const tail = candidates.slice(POOL); // never reranked, kept after
  const boundedTexts = pool.map((candidate) => textOf(candidate));
  // Server-side projection must see the complete candidate; otherwise a
  // relevant fact after the old 2,000-character client cap is irretrievably
  // absent. Managed fallbacks keep the bounded representation.
  const projectableTexts = PROJECT_TO_CHARS > 0
    ? pool.map((candidate) => textOf(candidate, 0))
    : boundedTexts;
  const runStartedAt = Date.now();
  const runDeadlineAt = runStartedAt + TOTAL_TIMEOUT;
  let totalAttempts = 0;
  const finish = (rows, meta) => {
    const delivered = topN ? rows.slice(0, topN) : rows;
    Object.defineProperty(delivered, 'rerank_meta', {
      value: { ...meta, attempts: totalAttempts, latency_ms: Date.now() - runStartedAt },
      enumerable: false,
    });
    return delivered;
  };

  // One attempt with a fresh timeout. Retryable failures (transient) get one
  // more shot before we degrade; anything else degrades immediately.
  const attempt = async (target, attemptBudget) => {
    const ctrl = new AbortController();
    const parentSignal = currentStageSignal();
    const abortFromParent = () => {
      if (!ctrl.signal.aborted) ctrl.abort(parentSignal?.reason);
    };
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!ctrl.signal.aborted) ctrl.abort(new Error(`rerank timeout after ${attemptBudget}ms`));
    }, attemptBudget);
    try {
      if (parentSignal?.aborted) throw parentSignal.reason || new Error('rerank cancelled by upstream deadline');
      const targetTexts = target.role === 'primary' && PROJECT_TO_CHARS > 0
        ? projectableTexts
        : boundedTexts;
      let scored;
      try {
        scored = await callTarget(query, targetTexts, ctrl.signal, target);
      } catch (error) {
        if (timedOut || parentSignal?.aborted) {
          const deadlineError = new Error(timedOut
            ? `rerank timeout after ${attemptBudget}ms`
            : 'rerank cancelled by upstream deadline');
          deadlineError.code = timedOut ? 'RERANK_TIMEOUT' : 'RERANK_CANCELLED';
          throw deadlineError;
        }
        throw error;
      }
      if (!scored.length) throw new Error('empty rerank result');
      const byIdx = new Map(scored.map((s) => [s.index, s.score]));
      const reordered = pool
        .map((c, i) => ({ c, s: byIdx.has(i) ? byIdx.get(i) : -Infinity }))
        .sort((a, b) => b.s - a.s)
        .map((x) => ({ ...x.c, rerank_score: Number.isFinite(x.s) ? Number(x.s.toFixed(4)) : null }));
      return [...reordered, ...tail];
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  };

  // Try each model in the chain; each gets its own transient retries. A fallback actually
  // serving the request is logged, so a silently-degraded primary cannot hide behind a
  // working chain — "it worked" and "it worked on the third choice" are different facts.
  let lastErr = null;
  const attemptedModels = [];
  for (let mi = 0; mi < TARGET_CHAIN.length; mi += 1) {
    const target = TARGET_CHAIN[mi];
    const model = target.model;
    let failed = false;
    for (let a = 0; a <= RETRIES; a++) {
      const attemptsLeft = Math.max(1, MAX_ATTEMPTS_TOTAL - totalAttempts);
      const remainingRunMs = Math.max(0, runDeadlineAt - Date.now());
      // A provider fallback is useful only when it receives enough budget to
      // complete. Split the remaining shared budget across the remaining
      // attempts, bounded by the configured reserve. This keeps a failed
      // primary from starving the next provider while preserving one strict
      // end-to-end deadline for the entire rerank operation.
      const fallbackReserve = attemptsLeft > 1
        ? Math.min(FALLBACK_RESERVE, Math.floor(remainingRunMs / attemptsLeft))
        : 0;
      const fairShare = attemptsLeft > 1
        ? Math.max(1, remainingRunMs - fallbackReserve)
        : remainingRunMs;
      const attemptBudget = Math.max(0, Math.min(
        TIMEOUT,
        fairShare,
        remainingStageMs(TIMEOUT),
      ));
      if (attemptBudget <= 0 || totalAttempts >= MAX_ATTEMPTS_TOTAL) {
        failed = true;
        break;
      }
      totalAttempts += 1;
      if (!attemptedModels.includes(model)) attemptedModels.push(model);
      try {
        const out = await attempt(target, attemptBudget);
        if (mi > 0) {
          console.warn(`[reranker] primary ${MODEL_CHAIN[0]} unavailable — request served by `
            + `fallback #${mi} ${model}. Investigate the primary; the chain is a safety net, not a plan.`);
        }
        return finish(out, { status: 'served', model, route: target.role, fallback_index: mi });
      } catch (err) {
        lastErr = err;
        if (err?.code === 'RERANK_TIMEOUT' || err?.code === 'RERANK_CANCELLED') {
          return finish(candidates, { status: 'cancelled', model, error: err.message });
        }
        if (currentStageSignal()?.aborted || remainingStageMs(1) <= 0) {
          return finish(candidates, { status: 'cancelled', model });
        }
        // When a distinct fallback model exists, spend the second bounded
        // attempt on provider diversity instead of retrying the same failing
        // route. A single-model deployment may still use its configured retry.
        if (TARGET_CHAIN.length === 1 && a < RETRIES && RETRYABLE.test(String(err?.message || ''))) continue;
        failed = true;
        break;
      }
    }
    if (failed && mi < TARGET_CHAIN.length - 1
        && totalAttempts < MAX_ATTEMPTS_TOTAL
        && Math.max(0, runDeadlineAt - Date.now()) > 0
        && remainingStageMs(1) > 0) {
      // Attempt detail is retained in rerank_meta. Emit only the final
      // degraded outcome so one request produces one actionable warning.
    }
  }
  // Graceful degrade — keep algorithmic order (correctness preserved by the
  // upstream tiered reranker + stable tie-break; we just lose the cross-encoder).
  console.warn(`[reranker] DEGRADED to algorithmic order — attempted ${attemptedModels.length}/${TARGET_CHAIN.length} target(s) `
    + `(${attemptedModels.join(' -> ') || 'none'}); last error: ${lastErr?.message}. The cross-encoder is `
    + `absent for this request, so lanes are interleaved rather than compared.`);
  return finish(candidates, { status: 'degraded', model: null, error: lastErr?.message || 'budget exhausted' });
}

export default rerank;
