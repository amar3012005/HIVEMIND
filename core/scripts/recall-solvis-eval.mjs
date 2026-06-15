#!/usr/bin/env node
/**
 * Solvis-test corpus recall A/B — fine-grained detail probe.
 *
 * Scopes recall to the Solvis-test project (2110 distilled facts + ~evidence
 * segments) and checks, per ENTITY_FILTER_MODE (off|should|must):
 *   - FACT recall@k    : a distilled memory matches the expected detail
 *   - EVIDENCE recall@k : a ground-truth KnowledgeSegment (HOP2) matches it
 *   - COMBO recall@k    : either layer surfaced the detail
 * So we verify the engine pulls high-level ground truth from evidence, not just
 * the distilled facts — even on the smallest details.
 *
 *   docker exec hm-core node /app/scripts/recall-solvis-eval.mjs
 */
const URL = process.env.HIVEMIND_AGENT_URL || 'http://localhost:3000';
const MK = process.env.HIVEMIND_MASTER_API_KEY;
const ORG = process.env.EVAL_ORG_ID || 'f5e2418b-61ef-4271-83a4-5623050b8402';
const USER = process.env.EVAL_USER_ID || '3b12845a-8cef-4174-ad89-16010810e90b';
const PROJ = process.env.EVAL_PROJECT_ID || '0d8279b3-f7b0-46c6-9415-cebb52f7cc7c';
const K = Number(process.env.EVAL_K || 8);
const MODES = ['off', 'should', 'must'];
if (!MK) { console.error('HIVEMIND_MASTER_API_KEY required'); process.exit(2); }

// Fine-grained details pulled from the actual Solvis corpus. `require`: ALL
// regexes must match the SAME row's text. entity = product-named (lane-relevant).
const CASES = [
  { q: 'SolvisLea Pro what type of heat pump',                require: [/inverter|luft.?\/?\s?wasser/i], entity: true },
  { q: 'how many seconds hold the Kaminkehrer chimney-sweep button in manual mode', require: [/5 sekunden|länger als 5/i], entity: false },
  { q: 'SolvisBen Nennvolumen nominal volume in litres',      require: [/230/], entity: true },
  { q: 'where is the zero-emission factory Nullemissionsfabrik', require: [/braunschweig/i], entity: false },
  { q: 'is the new edition GEG compliant',                    require: [/geg/i], entity: false },
  { q: 'Doppelstufige Verbrennung for low emissions',         require: [/doppelstufig/i], entity: false },
  { q: 'Schlammabscheider protecting the heat pump Ladekreis', require: [/schlammabscheider/i], entity: false },
  { q: 'how much Heizwärme can a Wärmepumpe make from 1 kWh Strom', require: [/4\s?kwh|kwh/i], entity: false },
  { q: 'what were SolvisMax and SolvisBen designed as',       require: [/energy manager|energiemanager/i], entity: true },
  { q: 'Aus der Region für die Region significance',          require: [/region/i], entity: false },
];

async function recall(q, mode) {
  const res = await fetch(`${URL}/api/recall`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MK}`, 'Content-Type': 'application/json', 'X-HM-User-Id': USER, 'X-HM-Org-Id': ORG },
    body: JSON.stringify({ query_context: q, max_memories: K, project_id: PROJ, entity_filter_mode: mode }),
  });
  if (!res.ok) return { memories: [], evidence: [], ms: null };
  const j = await res.json();
  return {
    memories: Array.isArray(j.memories) ? j.memories : [],
    evidence: Array.isArray(j.evidence) ? j.evidence : [],
    ms: j.recall_trace?.total_ms || j.trace?.total_ms || null,
  };
}
const rank = (rows, require, textFn) => {
  for (let i = 0; i < rows.length; i++) { if (require.every((re) => re.test(textFn(rows[i]) || ''))) return i + 1; }
  return 0;
};
const memText = (m) => `${m.title || ''} ${m.content || ''}`;
const evText = (e) => `${e.text || e.content || e.snippet || ''}`;

(async () => {
  const agg = {}; for (const m of MODES) agg[m] = { f: 0, e: 0, c: 0, rr: 0, n: 0, ms: [] };
  console.log(`Solvis-test recall A/B — k=${K}  (F=fact rank, E=evidence rank, — = miss)\n`);
  for (const c of CASES) {
    const row = [c.q.slice(0, 40).padEnd(40), c.entity ? 'E' : 'c'];
    for (const mode of MODES) {
      const { memories, evidence, ms } = await recall(c.q, mode);
      const fr = rank(memories, c.require, memText);
      const er = rank(evidence, c.require, evText);
      const cr = (fr && er) ? Math.min(fr, er) : (fr || er);
      const a = agg[mode]; a.n += 1; if (ms) a.ms.push(ms);
      if (fr && fr <= K) a.f += 1;
      if (er && er <= K) a.e += 1;
      if (cr && cr <= K) { a.c += 1; a.rr += 1 / cr; }
      row.push(`${mode} F:${fr || '—'} E:${er || '—'}`);
    }
    console.log(row.join('  '));
  }
  console.log('\nmode    fact@k  evid@k  combo@k  MRR    p50ms');
  for (const m of MODES) {
    const a = agg[m]; const p50 = a.ms.length ? a.ms.sort((x, y) => x - y)[Math.floor(a.ms.length / 2)] : '—';
    console.log(`${m.padEnd(7)} ${(a.f / a.n).toFixed(2)}    ${(a.e / a.n).toFixed(2)}    ${(a.c / a.n).toFixed(2)}     ${(a.rr / a.n).toFixed(2)}   ${p50}`);
  }
})().catch((e) => { console.error(e); process.exit(2); });
