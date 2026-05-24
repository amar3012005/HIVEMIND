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

// ── Enrichment roundtrip (production-fix regression gate) ──────────────
// Saves a fresh memory, waits ≤30s for the EnrichmentQueue worker to
// populate source_metadata.metadata.enrichment, then asserts the
// structured fields are present. Catches regressions in the
// gpt-oss-20b enrichment path + queue wiring + idempotency lock.
async function runEnrichmentRoundtrip() {
  const t0 = Date.now();
  const headers = {
    Authorization: `Bearer ${MASTER_KEY}`,
    'Content-Type': 'application/json',
    'X-HM-User-Id': USER_ID,
    'X-HM-Org-Id': ORG_ID,
  };
  const stamp = new Date().toISOString();
  const content = `[eval-harness] Internal review for project Atlas. Owner: amar. Action items: ship the new pricing review by Friday and schedule a sync with Lennart for next Tuesday at 14:00. Open question: do we need a legal pass before launch? Generated ${stamp}.`;
  let memoryId = null;
  try {
    const saveRes = await fetch(`${URL}/api/memories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content,
        title: 'eval-harness enrichment roundtrip',
        memory_type: 'note',
        tags: ['eval-harness', 'enrichment-roundtrip'],
      }),
    });
    if (!saveRes.ok) {
      return { ok: false, failures: [`save HTTP ${saveRes.status}: ${(await saveRes.text()).slice(0, 200)}`], dur: Date.now() - t0 };
    }
    const saved = await saveRes.json();
    memoryId = saved.id || saved.memoryId || saved.memory_id;
    if (!memoryId) return { ok: false, failures: [`save response missing id: ${JSON.stringify(saved).slice(0, 200)}`], dur: Date.now() - t0 };

    // Poll up to 30s. Queue worker concurrency=2 + Groq 20B ~2-4s; 30s
    // is generous even under load.
    const deadline = Date.now() + 30000;
    let enrichment = null;
    let lastStatus = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await fetch(`${URL}/api/memories/${memoryId}`, { headers });
      if (!r.ok) continue;
      const m = await r.json();
      const sm = m.source_metadata?.metadata || m.metadata || {};
      lastStatus = sm.enrichment_status || null;
      if (sm.enrichment && typeof sm.enrichment === 'object') {
        enrichment = sm.enrichment;
        break;
      }
    }

    const dur = Date.now() - t0;
    if (!enrichment) {
      return { ok: false, failures: [`no enrichment after 30s (last status=${lastStatus || '-'})`], dur };
    }
    const failures = [];
    if (typeof enrichment.summary !== 'string' || enrichment.summary.length < 20) {
      failures.push(`summary missing/too short: ${String(enrichment.summary).slice(0, 60)}`);
    }
    if (!enrichment.urgency || !['low', 'medium', 'high', 'critical'].includes(enrichment.urgency)) {
      failures.push(`urgency invalid: ${enrichment.urgency}`);
    }
    return { ok: failures.length === 0, failures, dur, tools: [], conf: null, drafts: 0 };
  } catch (err) {
    return { ok: false, failures: [`exception: ${err.message}`], dur: Date.now() - t0 };
  } finally {
    // Cleanup test memory so the user's view stays clean.
    if (memoryId) {
      try { await fetch(`${URL}/api/memories/${memoryId}`, { method: 'DELETE', headers }); } catch {}
    }
  }
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
  // Enrichment roundtrip — runs after chat cases since it issues a
  // direct save + poll loop rather than going through /api/chat.
  const enrR = await runEnrichmentRoundtrip();
  results.push({ name: 'enrichment-roundtrip', ...enrR });
  console.log(`[${enrR.ok ? 'PASS' : 'FAIL'}] enrichment-roundtrip — ${enrR.ok ? `${enrR.dur}ms` : enrR.failures.join(' | ')}`);

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
