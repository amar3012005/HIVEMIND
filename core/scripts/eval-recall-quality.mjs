#!/usr/bin/env node
// Compare captured, authenticated off/on recall results before Flagship promotion.
// Input JSONL: {query,expected_ids,authorized_ids,baseline_ids,candidate_ids,
//               baseline_latency_ms,candidate_latency_ms}.
import { readFileSync } from 'node:fs';

function rankMetrics(ids, expected) {
  const wanted = new Set(expected);
  const first = ids.findIndex((id) => wanted.has(id));
  return {
    recall5: [...wanted].filter((id) => ids.slice(0, 5).includes(id)).length / wanted.size,
    recall10: [...wanted].filter((id) => ids.slice(0, 10).includes(id)).length / wanted.size,
    mrr: first < 0 ? 0 : 1 / (first + 1),
  };
}

function p95(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

export function evaluateRecallQuality(rows) {
  if (!rows.length) throw new Error('No evaluation cases supplied');
  const baseline = { recall5: 0, recall10: 0, mrr: 0 };
  const candidate = { recall5: 0, recall10: 0, mrr: 0 };
  const oldLatency = [];
  const newLatency = [];
  let unauthorized = 0;
  for (const row of rows) {
    if (!row.query || !row.expected_ids?.length || !Array.isArray(row.baseline_ids)
        || !Array.isArray(row.candidate_ids) || !Array.isArray(row.authorized_ids)) {
      throw new Error('Every case needs a query, expected IDs, authorized IDs, and both result lists');
    }
    const allowed = new Set(row.authorized_ids);
    unauthorized += row.candidate_ids.filter((id) => !allowed.has(id)).length;
    for (const [key, ids, sum] of [['baseline', row.baseline_ids, baseline], ['candidate', row.candidate_ids, candidate]]) {
      const metrics = rankMetrics(ids, row.expected_ids);
      for (const metric of Object.keys(metrics)) sum[metric] += metrics[metric] / rows.length;
    }
    if (Number.isFinite(row.baseline_latency_ms) && Number.isFinite(row.candidate_latency_ms)) {
      oldLatency.push(row.baseline_latency_ms);
      newLatency.push(row.candidate_latency_ms);
    }
  }
  const latency = oldLatency.length === rows.length
    ? { baseline_p95_ms: p95(oldLatency), candidate_p95_ms: p95(newLatency) }
    : null;
  const passed = unauthorized === 0
    && candidate.recall5 >= baseline.recall5
    && candidate.recall10 >= baseline.recall10
    && candidate.mrr + 0.02 >= baseline.mrr
    && (!latency || latency.candidate_p95_ms <= latency.baseline_p95_ms * 1.2);
  return { passed, cases: rows.length, unauthorized, baseline, candidate, latency };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node eval-recall-quality.mjs <captured-results.jsonl>'); process.exit(2); }
  const rows = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const result = evaluateRecallQuality(rows);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
