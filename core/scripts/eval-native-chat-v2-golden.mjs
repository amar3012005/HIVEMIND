import fs from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseNativeTurnV2 } from '../src/agent/v2/orchestrator.js';

const casesPath = fileURLToPath(new URL('../evals/native-chat-v2-golden.json', import.meta.url));
const cases = JSON.parse(await fs.readFile(casesPath, 'utf8'));
const flags = new Set(process.argv.slice(2));
const baseUrl = process.env.HIVEMIND_V2_BASE_URL?.replace(/\/$/, '');
const apiKey = process.env.HIVEMIND_API_KEY || process.env.OPENROUTER_API_KEY || null;

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
  const response = await fetch(`${baseUrl}/v2/chat`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: testCase.input, history: testCase.history || [], use_tools: false }),
  });
  const result = await response.json();
  const failures = [];
  if (!response.ok) failures.push(`http=${response.status}:${result.error || 'unknown'}`);
  if (response.ok && result.trace?.native_v2?.served !== true) failures.push('native_v2_not_served');
  if (response.ok && !String(result.response || '').trim()) failures.push('empty_answer');
  return { failures };
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
  try {
    const outcome = await run(testCase);
    results.push({ id: testCase.id, pass: outcome.failures.length === 0, failures: outcome.failures });
  } catch (error) {
    results.push({ id: testCase.id, pass: false, failures: [error.message] });
  }
  console.log(`${results.at(-1).pass ? 'PASS' : 'FAIL'} ${testCase.id}${results.at(-1).failures.length ? ` ${results.at(-1).failures.join(', ')}` : ''}`);
}
const passed = results.filter((x) => x.pass).length;
console.log(JSON.stringify({ mode: flags.has('--http') ? 'http' : 'planner', passed, total: results.length, pass_rate: passed / results.length }, null, 2));
if (passed !== results.length) process.exitCode = 1;
