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
// One transient retry (abort/timeout/429/5xx) so a single slow attempt doesn't
// drop the rerank — ensures Cohere is actually used, not just when the network
// is calm. Non-transient errors degrade immediately (no load amplification).
const RETRIES   = Number(process.env.RERANK_RETRIES || 1);
const RETRYABLE = /abort|timeout|429|50[0-9]|network|fetch failed|ECONNRESET|ETIMEDOUT/i;

// MODEL FALLBACK CHAIN — losing the cross-encoder is not a small degradation. Without it
// deliverHybrid interleaves lanes instead of comparing them, which is what buries the
// German `E3DC Zähler` row. So a single model being unavailable must not cost us the pass.
//
// Order is cheapest-effective first, measured against the live endpoint 2026-08-03
// (query + 5 docs, all ranked the correct document first):
//   voyageai/rerank-2.5-lite  $0.02/M tok  32K ctx  829ms cold / ~270ms warm  <- primary
//   cohere/rerank-v3.5        $0.001/search 4K ctx  204ms                     <- known-good
//   cohere/rerank-4-fast      $0.002/search 33K ctx 288ms                     <- last resort
// Voyage is BOTH cheaper and better here: at ~30K tokens for a 150-doc pool, 2.5-lite costs
// ~$0.0006/search against v3.5's $0.001, and it benchmarks +7.16% retrieval accuracy over
// v3.5 across 93 datasets. Its 32K context also matters — RERANK_POOL is 150 and v3.5 only
// has 4K, so long pools were being truncated by the model we were paying for.
// NOT in the chain: nvidia/llama-nemotron-rerank-vl-1b-v2:free is free but returned HTTP 404
// "No endpoints available matching your guardrail restrictions" on this account — a free
// model that cannot be called is not a fallback.
const MODEL_CHAIN = [...new Set([
  MODEL,
  ...String(process.env.RERANK_FALLBACK_MODELS || 'cohere/rerank-v3.5,cohere/rerank-4-fast')
    .split(',').map((m) => m.trim()).filter(Boolean),
])];

export function isRerankEnabled() {
  return ENABLED && !!URL;
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

  // One attempt with a fresh timeout. Retryable failures (transient) get one
  // more shot before we degrade; anything else degrades immediately.
  const attempt = async (model) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
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
      try {
        const out = await attempt(model);
        if (mi > 0) {
          console.warn(`[reranker] primary ${MODEL_CHAIN[0]} unavailable — request served by `
            + `fallback #${mi} ${model}. Investigate the primary; the chain is a safety net, not a plan.`);
        }
        return topN ? out.slice(0, topN) : out;
      } catch (err) {
        lastErr = err;
        if (a < RETRIES && RETRYABLE.test(String(err?.message || ''))) continue; // transient → retry
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
  return topN ? candidates.slice(0, topN) : candidates;
}

export default rerank;
