import { capabilityAuthority } from './governed-agent-contract.js';

const recallProperties = {
  query: { type: 'string', description: 'The complete user question, preserving exact names and filenames.' },
  mode: { type: 'string', enum: ['fact', 'explain', 'full'], description: 'Use fact normally, explain for detailed evidence, and full only when the user explicitly asks for exhaustive coverage.' },
  limit: { type: 'integer', minimum: 1, maximum: 25 },
  project: { type: 'string' },
  tags: { type: 'array', items: { type: 'string' }, maxItems: 12 },
  source_title: { type: 'string' },
  valid_at: { type: 'string' },
  transaction_at: { type: 'string' },
  sort: { type: 'string', enum: ['score', 'date_asc', 'date_desc'] },
  entity_ids: { type: 'array', items: { type: 'string' }, maxItems: 12,
    description: 'Optional canonical entity IDs returned by the preceding tenant-scoped entities operation. Core re-authorizes them during recall.' },
};

const entityProperties = {
  query: { type: 'string', description: 'One exact or partial named person, organization, product, project, document, or topic from the request. Do not add generic query words.' },
  entity_types: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Optional canonical entity type filters, only when the request states the type.' },
  limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum canonical matches to return.' },
  scope: { type: 'string', enum: ['personal', 'project', 'team', 'organization'], description: 'Optional scope only when explicitly requested; omit otherwise.' },
};

export const HIVEMIND_META_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'hivemind_meta',
    description: 'Authenticated HIVE-MIND gateway. Use entities for a fast tenant-authorized canonical entity match, recall for stored memory/document evidence, context for user and organization profile, save for a source-grounded durable memory, and profiles for the authenticated profile/directory. Entity lookup is not evidence of broader biographical claims: when the user asks for history, pass matched entity_ids to recall. Tenant and user identity are supplied by Core.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['context', 'entities', 'recall', 'save', 'profiles'] },
        entity: { type: 'object', additionalProperties: false, properties: entityProperties, required: ['query'] },
        recall: { type: 'object', additionalProperties: false, properties: recallProperties, required: ['query'] },
        save: {
          type: 'object', additionalProperties: false, required: ['title', 'content'],
          properties: {
            title: { type: 'string', description: 'Specific header naming the principal subject, event, or decision; never use a generic title such as Saved memory.' },
            content: { type: 'string', description: 'Source-grounded memory capsule with supported facts, uncertainty, details, and relationships only; never include credentials or authentication material.' },
            memory_type: { type: 'string', enum: ['fact', 'decision', 'preference', 'procedure', 'experience', 'synthesis'], description: 'Optional proposed type. The LangGraph JEV memory-type node validates or replaces this from the grounded capsule before the durable write.' },
            source_type: { type: 'string', enum: ['text', 'conversation', 'documentation', 'decision'] },
            tags: { type: 'array', items: { type: 'string' }, maxItems: 50 },
            project: { type: 'string' }, scope: { type: 'string', enum: ['personal', 'project', 'team', 'organization'] },
            entities: { type: 'array', items: { type: 'string' }, maxItems: 24, description: 'Supported people, organizations, products, places, and other named entities.' },
            dates: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Supported dates/times exactly as stated or ISO-normalized when explicit.' },
            source_refs: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Supporting receipt ids, source titles, or URLs. Never include OTPs, reset links, passwords, or credentials.' },
            event_time: { type: 'string', description: 'Explicit ISO event time only.' },
            relationship: { type: 'string', enum: ['update', 'extend', 'derive'] }, related_to: { type: 'string' },
          },
        },
      },
    },
  },
});

export const HIVEMIND_CONNECTED_TASK_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'hivemind_connected_task',
    description: 'Tenant-scoped external-app gateway. Search once with atomic use cases, follow its selected slugs and connection state, load schemas only for selected slugs, then execute with schema-valid arguments. External writes always become approval drafts.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['search', 'schemas', 'manage_connection', 'wait_connection', 'execute'] },
        queries: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object', additionalProperties: false, required: ['use_case'],
            properties: {
              use_case: { type: 'string', description: 'One normalized atomic app action with operation, filters, ordering, limit, and required output fields. Preserve business meaning but omit private identifiers.' },
              known_fields: { type: 'string', description: 'At most two short known key:value fields.' },
            },
          },
        },
        session: {
          type: 'object', additionalProperties: false,
          properties: { id: { type: 'string' }, generate_id: { type: 'boolean' } },
        },
        session_id: { type: 'string' },
        toolkits: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        tool_slugs: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        tool_slug: { type: 'string' },
        arguments: { type: 'object', additionalProperties: true },
        search_strategy: { type: 'string', enum: ['auto', 'tool_search'] },
      },
    },
  },
});

export function unifiedMetaTools({ useTools = false } = {}) {
  return useTools ? [HIVEMIND_META_TOOL, HIVEMIND_CONNECTED_TASK_TOOL] : [HIVEMIND_META_TOOL];
}

export function parseUnifiedToolCall(call) {
  const requestedName = String(call?.function?.name || '').trim();
  const name = requestedName.replace(/^functions\./i, '').toLowerCase();
  let args;
  try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { throw new Error('unified_tool_arguments_invalid_json'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('unified_tool_arguments_invalid');
  if (!['hivemind_meta', 'hivemind_connected_task'].includes(name)) {
    return { id: String(call?.id || `call-${Date.now()}`), name: '__invalid_tool__', args: {}, requestedName };
  }
  return { id: String(call?.id || `call-${Date.now()}`), name, args };
}

export function selectedToolSlugs(search = {}) {
  const data = search?.data || search?.result?.data || search?.result || search || {};
  const rows = Array.isArray(data.results) ? data.results : [data];
  return [...new Set(rows.flatMap(row => [
    ...(Array.isArray(row?.primary_tool_slugs) ? row.primary_tool_slugs : []),
    ...(Array.isArray(row?.related_tool_slugs) ? row.related_tool_slugs : []),
  ]).map(value => String(value || '').trim()).filter(Boolean))];
}

export function connectedToolAuthority(slug, schema = {}) {
  if (schema?.is_write === true || schema?.side_effects === true) return 'write';
  if (schema?.is_write === false || schema?.read_only === true || schema?.side_effects === false) return 'read';
  return capabilityAuthority(slug);
}

export function compactConnectedSearch(search = {}) {
  const data = search?.data || search?.result?.data || search?.result || search || {};
  const rows = Array.isArray(data.results) ? data.results : [];
  return {
    success: data.success !== false,
    session: data.session || null,
    results: rows.slice(0, 8).map(row => ({
      use_case: row?.use_case || null,
      primary_tool_slugs: Array.isArray(row?.primary_tool_slugs) ? row.primary_tool_slugs.slice(0, 12) : [],
      related_tool_slugs: Array.isArray(row?.related_tool_slugs) ? row.related_tool_slugs.slice(0, 12) : [],
      recommended_plan_steps: Array.isArray(row?.recommended_plan_steps) ? row.recommended_plan_steps.slice(0, 12) : [],
      known_pitfalls: Array.isArray(row?.known_pitfalls) ? row.known_pitfalls.slice(0, 8) : [],
    })),
    toolkit_connection_statuses: Array.isArray(data.toolkit_connection_statuses)
      ? data.toolkit_connection_statuses.slice(0, 12)
      : (data.toolkit_connection_statuses || {}),
    next_steps_guidance: Array.isArray(data.next_steps_guidance)
      ? data.next_steps_guidance.slice(0, 12)
      : (data.next_steps_guidance || null),
    schema_policy: 'Load schemas only for selected slugs. Execute only a slug selected by this search.',
  };
}

export function disconnectedToolkits(statuses = {}) {
  if (Array.isArray(statuses)) return [...new Set(statuses.filter(row => row?.has_active_connection === false
    || /^(?:disconnected|missing|inactive)$/i.test(String(row?.status || row?.connection_status || '')))
    .map(row => String(row?.toolkit || row?.toolkit_slug || '').toLowerCase()).filter(Boolean))];
  return Object.entries(statuses || {}).filter(([, value]) => {
    const status = typeof value === 'string' ? value : value?.status || value?.connection_status;
    return value?.has_active_connection === false || /^(?:disconnected|missing|inactive)$/i.test(String(status || ''));
  }).map(([toolkit]) => toolkit.toLowerCase());
}
