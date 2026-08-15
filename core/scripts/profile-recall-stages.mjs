#!/usr/bin/env node

/**
 * Profile production /api/recall without enabling global debug logging.
 *
 * Required env: HIVEMIND_API_KEY, HIVEMIND_USER_ID, HIVEMIND_ORG_ID
 * Optional: HIVEMIND_API_URL, RECALL_QUERY, RECALL_RUNS, RECALL_MODE, RECALL_LIMIT
 */

const env = process.env;
const apiUrl = (env.HIVEMIND_API_URL || 'https://core.singulancelabs.com').replace(/\/$/, '');
const apiKey = env.HIVEMIND_API_KEY;
const userId = env.HIVEMIND_USER_ID;
const orgId = env.HIVEMIND_ORG_ID;
const query = env.RECALL_QUERY || process.argv.slice(2).join(' ') || 'what do you know about Solvis?';
const runs = Math.max(1, Math.min(25, Number(env.RECALL_RUNS || 5)));
const mode = env.RECALL_MODE || 'quick';
const limit = Math.max(1, Math.min(50, Number(env.RECALL_LIMIT || 15)));

if (!apiKey || !userId || !orgId) {
  console.error('Missing HIVEMIND_API_KEY, HIVEMIND_USER_ID, or HIVEMIND_ORG_ID.');
  process.exit(2);
}

const get = (value, path, fallback = 0) => {
  let current = value;
  for (const key of path.split('.')) current = current?.[key];
  return Number.isFinite(Number(current)) ? Number(current) : fallback;
};

const rows = [];
for (let run = 1; run <= runs; run += 1) {
  const startedAt = performance.now();
  const response = await fetch(`${apiUrl}/api/recall`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-hm-user-id': userId,
      'x-hm-org-id': orgId,
    },
    body: JSON.stringify({ query, mode, limit, debug_timing: true }),
  });
  const body = await response.json().catch(() => ({}));
  const wallMs = Math.round(performance.now() - startedAt);
  if (!response.ok) throw new Error(`run ${run}: HTTP ${response.status} ${body.error || body.message || 'unknown error'}`);
  const stages = body.stage_breakdown;
  if (!stages) throw new Error('Server did not return stage_breakdown; deploy request-scoped profiler first.');
  const memory = stages.memory_detail?.pipeline || {};
  rows.push({
    run,
    entity_ms: get(stages, 'entity_resolution_ms'),
    embedding_ms: get(stages, 'memory_detail.embedding_ms'),
    vector_ms: get(stages, 'memory_detail.vector_search_ms'),
    hydrate_ms: get(stages, 'memory_detail.vector_hydrate_ms'),
    lexical_ms: get(stages, 'memory_detail.lexical_ms'),
    memory_total_ms: get(memory, 'total_ms'),
    evidence_ms: get(stages, 'evidence_lane_ms'),
    evidence_wait_ms: get(stages, 'evidence_wait_ms'),
    rerank_ms: get(stages, 'unified_rerank_ms'),
    router_ms: get(stages, 'router_total_ms'),
    route_ms: get(body, 'timing_ms'),
    wall_ms: wallMs,
    results: Array.isArray(body.results) ? body.results.length : 0,
  });
}

console.log(`Recall profile: ${JSON.stringify(query)} mode=${mode} limit=${limit} runs=${runs}`);
console.table(rows);

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};
const numericKeys = Object.keys(rows[0]).filter((key) => key.endsWith('_ms'));
const summary = numericKeys.map((stage) => {
  const values = rows.map((row) => row[stage]);
  return {
    stage,
    min: Math.min(...values),
    avg: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
});
console.table(summary);
