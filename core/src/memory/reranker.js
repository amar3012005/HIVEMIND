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
const TIMEOUT   = Number(process.env.RERANK_TIMEOUT_MS || 1500);

export function isRerankEnabled() {
  return ENABLED && !!URL;
}

function textOf(c) {
  return [c.title, typeof c.content === 'string' ? c.content : '']
    .filter(Boolean).join('\n').slice(0, 2000);
}

async function callTei(query, texts, signal) {
  // HuggingFace TEI reranker: { query, texts } → [{ index, score }]
  const r = await fetch(`${URL}/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify({ query, texts, model: MODEL }),
    signal,
  });
  if (!r.ok) throw new Error(`TEI rerank ${r.status}`);
  const j = await r.json();
  return (Array.isArray(j) ? j : j.results || []).map((x) => ({ index: x.index, score: x.score ?? x.relevance_score }));
}

async function callCohere(query, texts, signal) {
  // Cohere Rerank: { model, query, documents } → { results:[{ index, relevance_score }] }
  const r = await fetch(`${URL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, query, documents: texts, top_n: texts.length }),
    signal,
  });
  if (!r.ok) throw new Error(`Cohere rerank ${r.status}`);
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const texts = pool.map(textOf);
    const scored = PROVIDER === 'cohere'
      ? await callCohere(query, texts, ctrl.signal)
      : await callTei(query, texts, ctrl.signal);
    if (!scored.length) throw new Error('empty rerank result');
    const byIdx = new Map(scored.map((s) => [s.index, s.score]));
    const reordered = pool
      .map((c, i) => ({ c, s: byIdx.has(i) ? byIdx.get(i) : -Infinity }))
      .sort((a, b) => b.s - a.s)
      .map((x) => ({ ...x.c, rerank_score: Number.isFinite(x.s) ? Number(x.s.toFixed(4)) : null }));
    const out = [...reordered, ...tail];
    return topN ? out.slice(0, topN) : out;
  } catch (err) {
    // Graceful degrade — keep algorithmic order.
    console.warn('[reranker] degraded to algorithmic order:', err.message);
    return topN ? candidates.slice(0, topN) : candidates;
  } finally {
    clearTimeout(timer);
  }
}

export default rerank;
