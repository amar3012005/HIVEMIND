#!/usr/bin/env node

import fs from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).map((value) => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.join('=') || true];
}));

if (!args.fixture || !args.baseline || !args.candidate || !args.token) {
  console.error('Usage: node core/scripts/eval-entity-search-quality.mjs --fixture=queries.jsonl --baseline=https://... --candidate=https://... --token=...');
  process.exit(2);
}

const fixtures = (await fs.readFile(args.fixture, 'utf8'))
  .split('\n').map((line) => line.trim()).filter(Boolean).map(JSON.parse);

async function search(baseUrl, fixture) {
  const url = new URL('/api/entity-search', baseUrl);
  url.searchParams.set('query', fixture.query);
  url.searchParams.set('limit', String(fixture.limit || 25));
  if (fixture.scope) url.searchParams.set('scope', fixture.scope);
  if (fixture.project_id) url.searchParams.set('project_id', fixture.project_id);
  for (const type of fixture.entity_types || []) url.searchParams.append('entity_type', type);
  const started = performance.now();
  const response = await fetch(url, { headers: { authorization: `Bearer ${args.token}` } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return { ids: (body.matches || []).map((match) => match.entity_id), latency_ms: performance.now() - started };
}

function score(rows) {
  let reciprocalRank = 0;
  let recallAt1 = 0;
  let recallAt5 = 0;
  let ambiguityPreserved = 0;
  let ambiguityCases = 0;
  let unauthorized = 0;
  for (const row of rows) {
    const expected = new Set(row.expected_entity_ids || []);
    const rank = row.ids.findIndex((id) => expected.has(id));
    if (rank >= 0) reciprocalRank += 1 / (rank + 1);
    if (rank === 0) recallAt1 += 1;
    if (rank >= 0 && rank < 5) recallAt5 += 1;
    const ambiguous = row.ambiguous_entity_ids || [];
    if (ambiguous.length) {
      ambiguityCases += 1;
      if (ambiguous.every((id) => row.ids.includes(id))) ambiguityPreserved += 1;
    }
    const authorized = new Set(row.authorized_entity_ids || []);
    unauthorized += row.ids.filter((id) => !authorized.has(id)).length;
  }
  const count = rows.length || 1;
  const latency = rows.map((row) => row.latency_ms).sort((a, b) => a - b);
  return {
    queries: rows.length,
    recall_at_1: recallAt1 / count,
    recall_at_5: recallAt5 / count,
    mrr: reciprocalRank / count,
    ambiguity_preservation: ambiguityCases ? ambiguityPreserved / ambiguityCases : null,
    unauthorized,
    p95_latency_ms: latency[Math.min(latency.length - 1, Math.floor(latency.length * 0.95))] || 0,
  };
}

const baselineRows = [];
const candidateRows = [];
for (const fixture of fixtures) {
  const [baseline, candidate] = await Promise.all([
    search(args.baseline, fixture),
    search(args.candidate, fixture),
  ]);
  baselineRows.push({ ...fixture, ...baseline });
  candidateRows.push({ ...fixture, ...candidate });
}

const baseline = score(baselineRows);
const candidate = score(candidateRows);
const passed = candidate.unauthorized === 0
  && candidate.recall_at_1 >= baseline.recall_at_1
  && candidate.recall_at_5 >= baseline.recall_at_5
  && candidate.mrr + 0.02 >= baseline.mrr
  && (candidate.ambiguity_preservation === null || candidate.ambiguity_preservation === 1)
  && candidate.p95_latency_ms <= baseline.p95_latency_ms * 1.2;
console.log(JSON.stringify({ passed, baseline, candidate }, null, 2));
if (!passed) process.exitCode = 1;
