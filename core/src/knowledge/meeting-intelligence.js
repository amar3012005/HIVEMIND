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
