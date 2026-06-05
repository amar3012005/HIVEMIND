#!/usr/bin/env node
/**
 * P6 minimal memory eval — label-free, deterministic regression check.
 *
 * Self-retrieval Recall@K: sample N random latest memories, query the recall
 * API with each memory's own title (fallback: first content words), and check
 * whether that same memory comes back in the top-K. A healthy engine finds its
 * own memories; a drop in this number is a recall regression. Also reports
 * latency p50/p95 so you can watch the 10M cliff as the corpus grows.
 *
 * No ground-truth labels needed — the probe IS the label. Run before/after any
 * retrieval change (P2 salience, P3 forgetting, P4 hnsw_ef, P5 GIN) to confirm
 * recall did not regress.
 *
 * Usage (inside hm-core):
 *   node /app/scripts/memory-eval.mjs
 * Env:
 *   HM_BASE_URL  (default http://localhost:3000)
 *   HM_API_KEY   (required — master key or user key)
 *   HM_USER_ID   (required)
 *   HM_ORG_ID    (required)
 *   EVAL_N       (default 20)   — number of probe memories
 *   EVAL_K       (default 10)   — top-K window for a hit
 */
import { PrismaClient } from '@prisma/client';

const BASE = process.env.HM_BASE_URL || 'http://localhost:3000';
const KEY = process.env.HM_API_KEY || '';
const USER = process.env.HM_USER_ID || '';
const ORG = process.env.HM_ORG_ID || '';
const N = Number(process.env.EVAL_N || 20);
const K = Number(process.env.EVAL_K || 10);

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Reusable self-retrieval Recall@K eval — the evolution loop's replay gate.
 * Returns { recall_at_k, hits, misses, probes, latency_ms{p50,p95,max} } or
 * { error }. No process.exit — safe to call in-process.
 */
export async function evalOrg({ orgId, userId, apiKey, baseUrl = BASE, n = N, k = K, prisma = null } = {}) {
  if (!orgId || !userId || !apiKey) return { error: 'orgId, userId, apiKey required' };
  const ownPrisma = !prisma;
  const p = prisma || new PrismaClient();
  try {
    const pool = await p.memory.findMany({
      where: { orgId, isLatest: true, deletedAt: null, title: { not: null } },
      select: { id: true, title: true, content: true },
      orderBy: { updatedAt: 'desc' },
      take: Math.max(n * 5, 50),
    });
    if (pool.length === 0) return { error: 'no probe memories', org: orgId, recall_at_k: 0 };
    const step = Math.max(1, Math.floor(pool.length / n));
    const probes = [];
    for (let i = 0; i < pool.length && probes.length < n; i += step) probes.push(pool[i]);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-HM-User-Id': userId,
      'X-HM-Org-Id': orgId,
    };
    let hits = 0;
    const latencies = [];
    for (const probe of probes) {
      const q = (probe.title && probe.title.trim().length >= 4)
        ? probe.title.trim()
        : String(probe.content || '').split(/\s+/).slice(0, 12).join(' ');
      if (!q) continue;
      const t0 = Date.now();
      try {
        const resp = await fetch(`${baseUrl}/api/recall`, {
          method: 'POST', headers, body: JSON.stringify({ query: q, limit: k }),
        });
        latencies.push(Date.now() - t0);
        if (resp.ok) {
          const j = await resp.json();
          const ids = (j.memories || []).slice(0, k).map((m) => m.id);
          if (ids.includes(probe.id)) hits++;
        }
      } catch { latencies.push(Date.now() - t0); }
    }
    const nn = probes.length;
    latencies.sort((a, b) => a - b);
    return {
      org: orgId, probes: nn, top_k: k,
      recall_at_k: nn > 0 ? Math.round((hits / nn) * 1000) / 10 : 0,
      hits, misses: nn - hits,
      latency_ms: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies[latencies.length - 1] || 0 },
    };
  } finally {
    if (ownPrisma) await p.$disconnect();
  }
}

async function main() {
  if (!KEY || !USER || !ORG) {
    console.error('ERROR: HM_API_KEY, HM_USER_ID, HM_ORG_ID are required');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    // Random-ish sample of latest, non-deleted memories with a usable title.
    const pool = await prisma.memory.findMany({
      where: { orgId: ORG, isLatest: true, deletedAt: null, title: { not: null } },
      select: { id: true, title: true, content: true },
      orderBy: { updatedAt: 'desc' },
      take: Math.max(N * 5, 50),
    });
    if (pool.length === 0) {
      console.log(JSON.stringify({ error: 'no probe memories found', org: ORG }, null, 2));
      return;
    }
    // Spread the sample across the pool instead of taking the newest N.
    const step = Math.max(1, Math.floor(pool.length / N));
    const probes = [];
    for (let i = 0; i < pool.length && probes.length < N; i += step) probes.push(pool[i]);

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
      'X-HM-User-Id': USER,
      'X-HM-Org-Id': ORG,
    };

    let hits = 0;
    const latencies = [];
    const misses = [];
    for (const probe of probes) {
      const q = (probe.title && probe.title.trim().length >= 4)
        ? probe.title.trim()
        : String(probe.content || '').split(/\s+/).slice(0, 12).join(' ');
      if (!q) continue;
      const t0 = Date.now();
      let found = false;
      try {
        const resp = await fetch(`${BASE}/api/recall`, {
          method: 'POST', headers, body: JSON.stringify({ query: q, limit: K }),
        });
        const ms = Date.now() - t0;
        latencies.push(ms);
        if (resp.ok) {
          const j = await resp.json();
          const ids = (j.memories || []).slice(0, K).map((m) => m.id);
          found = ids.includes(probe.id);
        }
      } catch (e) {
        latencies.push(Date.now() - t0);
      }
      if (found) hits++; else misses.push({ id: probe.id, q: q.slice(0, 50) });
    }

    const n = probes.length;
    latencies.sort((a, b) => a - b);
    const report = {
      org: ORG,
      probes: n,
      top_k: K,
      recall_at_k: n > 0 ? Math.round((hits / n) * 1000) / 10 : 0, // %
      hits,
      misses: misses.length,
      latency_ms: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        max: latencies[latencies.length - 1] || 0,
      },
      sample_misses: misses.slice(0, 5),
      generated_at: new Date().toISOString(),
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

// CLI guard: only run main() when invoked directly, NOT when imported for evalOrg().
const _invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (_invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
