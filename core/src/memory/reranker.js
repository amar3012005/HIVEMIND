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
 *   RERANK_URL=<endpoint>            # TEI: .../rerank
 *   RERANK_MODEL=bge-reranker-v2-m3  # cohere: rerank-english-v3.0
 *   RERANK_API_KEY=<key>             # cohere
 *   RERANK_POOL=100                  # candidates to rerank (cap 200 — pointwise
 *                                    #   rerankers DEGRADE past ~500, arXiv 2411.11767)
 *   RERANK_TIMEOUT_MS=1500
 *
 * Never throws: any error/timeout → original order (graceful degrade).
 *
 * @module memory/reranker
 */

import fetch from 'node-fetch';
import { currentStageSignal, remainingStageMs } from '../runtime/stage-deadline.js';

const ENABLED   = process.env.RERANK_ENABLED === 'true';
const PROVIDER  = (process.env.RERANK_PROVIDER || 'tei').toLowerCase();
const URL       = (process.env.RERANK_URL || '').replace(/\/+$/, '');
const MODEL     = process.env.RERANK_MODEL || 'bge-reranker-v2-m3';
const API_KEY   = process.env.RERANK_API_KEY || '';
const POOL      = Math.min(Number(process.env.RERANK_POOL || 100), 200); // hard cap 200
// 1500ms was too tight: Cohere-via-OpenRouter is ~300ms normally but spikes to
// 1-2s under burst/queueing, tripping the abort → the cross-encoder pass got
// silently dropped exactly when load was highest. 2500ms covers spikes while
// still bounding the answer path.
const TIMEOUT   = Number(process.env.RERANK_TIMEOUT_MS || 2500);
// One request receives one wall-clock budget across primary, retry and
// fallback providers. Previously each combination received a fresh 2.5s,
// allowing the chain to outlive the recall response by many seconds.
const TOTAL_TIMEOUT = Math.max(100, Number(process.env.RERANK_TOTAL_TIMEOUT_MS || 1200));
const MAX_ATTEMPTS_TOTAL = Math.max(1, Number(process.env.RERANK_MAX_ATTEMPTS_TOTAL || 2));
// One transient retry (abort/timeout/429/5xx) so a single slow attempt doesn't
// drop the rerank — ensures Cohere is actually used, not just when the network
// is calm. Non-transient errors degrade immediately (no load amplification).
const RETRIES   = Number(process.env.RERANK_RETRIES || 1);
const RETRYABLE = /abort|timeout|429|50[0-9]|network|fetch failed|ECONNRESET|ETIMEDOUT/i;

// MODEL FALLBACK CHAIN — losing the cross-encoder is not a small degradation. Without it
// deliverHybrid interleaves lanes instead of comparing them, which is what buries the
// German `E3DC Zähler` row. So a single model being unavailable must not cost us the pass.
//
// Production evaluation on 2026-08-15: Cohere v4-fast and Voyage both scored
// 10/10 on the small-detail multilingual/product corpus; v4-fast averaged
// 204ms vs Voyage 223ms there and 407ms vs 566ms on the 150-document pool.
// The deployment config therefore promotes v4-fast and keeps Voyage as the
// first cross-family fallback. The code-level chain below remains a safety net
// for environments that do not load prod-defaults.conf.
// NOT in the chain: nvidia/llama-nemotron-rerank-vl-1b-v2:free is free but returned HTTP 404
// "No endpoints available matching your guardrail restrictions" on this account — a free
// model that cannot be called is not a fallback.
const MODEL_CHAIN = [...new Set([
  MODEL,
  ...String(process.env.RERANK_FALLBACK_MODELS || 'cohere/rerank-4-fast,voyageai/rerank-2.5-lite,cohere/rerank-v3.5')
    .split(',').map((m) => m.trim()).filter(Boolean),
])];

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

function textOf(c) {
  return [c.title, typeof c.content === 'string' ? c.content : '']
    .filter(Boolean).join('\n').slice(0, 2000);
}

async function callTei(query, texts, signal, model = MODEL) {
  // HuggingFace TEI reranker: { query, texts } → [{ index, score }]
  const r = await fetch(`${URL}/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify({ query, texts, model }),
    signal,
  });
  if (!r.ok) throw new Error(`TEI rerank ${r.status} (${model})`);
  const j = await r.json();
  return (Array.isArray(j) ? j : j.results || []).map((x) => ({ index: x.index, score: x.score ?? x.relevance_score }));
}

async function callCohere(query, texts, signal, model = MODEL) {
  // Cohere Rerank: { model, query, documents } → { results:[{ index, relevance_score }] }
  const r = await fetch(`${URL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model, query, documents: texts, top_n: texts.length }),
    signal,
  });
  if (!r.ok) throw new Error(`Cohere rerank ${r.status} (${model})`);
  const j = await r.json();
  return (j.results || []).map((x) => ({ index: x.index, score: x.relevance_score }));
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
  const texts = pool.map(textOf);
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
  const attempt = async (model, attemptBudget) => {
    const ctrl = new AbortController();
    const parentSignal = currentStageSignal();
    const abortFromParent = () => {
      if (!ctrl.signal.aborted) ctrl.abort(parentSignal?.reason);
    };
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const timer = setTimeout(() => {
      if (!ctrl.signal.aborted) ctrl.abort(new Error(`rerank timeout after ${attemptBudget}ms`));
    }, attemptBudget);
    try {
      if (parentSignal?.aborted) throw parentSignal.reason || new Error('rerank cancelled by upstream deadline');
      const scored = PROVIDER === 'cohere'
        ? await callCohere(query, texts, ctrl.signal, model)
        : await callTei(query, texts, ctrl.signal, model);
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
  for (let mi = 0; mi < MODEL_CHAIN.length; mi += 1) {
    const model = MODEL_CHAIN[mi];
    let failed = false;
    for (let a = 0; a <= RETRIES; a++) {
      const attemptsLeft = Math.max(1, MAX_ATTEMPTS_TOTAL - totalAttempts);
      const fairShare = Math.ceil(Math.max(0, runDeadlineAt - Date.now()) / attemptsLeft);
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
      try {
        const out = await attempt(model, attemptBudget);
        if (mi > 0) {
          console.warn(`[reranker] primary ${MODEL_CHAIN[0]} unavailable — request served by `
            + `fallback #${mi} ${model}. Investigate the primary; the chain is a safety net, not a plan.`);
        }
        return finish(out, { status: 'served', model, fallback_index: mi });
      } catch (err) {
        lastErr = err;
        if (currentStageSignal()?.aborted || remainingStageMs(1) <= 0) {
          console.warn(`[reranker] cancelled by upstream deadline while serving ${model}; `
            + 'stopping the fallback chain immediately.');
          return finish(candidates, { status: 'cancelled', model });
        }
        // When a distinct fallback model exists, spend the second bounded
        // attempt on provider diversity instead of retrying the same failing
        // route. A single-model deployment may still use its configured retry.
        if (MODEL_CHAIN.length === 1 && a < RETRIES && RETRYABLE.test(String(err?.message || ''))) continue;
        failed = true;
        break;
      }
    }
    if (failed && mi < MODEL_CHAIN.length - 1) {
      console.warn(`[reranker] ${model} failed (${lastErr?.message}) — falling back to ${MODEL_CHAIN[mi + 1]}`);
    }
  }
  // Graceful degrade — keep algorithmic order (correctness preserved by the
  // upstream tiered reranker + stable tie-break; we just lose the cross-encoder).
  console.warn(`[reranker] DEGRADED to algorithmic order — all ${MODEL_CHAIN.length} model(s) in the chain `
    + `failed (${MODEL_CHAIN.join(' -> ')}); last error: ${lastErr?.message}. The cross-encoder is `
    + `absent for this request, so lanes are interleaved rather than compared.`);
  return finish(candidates, { status: 'degraded', model: null, error: lastErr?.message || 'budget exhausted' });
}

export default rerank;
