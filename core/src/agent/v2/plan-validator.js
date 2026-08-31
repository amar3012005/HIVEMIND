import { z } from 'zod';
import { capabilityForOperation, NATIVE_OPERATION_TO_TOOL, NATIVE_OPERATIONS } from './capability-registry.js';

const nullable = z.string().trim().nullable();
const schema = z.object({
  schema_version: z.literal('native-turn-plan.v2'),
  capability: z.enum(['profile', 'memory_write', 'workspace_read', 'direct']),
  operation: z.enum(NATIVE_OPERATIONS),
  response: z.object({
    language: z.string().trim().min(1).max(32), type: z.enum(['fact', 'decision', 'event', 'goal', 'preference', 'lesson', 'relationship', 'profile', 'acknowledgement']),
    scope: z.enum(['bounded', 'broad', 'exhaustive']), depth: z.enum(['standard', 'detailed', 'comprehensive']),
    shape: z.enum(['fact', 'overview', 'inventory', 'timeline', 'comparison', 'explanation']), objective: z.string().trim().min(1).max(1000),
  }).strict(),
  references: z.object({
    resolved_pronouns: z.array(z.string()).max(8), entities: z.array(z.string().trim().min(1)).max(12),
    source: z.object({ title: nullable, document_id: nullable, kind: nullable, selection: z.enum(['latest', 'earliest']).nullable() }).strict().nullable(),
  }).strict(),
  time: z.object({
    semantics: z.enum(['none', 'latest', 'event_range', 'snapshot', 'diff', 'timeline']),
    axis: z.enum(['event_time', 'valid_time', 'known_time']).nullable(), start: nullable, end: nullable, valid_at: nullable, known_at: nullable,
  }).strict(),
  steps: z.array(z.object({
    id: z.string().trim().min(1).max(80), capability: z.enum(['profile', 'memory_write', 'workspace_read', 'direct']),
    tool: nullable, query: nullable, entities: z.array(z.string()).max(12), depends_on: z.array(z.string()).max(0),
    result_binding: z.string().trim().min(1).max(80),
  }).strict()).length(1),
  completion: z.object({ needs_user_input: z.boolean(), approval_required: z.boolean() }).strict(),
  relation_entities: z.array(z.string().trim().min(1)).max(6),
  aggregate: z.object({ parent: nullable, kind: nullable }).strict().nullable(),
  external_fallback: z.object({
    allowed: z.boolean(), query: nullable,
    reason: z.enum(['explicit_web', 'current_public', 'competitor_public']).nullable(),
  }).strict(),
  uses_recent_public_sources: z.boolean(),
  memory: z.object({
    title: nullable, content: nullable, memory_type: nullable,
    scope: z.enum(['personal', 'project', 'team', 'organization']).nullable(), project_id: nullable,
    tags: z.array(z.string()).max(12), entities: z.array(z.string()).max(12), event_time: nullable,
    profile_fields: z.record(z.string()), preferences: z.array(z.string()).max(12),
  }).strict().nullable(),
  direct_response: nullable,
  context_free_certificate: z.boolean(),
}).strict();

function requireValue(value, code) { if (!value) throw new Error(code); }

function normalizeNullableObject(value, keys) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!keys.some((key) => value[key] != null && value[key] !== '')) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
}

// Some OpenAI-compatible providers honor the outer required tool schema but
// omit nullable members inside an object (for example source={}). Missing and
// explicit null mean the same thing for these optional fields, so canonicalize
// that transport variation before strict validation. This repairs shape only;
// semantic requirements below remain fail-closed.
function normalizePlanShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { input, repairs: [] };
  const out = structuredClone(input);
  const repairs = [];
  // Normalize known pre-V2/provider variants before the strict schema sees
  // them. Semantic validation below still requires two distinct entities.
  if (!Array.isArray(out.relation_entities)) {
    const legacyRelationEntities = Array.isArray(out.relation?.entities) ? out.relation.entities : null;
    const referenceEntities = Array.isArray(out.references?.entities) ? out.references.entities : null;
    out.relation_entities = legacyRelationEntities || (out.operation === 'relation_between' ? referenceEntities : []) || [];
    repairs.push(legacyRelationEntities ? 'relation_entities.legacy' : 'relation_entities.references');
  }
  if ('relation' in out) {
    delete out.relation;
    repairs.push('relation.legacy_removed');
  }
  if (out.references && typeof out.references === 'object') {
    const source = normalizeNullableObject(out.references.source, ['title', 'document_id', 'kind', 'selection']);
    if (JSON.stringify(source) !== JSON.stringify(out.references.source ?? null)) repairs.push('references.source.nullables');
    out.references.source = source;
  }
  if (out.time && typeof out.time === 'object') {
    for (const key of ['axis', 'start', 'end', 'valid_at', 'known_at']) {
      if (!(key in out.time)) { out.time[key] = null; repairs.push(`time.${key}`); }
    }
  }
  const aggregate = normalizeNullableObject(out.aggregate, ['parent', 'kind']);
  if (JSON.stringify(aggregate) !== JSON.stringify(out.aggregate ?? null)) repairs.push('aggregate.nullables');
  out.aggregate = aggregate;
  if (!out.external_fallback || typeof out.external_fallback !== 'object' || Array.isArray(out.external_fallback)) {
    out.external_fallback = { allowed: false, query: null, reason: null };
    repairs.push('external_fallback');
  } else {
    for (const key of ['query', 'reason']) {
      if (!(key in out.external_fallback)) { out.external_fallback[key] = null; repairs.push(`external_fallback.${key}`); }
    }
    if (typeof out.external_fallback.allowed !== 'boolean') {
      out.external_fallback.allowed = false; repairs.push('external_fallback.allowed');
    }
  }
  if (typeof out.uses_recent_public_sources !== 'boolean') {
    out.uses_recent_public_sources = false;
    repairs.push('uses_recent_public_sources');
  }
  if (out.memory && typeof out.memory === 'object' && !Array.isArray(out.memory)) {
    for (const key of ['title', 'content', 'memory_type', 'scope', 'project_id', 'event_time']) {
      if (!(key in out.memory)) { out.memory[key] = null; repairs.push(`memory.${key}`); }
    }
    for (const key of ['tags', 'entities', 'preferences']) {
      if (!Array.isArray(out.memory[key])) { out.memory[key] = []; repairs.push(`memory.${key}`); }
    }
    if (Array.isArray(out.memory.profile_fields)) {
      out.memory.profile_fields = Object.fromEntries(out.memory.profile_fields
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map((entry) => [String(entry.field || '').trim(), String(entry.value || '').trim()])
        .filter(([field, value]) => field && value));
      repairs.push('memory.profile_fields.entries');
    } else if (!out.memory.profile_fields || typeof out.memory.profile_fields !== 'object') {
      out.memory.profile_fields = {}; repairs.push('memory.profile_fields');
    }
  } else if (out.memory === undefined) {
    out.memory = null; repairs.push('memory');
  }
  if (out.direct_response === undefined) { out.direct_response = null; repairs.push('direct_response'); }
  if (Array.isArray(out.steps)) {
    out.steps.forEach((step, index) => {
      if (step && typeof step === 'object' && !String(step.result_binding || '').trim()) {
        step.result_binding = `result_${index + 1}`;
        repairs.push(`steps.${index}.result_binding`);
      }
    });
  }
  return { input: out, repairs };
}

// Live production bug (2026-08-25): the model routinely emits a
// schema-VALID but not-quite-null shape for a genuine direct turn —
// steps[0].tool = the capability name ("direct") instead of null,
// time.axis set to an enum value even when time.semantics is "none", and
// memory as a full object with every field null/empty instead of the
// literal `null` the schema also allows. When the model ALSO sets
// context_free_certificate itself these don't matter (validateSemantics
// only checks the certificate, it doesn't re-derive it) — but when the
// model forgets to self-certify, this structural check is the ONLY safety
// net (that's the whole point of PR #566: certification must not depend on
// the model remembering to assert it), and it was failing on exactly the
// model's normal output shape. Observed live: a plain "HELLO" produced
// object.memory = {title:null, content:null, ...all-null...} — a real,
// non-null OBJECT — so `!plan.memory` was false, structurallyContextFree
// was false, the auto-repair never ran, and the turn fell back to the
// legacy recall router with a nonsense "I couldn't find HELLO" answer.
// Fixed by checking MEANINGFUL emptiness instead of raw truthiness/null.
function isMemoryEmpty(memory) {
  if (memory == null) return true;
  if (typeof memory !== 'object' || Array.isArray(memory)) return false;
  const scalarsEmpty = !memory.title && !memory.content && !memory.memory_type
    && !memory.scope && !memory.project_id && !memory.event_time;
  const arraysEmpty = (!memory.tags || memory.tags.length === 0)
    && (!memory.entities || memory.entities.length === 0)
    && (!memory.preferences || memory.preferences.length === 0);
  const profileFieldsEmpty = !memory.profile_fields
    || (typeof memory.profile_fields === 'object' && Object.keys(memory.profile_fields).length === 0);
  return scalarsEmpty && arraysEmpty && profileFieldsEmpty;
}

function deriveMemoryTitle(memory) {
  const entity = Array.isArray(memory?.entities) ? memory.entities.find(Boolean) : null;
  const type = String(memory?.memory_type || 'memory').replace(/[_-]+/g, ' ').trim();
  if (entity) return `${entity} ${type}`.trim().slice(0, 120);
  const content = String(memory?.content || '').replace(/\s+/g, ' ').trim();
  return content ? content.replace(/[.!?]+$/, '').slice(0, 120) : null;
}

function recoverCanonicalProfileUpdate(plan, repairs) {
  if (plan.operation !== 'update_profile' || Object.keys(plan.memory?.profile_fields || {}).length
    || (plan.memory?.preferences || []).length) return;

  // The planner already performs the language-dependent interpretation and
  // emits a canonical English mutation query. Recover only that structured
  // field/value pair; never infer profile data from arbitrary user prose.
  const candidates = [plan.steps?.[0]?.query, plan.response?.objective]
    .map((value) => String(value || '').trim()).filter(Boolean);
  const match = candidates.map((candidate) => candidate.match(
    /^(?:update|set|change)\s+(?:(?:the\s+)?user(?:'s)?|my)\s+([a-z][a-z0-9_.-]{0,63})\s+(?:to|as)\s+(.+)$/i,
  )).find(Boolean);
  if (!match) return;
  const field = match[1].toLowerCase();
  const value = match[2].trim().replace(/[.!?]+$/, '').trim();
  const allowed = new Set(['name', 'location', 'role', 'company', 'language', 'timezone']);
  if (!allowed.has(field) || !value) return;
  plan.memory ||= {
    title: null, content: null, memory_type: null, scope: null, project_id: null,
    tags: [], entities: [], event_time: null, profile_fields: {}, preferences: [],
  };
  plan.memory.profile_fields[field] = value;
  repairs.push(`memory.profile_fields.${field}.canonical_query`);
}

function reconcileSemanticOperation(plan, repairs) {
  const exactSource = plan.references.source?.title || plan.references.source?.document_id;
  const canonicalReadObjective = `${plan.steps[0]?.query || ''} ${plan.response.objective || ''}`;
  const relationshipObjective = /\b(?:relationship|related|relation|connection)\b/i.test(canonicalReadObjective);
  // A relationship objective with two resolved entities owns the dedicated
  // relation lane even when the model selected generic recall. This is a
  // deterministic semantic repair, not a keyword classifier.
  if (plan.operation === 'recall' && (plan.response.type === 'relationship' || relationshipObjective)
      && plan.references.entities.length >= 2) {
    plan.operation = 'relation_between';
    plan.relation_entities = [...new Set(plan.references.entities)].slice(0, 6);
    repairs.push('operation.relationship_semantics');
  }
  if (plan.time.semantics === 'event_range' && (!plan.time.start || !plan.time.end)) {
    plan.time = { semantics: 'none', axis: null, start: null, end: null, valid_at: null, known_at: null };
    if (plan.operation === 'event_range') plan.operation = 'recall';
    repairs.push('time.incomplete_range');
  }
  if (plan.operation === 'save' && !plan.memory?.content && plan.response.type !== 'acknowledgement' && plan.steps[0].query) {
    plan.operation = 'recall';
    plan.memory = null;
    plan.completion = { needs_user_input: false, approval_required: false };
    repairs.push('operation.incomplete_write');
  }
  if (plan.operation === 'source_read' && !exactSource && plan.references.source?.selection) {
    plan.operation = 'recall';
    repairs.push('operation.selected_source');
  }
  // An incomplete temporal payload is not executable and must never make an
  // ordinary workspace question fail with native_plan_missing_* after two
  // identical planner attempts. With no usable boundary, the only safe
  // read-only interpretation is ordinary typed recall of the unchanged query.
  if (plan.operation === 'snapshot' && !plan.time.valid_at && !plan.time.known_at) {
    plan.operation = exactSource ? 'source_read' : 'recall';
    plan.time = { semantics: 'none', axis: null, start: null, end: null, valid_at: null, known_at: null };
    repairs.push('operation.incomplete_snapshot');
  }
  if (plan.operation === 'diff' && (!plan.time.start || !plan.time.end)) {
    plan.operation = 'recall';
    plan.time = { semantics: 'none', axis: null, start: null, end: null, valid_at: null, known_at: null };
    repairs.push('operation.incomplete_diff');
  }
  if (plan.operation === 'event_range' && (!plan.time.start || !plan.time.end)) {
    plan.operation = 'recall';
    plan.time = { semantics: 'none', axis: null, start: null, end: null, valid_at: null, known_at: null };
    repairs.push('operation.incomplete_event_range');
  }
  // Aggregate is a completeness operator, not a synonym for "a lot of
  // detail". The planner can emit a schema-valid aggregate for a broad source
  // overview; that used to skip hybrid recall and end in the exact-count
  // refusal without ever running synthesis. Certify the semantic shape on the
  // server: only a canonical inventory may use the registry executor.
  if (plan.operation === 'aggregate'
      && (plan.response.shape !== 'inventory' || plan.references.source)) {
    plan.operation = 'recall';
    plan.aggregate = null;
    repairs.push('operation.uncertified_aggregate');
  }
  const webUnsafe = !['recall', 'event_range'].includes(plan.operation)
    || Boolean(plan.references.source)
    || !plan.external_fallback.query
    || !plan.external_fallback.reason;
  if (plan.external_fallback.allowed && webUnsafe) {
    plan.external_fallback = { allowed: false, query: null, reason: null };
    repairs.push('external_fallback.unsafe');
  }
  const temporalOperation = {
    event_range: 'event_range',
    snapshot: 'snapshot',
    diff: 'diff',
    timeline: 'timeline',
  }[plan.time.semantics];
  if (temporalOperation && plan.operation === 'recall') {
    plan.operation = temporalOperation;
    repairs.push('operation.time_semantics');
  } else if (exactSource && plan.operation === 'recall') {
    plan.operation = 'source_read';
    repairs.push('operation.exact_source');
  }
  const readOps = new Set(['recall', 'source_read', 'event_range', 'snapshot', 'diff', 'timeline', 'relation_between', 'aggregate']);
  if (readOps.has(plan.operation) && !plan.steps[0].query) {
    plan.steps[0].query = plan.response.objective;
    repairs.push('steps.0.query');
  }

  // The context-free certificate is a server-owned safety decision, not a
  // second opinion the planner model must remember to assert. A conversational
  // response is safe to serve directly only when its complete plan is
  // structurally context-free: no retrieval query, entities, source, temporal
  // selector, relationship/aggregate payload, memory write, or user input.
  // This repairs greetings and thanks without allowing an uncertified factual
  // answer to bypass grounded recall.
  // Tolerant, not strict-null, on the three fields the model routinely
  // fills with a schema-valid placeholder instead of the literal null a
  // naive check would require — see isMemoryEmpty's comment for the live
  // incident this fixes. A real tool selection or a real time axis is
  // still disqualifying; only the specific "direct" self-reference and an
  // axis with no accompanying semantics are treated as no-ops.
  // 'direct' is never a real tool name (no entry in NATIVE_OPERATION_TO_TOOL's
  // value list equals it) — the model emits the CAPABILITY/OPERATION name
  // here, not the correct value (null), so compare against that literal
  // string, not against NATIVE_OPERATION_TO_TOOL.direct (which IS null and
  // therefore never equals what a confused model actually sends).
  const noRealTool = !plan.steps[0].tool || plan.steps[0].tool === 'direct';
  const noRealTimeAxis = plan.time.semantics === 'none';
  const structurallyContextFree = plan.operation === 'direct'
    && Boolean(plan.direct_response)
    && noRealTool
    && plan.references.entities.length === 0
    && !plan.references.source
    && noRealTimeAxis
    && plan.relation_entities.length === 0
    && !plan.aggregate
    && isMemoryEmpty(plan.memory)
    && !plan.completion.needs_user_input
    && !plan.completion.approval_required;
  if (structurallyContextFree && !plan.context_free_certificate) {
    plan.context_free_certificate = true;
    repairs.push('context_free_certificate.structural');
  }
  if (structurallyContextFree && plan.steps[0].query) {
    plan.steps[0].query = null;
    repairs.push('steps.0.query.direct');
  }
}

function validateSemantics(plan) {
  const query = plan.steps[0].query;
  const readOps = new Set(['recall', 'source_read', 'event_range', 'snapshot', 'diff', 'timeline', 'relation_between', 'aggregate']);
  if (readOps.has(plan.operation)) requireValue(query, 'native_plan_missing_canonical_query');
  if (plan.operation === 'source_read') requireValue(plan.references.source?.title || plan.references.source?.document_id, 'native_plan_missing_source');
  if (plan.operation === 'event_range') { requireValue(plan.time.start, 'native_plan_missing_range_start'); requireValue(plan.time.end, 'native_plan_missing_range_end'); }
  if (plan.operation === 'snapshot') requireValue(plan.time.valid_at || plan.time.known_at, 'native_plan_missing_snapshot_time');
  if (plan.operation === 'diff') { requireValue(plan.time.start, 'native_plan_missing_diff_start'); requireValue(plan.time.end, 'native_plan_missing_diff_end'); }
  if (plan.operation === 'relation_between' && plan.relation_entities.length < 2) throw new Error('native_plan_missing_relation_entities');
  if (plan.operation === 'aggregate') { requireValue(plan.aggregate?.parent, 'native_plan_missing_aggregate_parent'); requireValue(plan.aggregate?.kind, 'native_plan_missing_aggregate_kind'); }
  if (plan.operation === 'save') { requireValue(plan.memory?.title, 'native_plan_missing_memory_title'); requireValue(plan.memory?.content, 'native_plan_missing_memory_content'); }
  if (plan.operation === 'update_profile' && !Object.keys(plan.memory?.profile_fields || {}).length && !(plan.memory?.preferences || []).length) throw new Error('native_plan_missing_profile_update');
  if (plan.operation === 'direct') {
    if (!plan.context_free_certificate) throw new Error('native_plan_direct_not_certified');
    requireValue(plan.direct_response, 'native_plan_missing_direct_response');
  } else if (plan.context_free_certificate) throw new Error('native_plan_invalid_context_free_certificate');
  if (plan.completion.approval_required !== ['save', 'update_profile'].includes(plan.operation)) throw new Error('native_plan_invalid_approval_policy');
}

export function validateNativePlanResult(input) {
  try {
    const normalized = normalizePlanShape(input);
    const plan = schema.parse(normalized.input);
    const semanticRepairs = [];
    if (plan.operation === 'save' && !plan.memory?.title && plan.memory?.content) {
      plan.memory.title = deriveMemoryTitle(plan.memory);
      semanticRepairs.push('memory.title');
    }
    if (plan.operation === 'aggregate' && !plan.aggregate?.parent && plan.references.entities.length === 1) {
      plan.aggregate.parent = plan.references.entities[0];
      semanticRepairs.push('aggregate.parent');
    }
    if (plan.operation === 'relation_between' && plan.relation_entities.length < 2
        && plan.references.entities.length >= 2) {
      plan.relation_entities = [...new Set(plan.references.entities)].slice(0, 6);
      semanticRepairs.push('relation_entities.references');
    }
    if (plan.operation === 'snapshot') {
      if (plan.time.axis === 'valid_time' && !plan.time.valid_at && plan.time.start) {
        plan.time.valid_at = plan.time.start; semanticRepairs.push('time.valid_at');
      }
      if (plan.time.axis === 'known_time' && !plan.time.known_at && plan.time.start) {
        plan.time.known_at = plan.time.start; semanticRepairs.push('time.known_at');
      }
    }
    reconcileSemanticOperation(plan, semanticRepairs);
    recoverCanonicalProfileUpdate(plan, semanticRepairs);
    validateSemantics(plan);
    const expectedCapability = capabilityForOperation(plan.operation);
    const expectedTool = NATIVE_OPERATION_TO_TOOL[plan.operation];
    const repairs = [...normalized.repairs, ...semanticRepairs];
    if (plan.capability !== expectedCapability) { plan.capability = expectedCapability; repairs.push('capability'); }
    if (plan.steps[0].capability !== expectedCapability) { plan.steps[0].capability = expectedCapability; repairs.push('step.capability'); }
    if (plan.steps[0].tool !== expectedTool) { plan.steps[0].tool = expectedTool; repairs.push('step.tool'); }
    if (plan.response.scope === 'exhaustive' && plan.response.depth !== 'comprehensive') { plan.response.depth = 'comprehensive'; repairs.push('response.depth'); }
    else if (plan.response.scope === 'broad' && plan.response.depth === 'standard') { plan.response.depth = 'detailed'; repairs.push('response.depth'); }
    return { status: repairs.length ? 'repairable' : 'valid', plan, repairs, error: null };
  } catch (error) {
    return { status: 'invalid', plan: null, repairs: [], error: error.message };
  }
}

export function validateNativePlan(input) {
  const result = validateNativePlanResult(input);
  if (result.status === 'invalid') throw new Error(result.error);
  return result.plan;
}
