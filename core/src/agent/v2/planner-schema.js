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
      operation: { type: 'string', enum: NATIVE_OPERATIONS, description: 'Semantic operation. aggregate is only complete deduplicated registry count/enumeration, never arithmetic, attribute filtering, comparison, or a document-derived list. relation_between is only a stored relationship/path, never an attribute comparison. Time-bounded events use event_range with resolved ISO bounds.' },
      response: { type: 'object', additionalProperties: false, properties: {
        language: { type: 'string' }, type: { type: 'string', enum: ['fact', 'decision', 'event', 'goal', 'preference', 'lesson', 'relationship', 'profile', 'acknowledgement'] },
        scope: { type: 'string', enum: ['bounded', 'broad', 'exhaustive'], description: 'Requested answer coverage. Use bounded for ordinary fact/entity questions, broad only for meaningful multi-aspect breadth, exhaustive only for complete inventories.' }, depth: { type: 'string', enum: ['standard', 'detailed', 'comprehensive'] },
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
      aggregate: { type: ['object', 'null'], description: 'Non-null only for a complete canonical registry count/enumeration beneath a named parent. Null for ordinary lists, arithmetic, comparisons, compatibility filters, and document questions.', additionalProperties: false, properties: { parent: nullableString, kind: nullableString } },
      external_fallback: { type: 'object', additionalProperties: false, description: 'Optional public-web fallback policy. Recall always runs first; the server may search at most once only after a verified workspace gap.', properties: {
        allowed: { type: 'boolean' }, query: nullableString,
        reason: { type: ['string', 'null'], enum: ['explicit_web', 'current_public', 'competitor_public', null] },
      }, required: ['allowed', 'query', 'reason'] },
      memory: { type: ['object', 'null'], additionalProperties: false, properties: {
        title: nullableString, content: nullableString, memory_type: nullableString,
        scope: { type: ['string', 'null'], enum: ['personal', 'project', 'team', 'organization', null], description: 'Explicit destination stated by the user. MUST be null when the user did not state a destination; the server owns the scope chooser.' }, project_id: nullableString,
        tags: { type: 'array', items: { type: 'string' }, maxItems: 12 }, entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        event_time: nullableString, profile_fields: { type: 'array', maxItems: 12, description: 'For update_profile, every changed caller-owned identity field. A location, role, name or biography change MUST appear here. Example: "I live in Hannover, Germany" becomes [{"field":"location","value":"Hannover, Germany"}].', items: {
          type: 'object', additionalProperties: false, properties: { field: { type: 'string' }, value: { type: 'string' } }, required: ['field', 'value'],
        } },
        preferences: { type: 'array', items: { type: 'string' }, maxItems: 12 },
      } },
      direct_response: nullableString, context_free_certificate: { type: 'boolean' },
    }, required: ['schema_version', 'capability', 'operation', 'response', 'references', 'time', 'steps', 'completion', 'relation_entities', 'aggregate', 'external_fallback', 'memory', 'direct_response', 'context_free_certificate'] },
  } };
}
