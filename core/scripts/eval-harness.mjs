#!/usr/bin/env node
/**
 * HIVEMIND agent eval harness.
 *
 * Runs a fixed golden corpus through /api/chat and asserts:
 *   - response contains required substring(s)
 *   - response does NOT contain banned substring(s) (no hallucinated
 *     "I don't have" when memories exist)
 *   - expected tool was fired
 *   - confidence ≥ threshold
 *
 * Designed to be run via:
 *   docker exec hm-core node /app/scripts/eval-harness.mjs
 * or locally with HIVEMIND_AGENT_URL=http://localhost:3000
 *
 * Exit code 0 = all pass. Non-zero = at least one fail.
 */

const URL = process.env.HIVEMIND_AGENT_URL || 'http://localhost:3000';
const MASTER_KEY = process.env.HIVEMIND_MASTER_API_KEY;
const USER_ID = process.env.EVAL_USER_ID || '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';
const ORG_ID = process.env.EVAL_ORG_ID || '67503d34-97e9-49a8-8c52-8ee30cc7603e';

if (!MASTER_KEY) {
  console.error('HIVEMIND_MASTER_API_KEY env var required');
  process.exit(2);
}

// ── Golden corpus ───────────────────────────────────────────────────────
// Edit cautiously; each row is a contract.

const CASES = [
  {
    name: 'quick-gate:greeting',
    q: 'hi there',
    expect: { contains: ['hello'], no_tools: true, max_ms: 1500 },
  },
  {
    name: 'quick-gate:math',
    q: 'what is 12 times 17',
    expect: { contains: ['204'], no_tools: true, max_ms: 1500 },
  },
  {
    name: 'quick-gate:definition-generic',
    q: 'what is HIVEMIND',
    expect: { min_confidence: 0.6, max_ms: 3000 },
  },
  {
    name: 'recall:entity-davinci',
    q: 'tell me about Davinci AI',
    expect: { contains_any: ['Davinci AI', 'DaVinci', 'AI platform', 'AI system'], tools_include: ['hivemind_recall'], min_confidence: 0.7 },
  },
  {
    name: 'recall:slack-latest',
    q: 'what was the latest slack activity',
    expect: { tools_include: ['hivemind_recall'], min_confidence: 0.5 },
  },
  {
    name: 'time-travel:slack-on-date',
    q: 'what slack msgs happened on May 12',
    expect: { tools_include: ['hivemind_at'], min_confidence: 0.7 },
  },
  {
    name: 'time-travel:as-of',
    q: 'what did we work on as of May 13',
    expect: { tools_include: ['hivemind_at'], min_confidence: 0.6 },
  },
  {
    name: 'write-intent:slack-explicit',
    q: 'send a slack message to #all-davinci-ai saying eval harness running',
    expect: { tools_include: ['slack_send_message', 'reset_equipped_tools'], creates_draft: true, banned: ['has been posted', 'already sent', 'I posted'] },
  },
  {
    name: 'write-intent:draft-keyword',
    q: 'draft a slack message to #all-davinci-ai about pricing review',
    expect: { tools_include: ['reset_equipped_tools'], creates_draft: true },
  },
  {
    name: 'connector:read-slack-channel',
    q: 'read the latest messages in slack channel all-davinci-ai',
    expect: { tools_include: ['slack_read_channel'], min_confidence: 0.7 },
  },
  {
    name: 'connector:notion-search-known',
    q: 'find notion pages about hivemind',
    expect: { min_confidence: 0.5 },
  },
  {
    name: 'event-driven:traverse-on-entity',
    q: 'what do we know about Davinci AI',
    expect: { tools_include: ['hivemind_recall'], min_confidence: 0.7 },
  },
  {
    name: 'multi-turn:pronoun',
    history: [
      { role: 'user', content: 'who is amar' },
      { role: 'assistant', content: 'Amar is the founder of Davinci AI.' },
    ],
    q: 'what was his last slack msg about',
    expect: { tools_include: ['hivemind_recall'], min_confidence: 0.5 },
  },
  {
    name: 'honesty:no-data',
    q: 'what slack messages did we have about quantum computing',
    // Should NOT falsely confirm finding quantum-related msgs.
    expect: {
      banned: ['yes, we have quantum', 'found quantum', 'quantum computing message titled'],
      min_confidence: 0.5,
    },
  },
];

// ── Runner ──────────────────────────────────────────────────────────────

async function runCase(c) {
  const t0 = Date.now();
  const body = { message: c.q, history: c.history || [] };
  const res = await fetch(`${URL}/api/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MASTER_KEY}`,
      'Content-Type': 'application/json',
      'X-HM-User-Id': USER_ID,
      'X-HM-Org-Id': ORG_ID,
    },
    body: JSON.stringify(body),
  });
  const dur = Date.now() - t0;
  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, dur };
  }
  const j = await res.json();
  const resp = String(j.response || '');
  const tools = Array.isArray(j.steps) ? j.steps.map(s => s.tool) : [];
  const conf = typeof j.confidence === 'number' ? j.confidence : null;
  const drafts = Array.isArray(j.draft_ids) ? j.draft_ids.length : 0;
  const trace = j.trace || null;

  const e = c.expect || {};
  const failures = [];

  if (e.contains) {
    for (const s of e.contains) {
      if (!resp.toLowerCase().includes(String(s).toLowerCase())) failures.push(`missing required substring: "${s}"`);
    }
  }
  if (e.contains_any) {
    if (!e.contains_any.some(s => resp.toLowerCase().includes(String(s).toLowerCase()))) {
      failures.push(`none of contains_any matched: ${JSON.stringify(e.contains_any)}`);
    }
  }
  if (e.banned) {
    for (const s of e.banned) {
      if (resp.toLowerCase().includes(String(s).toLowerCase())) failures.push(`banned substring present: "${s}"`);
    }
  }
  if (e.tools_include) {
    for (const t of e.tools_include) {
      if (!tools.includes(t)) failures.push(`tool not fired: ${t} (got ${tools.join(',')||'-'})`);
    }
  }
  if (e.no_tools && tools.length > 0) failures.push(`expected no tools, got ${tools.join(',')}`);
  if (typeof e.min_confidence === 'number' && (conf == null || conf < e.min_confidence)) {
    failures.push(`confidence ${conf} < ${e.min_confidence}`);
  }
  if (e.creates_draft && drafts === 0) failures.push('expected a draft to be created');
  if (typeof e.max_ms === 'number' && dur > e.max_ms) failures.push(`too slow: ${dur}ms > ${e.max_ms}ms`);

  return {
    ok: failures.length === 0,
    failures,
    dur,
    tools,
    conf,
    drafts,
    cost_usd: trace?.cost?.usd ?? null,
    total_ms: trace?.total_ms ?? dur,
  };
}

(async () => {
  const results = [];
  for (const c of CASES) {
    const r = await runCase(c);
    results.push({ name: c.name, ...r });
    const tag = r.ok ? 'PASS' : 'FAIL';
    const tail = r.ok
      ? `${r.tools.length} tools, conf=${r.conf}, ${r.dur}ms${r.cost_usd != null ? `, $${r.cost_usd}` : ''}`
      : r.failures.join(' | ');
    console.log(`[${tag}] ${c.name} — ${tail}`);
  }
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  const totalCost = results.reduce((a, r) => a + (r.cost_usd || 0), 0);
  const p95ms = (() => {
    const sorted = results.map(r => r.dur).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)] || 0;
  })();
  console.log(`\n— Summary —`);
  console.log(`Passed: ${pass}/${results.length}`);
  console.log(`Failed: ${fail}`);
  console.log(`Total cost: $${totalCost.toFixed(6)}`);
  console.log(`P95 latency: ${p95ms}ms`);
  if (fail > 0) {
    console.log('\nFailed cases:');
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  - ${r.name}: ${r.failures.join(' | ')}`);
    }
    process.exit(1);
  }
  process.exit(0);
})().catch(err => { console.error(err); process.exit(2); });
