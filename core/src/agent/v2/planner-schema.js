import { NATIVE_OPERATIONS } from './capability-registry.js';

export const NATIVE_PLAN_TOOL_NAME = 'hivemind_native_plan_v2';
const nullableString = { type: ['string', 'null'] };

export function createNativePlanTool() {
  return { type: 'function', function: {
    name: NATIVE_PLAN_TOOL_NAME,
    description: 'Return one complete NativeTurnPlanV2. Do not answer the user.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      schema_version: { type: 'string', enum: ['native-turn-plan.v2'] },
      capability: { type: 'string', enum: ['profile', 'memory_write', 'workspace_read', 'direct'] },
      operation: { type: 'string', enum: NATIVE_OPERATIONS },
      response: { type: 'object', additionalProperties: false, properties: {
        language: { type: 'string' }, type: { type: 'string', enum: ['fact', 'decision', 'event', 'relationship', 'profile', 'acknowledgement'] },
        scope: { type: 'string', enum: ['bounded', 'broad', 'exhaustive'] }, depth: { type: 'string', enum: ['standard', 'detailed', 'comprehensive'] },
        shape: { type: 'string', enum: ['fact', 'overview', 'inventory', 'timeline', 'comparison', 'explanation'] }, objective: { type: 'string' },
      }, required: ['language', 'type', 'scope', 'depth', 'shape', 'objective'] },
      references: { type: 'object', additionalProperties: false, properties: {
        resolved_pronouns: { type: 'array', items: { type: 'string' }, maxItems: 8 }, entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        source: { type: ['object', 'null'], additionalProperties: false, properties: {
          title: nullableString, document_id: nullableString, kind: nullableString,
          selection: { type: ['string', 'null'], enum: ['latest', 'earliest', null] },
        } },
      }, required: ['resolved_pronouns', 'entities', 'source'] },
      time: { type: 'object', additionalProperties: false, properties: {
        semantics: { type: 'string', enum: ['none', 'latest', 'event_range', 'snapshot', 'diff', 'timeline'] },
        axis: { type: ['string', 'null'], enum: ['event_time', 'valid_time', 'known_time', null] },
        start: nullableString, end: nullableString, valid_at: nullableString, known_at: nullableString,
      }, required: ['semantics', 'axis', 'start', 'end', 'valid_at', 'known_at'] },
      steps: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string' }, capability: { type: 'string', enum: ['profile', 'memory_write', 'workspace_read', 'direct'] },
        tool: nullableString, query: nullableString, entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        depends_on: { type: 'array', items: { type: 'string' }, maxItems: 0 }, result_binding: { type: 'string' },
      }, required: ['id', 'capability', 'tool', 'query', 'entities', 'depends_on', 'result_binding'] } },
      completion: { type: 'object', additionalProperties: false, properties: {
        needs_user_input: { type: 'boolean' }, approval_required: { type: 'boolean' },
      }, required: ['needs_user_input', 'approval_required'] },
      relation_entities: { type: 'array', items: { type: 'string' }, maxItems: 6 },
      aggregate: { type: ['object', 'null'], additionalProperties: false, properties: { parent: nullableString, kind: nullableString } },
      memory: { type: ['object', 'null'], additionalProperties: false, properties: {
        title: nullableString, content: nullableString, memory_type: nullableString,
        scope: { type: ['string', 'null'], enum: ['personal', 'project', 'team', 'organization', null] }, project_id: nullableString,
        tags: { type: 'array', items: { type: 'string' }, maxItems: 12 }, entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        event_time: nullableString, profile_fields: { type: 'object', additionalProperties: { type: 'string' } },
        preferences: { type: 'array', items: { type: 'string' }, maxItems: 12 },
      } },
      direct_response: nullableString, context_free_certificate: { type: 'boolean' },
    }, required: ['schema_version', 'capability', 'operation', 'response', 'references', 'time', 'steps', 'completion', 'relation_entities', 'aggregate', 'memory', 'direct_response', 'context_free_certificate'] },
  } };
}
