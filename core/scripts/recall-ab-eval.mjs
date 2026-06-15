#!/usr/bin/env node
/**
 * Recall entity-lane A/B eval.
 *
 * Measures recall@k + MRR over a labeled query set for each ENTITY_FILTER_MODE
 * variant (off | should | must) by hitting /api/recall directly with the
 * per-call `entity_filter_mode` override (no restart needed). Gate the flag
 * flip on EVIDENCE: only default the entity lane ON if `should` beats `off`
 * on recall without regressing the control queries.
 *
 *   docker exec hm-core node /app/scripts/recall-ab-eval.mjs
 *
 * Env: HIVEMIND_MASTER_API_KEY, EVAL_ORG_ID, EVAL_USER_ID (defaults = the
 * test org that holds the Amar/Ceyda/Uwe corpus).
 */

const URL = process.env.HIVEMIND_AGENT_URL || 'http://localhost:3000';
const MASTER_KEY = process.env.HIVEMIND_MASTER_API_KEY;
const ORG_ID = process.env.EVAL_ORG_ID || 'f5e2418b-61ef-4271-83a4-5623050b8402';
const USER_ID = process.env.EVAL_USER_ID || '3b12845a-8cef-4174-ad89-16010810e90b';
const K = Number(process.env.EVAL_K || 8);
const MODES = ['off', 'should', 'must'];

if (!MASTER_KEY) { console.error('HIVEMIND_MASTER_API_KEY required'); process.exit(2); }

// ── Labeled set ──────────────────────────────────────────────────────────
// `require`: ALL regexes must match the SAME memory's (title+content).
// `entity`: true = entity-centric query (where the lane should help).
// `entity:false` = control (must NOT regress).
const CASES = [
  { q: 'tell me about Amar',                require: [/amar/i, /\bCEO\b|\bCTO\b|chief (executive|technology)/i], entity: true },
  { q: 'who is Amar Sai Gadde',             require: [/amar/i, /\bCEO\b|\bCTO\b|founder/i],                       entity: true },
  { q: 'who is Ceyda',                      require: [/ceyda/i, /co.?founder|coo|chief operating/i],              entity: true },
  { q: 'what about Uwe Berger',             require: [/uwe/i, /deploy|loi|letter of intent|b&b|bundb/i],          entity: true },
  { q: 'tell me about Doris Petersen',      require: [/doris/i],                                                  entity: true },
  // Controls — non-entity / topic queries. Lane must not regress these.
  { q: 'Singapore registration pathway',    require: [/singapore/i],                                              entity: false },
  { q: 'investor pipeline and fundraising', require: [/investor|fundrais|funding/i],                              entity: false },
];

async function recall(q, mode) {
  const res = await fetch(`${URL}/api/recall`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MASTER_KEY}`, 'Content-Type': 'application/json', 'X-HM-User-Id': USER_ID, 'X-HM-Org-Id': ORG_ID },
    body: JSON.stringify({ query_context: q, max_memories: K, entity_filter_mode: mode }),
  });
  if (!res.ok) return { memories: [], ms: 0, err: `HTTP ${res.status}` };
  const j = await res.json();
  return { memories: Array.isArray(j.memories) ? j.memories : [], ms: j.trace?.total_ms || null };
}

// rank (1-based) of first memory matching ALL require regexes; 0 = miss.
function firstHitRank(memories, require) {
  for (let i = 0; i < memories.length; i++) {
    const text = `${memories[i].title || ''} ${memories[i].content || ''}`;
    if (require.every((re) => re.test(text))) return i + 1;
  }
  return 0;
}

(async () => {
  const agg = {}; for (const m of MODES) agg[m] = { hit5: 0, hit8: 0, rr: 0, n: 0, ms: [], cHit: 0, cN: 0 };

  for (const c of CASES) {
    const line = [c.q.slice(0, 34).padEnd(34), c.entity ? 'E' : 'c'];
    for (const mode of MODES) {
      const { memories, ms } = await recall(c.q, mode);
      const rank = firstHitRank(memories, c.require);
      const a = agg[mode];
      a.n += 1; if (ms) a.ms.push(ms);
      if (rank > 0 && rank <= 5) a.hit5 += 1;
      if (rank > 0 && rank <= 8) a.hit8 += 1;
      a.rr += rank > 0 ? 1 / rank : 0;
      if (!c.entity) { a.cN += 1; if (rank > 0) a.cHit += 1; }
      line.push(`${mode}:${rank || '—'}`);
    }
    console.log(line.join('  '));
  }

  console.log('\n— Aggregate (rank shown per mode above; — = miss in top-' + K + ') —');
  console.log('mode    recall@5  recall@8  MRR    control-recall  p50ms');
  for (const m of MODES) {
    const a = agg[m];
    const p50 = a.ms.length ? a.ms.sort((x, y) => x - y)[Math.floor(a.ms.length / 2)] : '—';
    console.log(
      `${m.padEnd(7)} ${(a.hit5 / a.n).toFixed(2).padStart(7)}  ${(a.hit8 / a.n).toFixed(2).padStart(7)}  ${(a.rr / a.n).toFixed(2)}   ${a.cN ? (a.cHit / a.cN).toFixed(2) : 'n/a'}            ${p50}`,
    );
  }
  console.log('\nGate: default ENTITY_FILTER_MODE=should ONLY if should.recall ≥ off.recall AND control-recall not lower.');
})().catch((e) => { console.error(e); process.exit(2); });
