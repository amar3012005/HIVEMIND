#!/usr/bin/env node

/**
 * End-to-end SSE profiler for the same /api/chat contract used by TalkToHive.
 * It measures client-visible milestones and reports the server trace alongside
 * lightweight grounding/response checks. It never prints credentials.
 *
 * Required env: HIVEMIND_API_KEY, HIVEMIND_USER_ID, HIVEMIND_ORG_ID
 * Optional: HIVEMIND_API_URL, CHAT_PROFILE_CASES_JSON, CHAT_PROFILE_REPEAT
 */

const env = process.env;
const apiUrl = (env.HIVEMIND_API_URL || 'https://core.singulancelabs.com').replace(/\/$/, '');
const apiKey = env.HIVEMIND_API_KEY;
const userId = env.HIVEMIND_USER_ID;
const orgId = env.HIVEMIND_ORG_ID;
const repeat = Math.max(1, Math.min(5, Number(env.CHAT_PROFILE_REPEAT || 1)));

if (!apiKey || !userId || !orgId) {
  console.error('Missing HIVEMIND_API_KEY, HIVEMIND_USER_ID, or HIVEMIND_ORG_ID.');
  process.exit(2);
}

const defaultCases = [
  { name: 'broad', message: 'What do you know about Solvis?', use_tools: false },
  { name: 'specific', message: 'What products does Solvis offer?', use_tools: false },
  { name: 'detailed', message: 'Give me a detailed overview of Solvis.', use_tools: false },
  { name: 'source', message: 'What does the latest Solvis pitch deck say?', use_tools: false },
  { name: 'temporal', message: 'What changed at Solvis recently?', use_tools: false },
  { name: 'multilingual', message: 'Was weißt du über Solvis und seine Produkte?', use_tools: false, language: 'de' },
  { name: 'tools_additive', message: 'Using what HIVE-MIND knows, summarize Solvis.', use_tools: true },
];

let cases = defaultCases;
if (env.CHAT_PROFILE_CASES_JSON) {
  const parsed = JSON.parse(env.CHAT_PROFILE_CASES_JSON);
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('CHAT_PROFILE_CASES_JSON must be a non-empty array');
  cases = parsed;
}

const elapsed = (start) => Math.round(performance.now() - start);
const firstAt = (events, type) => events.find((event) => event.type === type)?._at_ms ?? null;
const textOf = (done, events) => String(done?.response || events.findLast?.((event) => event.type === 'finish')?.text || '');

async function runCase(testCase, iteration) {
  const start = performance.now();
  const response = await fetch(`${apiUrl}/api/chat`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-hm-user-id': userId,
      'x-hm-org-id': orgId,
    },
    body: JSON.stringify({
      message: testCase.message,
      stream: true,
      use_tools: testCase.use_tools === true,
      ...(testCase.language ? { language: testCase.language } : {}),
      ...(testCase.recall_mode ? { recall_mode: testCase.recall_mode } : {}),
      ...(testCase.project_id ? { project_id: testCase.project_id } : {}),
    }),
  });
  if (!response.ok) throw new Error(`${testCase.name}: HTTP ${response.status} ${await response.text()}`);

  const events = [];
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try { events.push({ ...JSON.parse(line.slice(5).trim()), _at_ms: elapsed(start) }); } catch {}
      }
    }
  }
  const done = [...events].reverse().find((event) => event.type === 'done');
  const error = [...events].reverse().find((event) => event.type === 'error');
  if (error) throw new Error(`${testCase.name}: ${error.error || 'stream error'}`);
  if (!done) throw new Error(`${testCase.name}: stream ended without done event`);
  const trace = done.trace || {};
  const answer = textOf(done, events);
  const citations = Array.isArray(done.citations) ? done.citations.length : 0;
  return {
    case: testCase.name,
    run: iteration,
    tools: testCase.use_tools === true,
    accepted_ms: firstAt(events, 'turn_accepted'),
    intent_ms: firstAt(events, 'intent_decided'),
    recall_ms: firstAt(events, 'recall_window_revealed'),
    first_token_ms: firstAt(events, 'answer_delta'),
    completed_ms: elapsed(start),
    planner_ms: Number(trace.phases?.intent_parse_ms || 0),
    optimizer_ms: Number(trace.phases?.query_optimizer_ms || 0),
    retrieval_ms: Number(trace.phases?.gather_evidence_ms || 0),
    synthesis_ms: Number(trace.phases?.answer_step_ms || 0),
    rerank_ms: Number(trace.recall?.rerank_ms || 0),
    retrieval_passes: Number(trace.recall?.retrieval_passes || 0),
    rerank_passes: Number(trace.recall?.rerank_passes || 0),
    synthesis_passes: Number(trace.recall?.synthesis_passes || 0),
    window: Number(trace.recall?.progressive?.delivered_until || 0),
    grounded: done.grounded === true,
    citations,
    answer_chars: answer.length,
    model: trace.models?.synthesis || null,
    operation: trace.intent?.operation || done.answer_mode || null,
    warnings: Array.isArray(trace.warnings) ? trace.warnings.join('|') : '',
    answer_preview: answer.replace(/\s+/g, ' ').slice(0, 180),
  };
}

const results = [];
for (const testCase of cases) {
  for (let iteration = 1; iteration <= repeat; iteration += 1) {
    const result = await runCase(testCase, iteration);
    results.push(result);
    console.log(`[${result.case}] total=${result.completed_ms}ms first_token=${result.first_token_ms}ms grounded=${result.grounded} citations=${result.citations}`);
  }
}

console.table(results.map(({ answer_preview, warnings, ...row }) => row));
console.log('\nAnswer previews and warnings:');
for (const result of results) {
  console.log(`\n${result.case}: ${result.answer_preview}`);
  if (result.warnings) console.log(`  warnings: ${result.warnings}`);
}

const failures = results.filter((result) => (
  !result.answer_chars
  || result.retrieval_passes > 1
  || result.rerank_passes > 1
  || (result.operation === 'recall' && !result.grounded)
));
if (failures.length) {
  console.error(`\n${failures.length} case(s) failed the profiler acceptance checks.`);
  process.exitCode = 1;
}
