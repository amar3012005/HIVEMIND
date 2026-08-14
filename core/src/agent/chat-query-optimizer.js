/** Pure intent-preserving recall-query policy with no storage/provider imports. */
export function fallbackRecallQueries(message, plan = {}) {
  return [...new Set([
    plan.query_canonical_en,
    message,
    ...(Array.isArray(plan.sub_queries) ? plan.sub_queries : []),
  ].filter((query) => typeof query === 'string' && query.trim())
    .map((query) => query.trim().slice(0, 240)))].slice(0, 3);
}

export function normalizeRecallOptimization(parsed, fallback = []) {
  const semantic = typeof parsed?.semantic_query === 'string' ? parsed.semantic_query.trim() : '';
  // Generated alternates can silently weaken polarity, direction, or temporal
  // bounds. Keep one model-authored semantic representation, then fall back to
  // the planner query and exact original wording, both of which are already
  // independently available and auditable.
  const candidates = [semantic, ...fallback]
    .filter((query) => typeof query === 'string' && query.trim())
    .map((query) => query.trim().slice(0, 240));
  return [...new Set(candidates)].slice(0, 3);
}

export function buildRecallIntentContext(message, plan = {}) {
  return {
    message: String(message || '').slice(0, 1000),
    operation: plan.operation || 'recall',
    recall_mode: plan.recall_mode || 'fact',
    planner_query: plan.query_canonical_en || null,
    planner_sub_queries: Array.isArray(plan.sub_queries) ? plan.sub_queries.slice(0, 3) : [],
    named_entities: Array.isArray(plan.named_entities) ? plan.named_entities.slice(0, 12) : [],
    time: plan.time || null,
    source: plan.source || null,
    relation: plan.relation_intent || null,
  };
}
