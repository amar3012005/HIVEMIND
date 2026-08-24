import fs from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseNativeTurnV2 } from '../src/agent/v2/orchestrator.js';

const casesPath = fileURLToPath(new URL('../evals/native-chat-v2-golden.json', import.meta.url));
const cases = JSON.parse(await fs.readFile(casesPath, 'utf8'));
const flags = new Set(process.argv.slice(2));
const baseUrl = process.env.HIVEMIND_V2_BASE_URL?.replace(/\/$/, '');
const apiKey = process.env.HIVEMIND_API_KEY || process.env.OPENROUTER_API_KEY || null;
const MUTATING_OPERATIONS = new Set(['save', 'update_profile']);

function checkPlan(testCase, plan) {
  const failures = [];
  if (!testCase.operations.includes(plan.operation)) failures.push(`operation=${plan.operation}`);
  if (testCase.response_scope && plan.response?.scope !== testCase.response_scope) failures.push(`response_scope=${plan.response?.scope}`);
  if (Object.hasOwn(testCase, 'memory_scope') && plan.memory?.scope !== testCase.memory_scope) failures.push(`memory_scope=${plan.memory?.scope}`);
  if (testCase.answer_type && plan.response?.type !== testCase.answer_type) failures.push(`answer_type=${plan.response?.type}`);
  if (testCase.entity && !(plan.references?.entities || []).some((x) => x.toLowerCase().includes(testCase.entity.toLowerCase()))) failures.push(`entity=${testCase.entity}`);
  if (testCase.source && plan.references?.source?.title !== testCase.source) failures.push(`source=${plan.references?.source?.title}`);
  if (testCase.source_kind && plan.references?.source?.kind !== testCase.source_kind) failures.push(`source_kind=${plan.references?.source?.kind}`);
  if (testCase.time_semantics && plan.time?.semantics !== testCase.time_semantics) failures.push(`time=${plan.time?.semantics}`);
  if (testCase.time_axis && plan.time?.axis !== testCase.time_axis) failures.push(`axis=${plan.time?.axis}`);
  if (plan.steps?.length !== 1) failures.push(`steps=${plan.steps?.length}`);
  return failures;
}

async function plannerCase(testCase) {
  const result = await parseNativeTurnV2({
    message: testCase.input, history: testCase.history || [], language: null, apiKey,
    profileContext: 'User: Amar Sai Gadde. Organization: SINGULANCE. Role: founder.',
    projectCatalog: [{ id: 'solvis', name: 'Solvis' }, { id: 'orion', name: 'Orion-X' }],
    timezone: 'Europe/Berlin', now: '2026-08-23T12:00:00+02:00',
  });
  return { failures: checkPlan(testCase, result.plan) };
}

async function httpCase(testCase) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v2/chat`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: testCase.input, history: testCase.history || [], use_tools: false }),
  });
  const result = await response.json();
  const latencyMs = Math.round(performance.now() - started);
  const failures = [];
  if (!response.ok) failures.push(`http=${response.status}:${result.error || 'unknown'}`);
  if (response.ok && result.trace?.native_v2?.served !== true) failures.push('native_v2_not_served');
  if (response.ok && !String(result.response || '').trim()) failures.push('empty_answer');
  const compiledOperations = new Set(testCase.operations.map((operation) => ({
    event_range: 'recall', snapshot: 'timeline', diff: 'timeline', timeline: 'timeline',
  })[operation] || operation));
  if (response.ok && !compiledOperations.has(result.trace?.intent?.operation)) failures.push(`operation=${result.trace?.intent?.operation}`);
  const expectedTools = new Set(testCase.operations.flatMap((operation) => ({
    profile: ['get_user_profile'], recall: ['hivemind_recall'], source_read: ['hivemind_recall'], event_range: ['hivemind_recall'],
    snapshot: ['hivemind_at'], diff: ['hivemind_diff'], timeline: ['hivemind_timeline'], relation_between: ['hivemind_relation_between'],
    aggregate: ['hivemind_aggregate_entities'], projects: ['hivemind_list_projects'], direct: [],
  })[operation] || []));
  const tools = (result.steps || []).map((step) => step.tool);
  if (expectedTools.size && !tools.some((tool) => expectedTools.has(tool))) failures.push(`tool=${tools.join('|') || 'none'}`);
  if (result.trace?.intent?.operation === 'direct' && tools.length) failures.push(`direct_tool_count=${tools.length}`);
  const sourceIds = new Set((result.sources || []).map((source) => source.id));
  const citationIds = new Set((result.citations || []).map((citation) => citation.citation_id));
  for (const citation of result.citations || []) if (citation.id && !sourceIds.has(citation.id)) failures.push(`orphan_citation=${citation.citation_id}`);
  for (const claim of result.claims || []) for (const citationId of claim.citation_ids || []) if (!citationIds.has(citationId)) failures.push(`unknown_claim_citation=${citationId}`);
  if ((result.claims || []).length && result.grounded !== true) failures.push('claims_not_grounded');
  return { failures: [...new Set(failures)], latencyMs, operation: result.trace?.intent?.operation, tools, sources: sourceIds.size, claims: (result.claims || []).length };
}

if (flags.has('--validate-only')) {
  const operations = [...new Set(cases.flatMap((x) => x.operations))].sort();
  if (cases.length < 50) throw new Error(`golden set too small: ${cases.length}`);
  console.log(JSON.stringify({ valid: true, cases: cases.length, operations }, null, 2));
  process.exit(0);
}

if (!apiKey) throw new Error('Set HIVEMIND_API_KEY for HTTP mode or OPENROUTER_API_KEY for planner mode.');
if (flags.has('--http') && !baseUrl) throw new Error('Set HIVEMIND_V2_BASE_URL for --http mode.');
const run = flags.has('--http') ? httpCase : plannerCase;
const results = [];
for (const testCase of cases) {
  if (flags.has('--read-only') && testCase.operations.some((operation) => MUTATING_OPERATIONS.has(operation))) {
    results.push({ id: testCase.id, skipped: true, pass: null, failures: ['mutation_not_authorized'] });
    console.log(`SKIP ${testCase.id} mutation_not_authorized`);
    continue;
  }
  try {
    const outcome = await run(testCase);
    results.push({ id: testCase.id, pass: outcome.failures.length === 0, failures: outcome.failures, ...outcome });
  } catch (error) {
    results.push({ id: testCase.id, pass: false, failures: [error.message] });
  }
  console.log(`${results.at(-1).pass ? 'PASS' : 'FAIL'} ${testCase.id}${results.at(-1).failures.length ? ` ${results.at(-1).failures.join(', ')}` : ''}`);
}
const executed = results.filter((x) => !x.skipped);
const passed = executed.filter((x) => x.pass).length;
const latencies = executed.map((x) => x.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
const percentile = (p) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))] : null;
console.log(JSON.stringify({ mode: flags.has('--http') ? 'http' : 'planner', passed, executed: executed.length, skipped: results.length - executed.length, total: results.length, pass_rate: executed.length ? passed / executed.length : 0, latency_ms: { min: latencies[0] ?? null, p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) ?? null } }, null, 2));
if (passed !== executed.length) process.exitCode = 1;
