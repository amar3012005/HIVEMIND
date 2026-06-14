/**
 * Meeting Intelligence — cross-reference a finished meeting against existing
 * HIVEMIND memory and emit three GROUNDED lanes: entity briefs, decision
 * continuity/contradiction, and open loops. Pure + dependency-injected:
 * callers pass `recall` and `judge` so this unit-tests with fakes.
 *
 * GROUNDING CONTRACT: every emitted item carries ≥1 real memory id. Items
 * without one are dropped. All lanes empty → status 'empty'.
 */

/** Keep only items grounded in at least one real memory id. */
export function onlyGrounded(items) {
  return (items || []).filter((it) => {
    if (Array.isArray(it?.memory_ids) && it.memory_ids.length) return true;
    if (typeof it?.memory_id === 'string' && it.memory_id) return true;
    return false;
  });
}

/**
 * Lane 1 — for each entity, recall related memories and compress the top hits
 * into a one-line brief via the injected judge. Zero-hit entities are dropped.
 * @param {{name:string,kind:string}[]} entities
 * @param {{recall:Function, judge:Function, maxEntities?:number}} deps
 */
export async function entityBriefs(entities, { recall, judge, maxEntities = 6 }) {
  const picked = (entities || []).filter((e) => e?.name).slice(0, maxEntities);
  const found = [];
  for (const e of picked) {
    const res = await recall(e.name).catch(() => ({ memories: [] }));
    const mems = (res?.memories || []).slice(0, 5);
    if (!mems.length) continue; // zero-hit → dropped (grounding contract)
    found.push({
      name: e.name,
      kind: e.kind || 'entity',
      memory_count: mems.length,
      memory_ids: mems.map((m) => m.id).filter(Boolean),
      _snippets: mems.map((m) => `${m.title || ''} ${m.content || ''}`.trim().slice(0, 240)),
    });
  }
  if (!found.length) return [];
  const briefs = await judge({
    task: 'entity_briefs',
    entities: found.map((f) => ({ name: f.name, snippets: f._snippets })),
  }).then((r) => r?.briefs || {}).catch(() => ({}));
  return onlyGrounded(found.map((f) => ({
    name: f.name,
    kind: f.kind,
    memory_count: f.memory_count,
    memory_ids: f.memory_ids,
    brief: (briefs[f.name] || f._snippets[0] || '').toString().slice(0, 240),
  })));
}

/**
 * Lane 2 — for each decision, recall the most-similar prior decision/fact and
 * ask the judge whether this decision is NEW / UPDATES / CONFLICTS. Only
 * UPDATES & CONFLICTS above the confidence floor AND grounded in a prior
 * memory id are emitted. Phrased as "worth reconciling", never accusatory.
 */
export async function continuity(decisions, { recall, judge, maxDecisions = 8, minConfidence = 0.6 }) {
  const picked = (decisions || []).filter((d) => typeof d === 'string' && d.trim()).slice(0, maxDecisions);
  const pairs = [];
  for (const decision of picked) {
    const res = await recall(decision).catch(() => ({ memories: [] }));
    const prior = (res?.memories || [])[0];
    if (!prior?.id) continue; // no prior memory → can't be UPDATES/CONFLICTS
    pairs.push({ decision, prior_memory_id: prior.id, prior_snippet: (prior.content || prior.title || '').slice(0, 200) });
  }
  if (!pairs.length) return [];
  const judged = await judge({
    task: 'continuity',
    pairs: pairs.map((p) => ({ decision: p.decision, prior: p.prior_snippet })),
  }).then((r) => r?.results || []).catch(() => []);
  const out = [];
  pairs.forEach((p, i) => {
    const j = judged[i] || {};
    const rel = j.relation;
    if ((rel === 'UPDATES' || rel === 'CONFLICTS') && Number(j.confidence) >= minConfidence) {
      out.push({
        decision: p.decision,
        relation: rel,
        prior: p.prior_snippet,
        prior_memory_id: p.prior_memory_id,
        reason: (j.reason || '').toString().slice(0, 160),
        confidence: Number(j.confidence),
      });
    }
  });
  return out;
}

const LOOP_KINDS = ['risk', 'next-step', 'goal', 'action'];

/**
 * Lane 3 — recall prior risk/action/next-step memories on the meeting's
 * topics/entities that look unresolved. Heuristic: the memory itself is a
 * risk/action tag. (Exact resolution comes in Phase A via action-item status.)
 */
export async function openLoops(topics, { recall, maxTopics = 6 }) {
  const picked = (topics || []).filter((tp) => typeof tp === 'string' && tp.trim()).slice(0, maxTopics);
  const seen = new Set();
  const out = [];
  for (const tp of picked) {
    const res = await recall(tp).catch(() => ({ memories: [] }));
    for (const m of (res?.memories || [])) {
      if (!m?.id || seen.has(m.id)) continue;
      const tags = Array.isArray(m.tags) ? m.tags : [];
      const kind = LOOP_KINDS.find((k) => tags.includes(k));
      if (!kind) continue;
      seen.add(m.id);
      out.push({
        kind,
        text: (m.content || m.title || '').toString().slice(0, 200),
        memory_id: m.id,
        source_meeting_id: m.meeting_id || null,
        created_at: m.created_at || null,
      });
      if (out.length >= 8) break;
    }
    if (out.length >= 8) break;
  }
  return onlyGrounded(out);
}

/**
 * Orchestrator — runs all three lanes within bounded cost and assembles the
 * intelligence object. Never throws (best-effort enrichment); a failed lane
 * contributes nothing. Status: 'ready' if anything grounded, else 'empty'.
 */
export async function generateIntelligence(meeting, { recall, judge, nowIso }) {
  const ins = (meeting?.insights && typeof meeting.insights === 'object') ? meeting.insights : {};
  const people = Array.isArray(ins.entities?.people) ? ins.entities.people : [];
  const orgs = Array.isArray(ins.entities?.organizations) ? ins.entities.organizations : [];
  const ents = [
    ...people.map((n) => ({ name: String(n), kind: 'person' })),
    ...orgs.map((n) => ({ name: String(n), kind: 'org' })),
  ];
  const [entities, cont, loops] = await Promise.all([
    entityBriefs(ents, { recall, judge }).catch(() => []),
    continuity(Array.isArray(ins.decisions) ? ins.decisions : [], { recall, judge }).catch(() => []),
    openLoops(Array.isArray(ins.topics) ? ins.topics : [], { recall }).catch(() => []),
  ]);
  const related = entities.reduce((s, e) => s + (e.memory_count || 0), 0) + cont.length + loops.length;
  const has = entities.length || cont.length || loops.length;
  return {
    generated_at: nowIso || new Date().toISOString(),
    related_count: related,
    entities,
    continuity: cont,
    open_loops: loops,
    status: has ? 'ready' : 'empty',
  };
}
