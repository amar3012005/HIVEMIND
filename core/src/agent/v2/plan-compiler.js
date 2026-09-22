import { NATIVE_OPERATION_TO_TOOL } from './capability-registry.js';
import { HIVEMIND_TOOL_GROUPS } from '../connector-toolkits/hivemind-tool-groups.js';

function temporalDecision(plan) {
  const t = plan.time;
  if (plan.operation === 'event_range') return { kind: 'event_range', start: t.start, end: t.end, axis: 'event_time' };
  if (plan.operation === 'snapshot') return { valid_at: t.valid_at, known_at: t.known_at };
  if (plan.operation === 'diff') return { range: { start: t.start, end: t.end }, axis: t.axis || 'valid_time' };
  if (plan.operation === 'timeline') return { axis: t.axis || 'valid_time' };
  if (t.semantics === 'latest') return { kind: 'latest', axis: t.axis || 'known_time' };
  return null;
}

// A public page retrieval is an explicit user request for external evidence,
// not a request to reinterpret whatever happens to be in workspace memory.
// Keep this deliberately narrow: it requires an action verb plus either an
// absolute URL or a route-shaped public page reference. The Web Intelligence
// boundary still owns network access, rate limits, and result validation.
function explicitPublicPageRequest(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  const asksToRetrieve = /\b(?:crawl|extract|fetch|open|pull|read|scrape)\b/i.test(text);
  const hasAbsoluteUrl = /\bhttps?:\/\/[^\s<>"']+/i.test(text);
  const hasRoute = /(?:^|\s)\/[a-z0-9][a-z0-9._~\-/]*/i.test(text);
  const namesPublicPage = /\b(?:page|pages|site|website|web)\b/i.test(text);
  if (!asksToRetrieve || (!hasAbsoluteUrl && !(hasRoute && namesPublicPage))) return null;
  return text.slice(0, 800);
}

export function compileNativePlan(plan, message, context = {}) {
  const step = plan.steps[0];
  const descriptiveSourceHint = plan.operation === 'source_read'
    && plan.references.source?.title
    && !plan.references.source?.document_id
    && !/\.[a-z0-9]{1,12}$/i.test(plan.references.source.title);
  const operation = plan.operation === 'event_range' || descriptiveSourceHint ? 'recall'
    : ['snapshot', 'diff', 'timeline'].includes(plan.operation) ? 'timeline'
      : plan.operation;
  const explicitPublicQuery = explicitPublicPageRequest(message);
  const webFallback = plan.external_fallback?.allowed ? {
    allowed: true,
    query: plan.external_fallback.query,
    reason: plan.external_fallback.reason,
  } : explicitPublicQuery ? {
    allowed: true,
    query: explicitPublicQuery,
    reason: 'explicit_web',
  } : { allowed: false, query: null, reason: null };
  return {
    version: plan.schema_version, _router: 'native-v2', operation,
    response_language: plan.response.language,
    queries: step.query ? [step.query] : [], query_original: message, query_canonical_en: step.query,
    named_entities: plan.references.entities,
    native_tool: NATIVE_OPERATION_TO_TOOL[plan.operation],
    answer_type: plan.response.type, answer_scope: plan.response.scope,
    response_depth: plan.response.depth, retrieval_shape: plan.response.shape,
    answer_objective: plan.response.objective,
    retrieval: plan.retrieval || null,
    // A source read must expand canonical document evidence even when the
    // answer itself is bounded. `fact` skips that evidence lane and can turn a
    // fully ingested named document into a false "not found" response.
    recall_mode: plan.operation === 'source_read' ? 'explain'
      : plan.response.scope === 'bounded' ? 'fact' : 'explain',
    tool_groups: Object.keys(HIVEMIND_TOOL_GROUPS),
    side_effect_policy: plan.completion.approval_required ? 'approval_required' : 'read_only',
    source: descriptiveSourceHint ? null : plan.references.source,
    time: temporalDecision(plan), aggregate: plan.aggregate,
    web_fallback: webFallback,
    // Always carry the single replaceable public-source checkpoint into the
    // next turn. The planner flag remains useful telemetry, but correctness no
    // longer depends on a small model recognizing phrases such as "that
    // source" in every language. Synthesis receives a bounded cited packet and
    // decides whether it is relevant alongside current recall.
    recent_public_sources: (context.recent_source_refs || []).slice(-8),
    recent_context_answer: context.recent_context_answer || null,
    uses_recent_public_sources: plan.uses_recent_public_sources === true,
    relation: operation === 'relation_between' ? { entities: plan.relation_entities, source: plan.references.source, time: temporalDecision(plan) } : null,
    save: operation === 'save' ? {
      title: plan.memory.title, content: plan.memory.content, memory_type: plan.memory.memory_type || 'fact',
      scope: plan.memory.scope || undefined, project_id: plan.memory.project_id || undefined,
      tags: plan.memory.tags, entities: plan.memory.entities, event_time: plan.memory.event_time || undefined,
      confidence: 1, admission_class: 'user_assertion',
    } : null,
    profile_update: operation === 'update_profile' ? { fields: plan.memory?.profile_fields || {}, preferences: plan.memory?.preferences || [] } : null,
    direct_response: operation === 'direct' ? plan.direct_response : null,
    direct_context_free: operation === 'direct',
    project_prompt: operation === 'projects' ? step.query || message : null,
    completion: plan.completion,
    planned_steps: plan.steps,
  };
}
