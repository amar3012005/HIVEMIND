import { z } from 'zod';
import { capabilityForOperation, NATIVE_OPERATION_TO_TOOL, NATIVE_OPERATIONS } from './capability-registry.js';

const nullable = z.string().trim().nullable();
const schema = z.object({
  schema_version: z.literal('native-turn-plan.v2'),
  capability: z.enum(['profile', 'memory_write', 'workspace_read', 'direct']),
  operation: z.enum(NATIVE_OPERATIONS),
  response: z.object({
    language: z.string().trim().min(1).max(32), type: z.enum(['fact', 'decision', 'event', 'relationship', 'profile', 'acknowledgement']),
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
    const plan = schema.parse(input);
    validateSemantics(plan);
    const expectedCapability = capabilityForOperation(plan.operation);
    const expectedTool = NATIVE_OPERATION_TO_TOOL[plan.operation];
    const repairs = [];
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
