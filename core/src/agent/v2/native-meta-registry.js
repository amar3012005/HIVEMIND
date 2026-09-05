import { TOOL_SCHEMAS } from '../tool-schemas.js';
import {
  NATIVE_CAPABILITY_CARDS,
  NATIVE_OPERATION_TO_TOOL,
  capabilityForOperation,
} from './capability-registry.js';

const SCHEMAS = new Map(TOOL_SCHEMAS.map((entry) => [entry?.function?.name, entry]));

function authorityFor(operation) {
  const family = capabilityForOperation(operation);
  const card = NATIVE_CAPABILITY_CARDS[family === 'direct' ? 'respond_directly' : family];
  return card?.authority || 'none';
}

export function searchNativeCapabilities(plan) {
  const operation = String(plan?.operation || '');
  const tool = NATIVE_OPERATION_TO_TOOL[operation] ?? null;
  if (!operation || !(operation in NATIVE_OPERATION_TO_TOOL)) throw new Error('native_meta_unknown_operation');
  const family = capabilityForOperation(operation);
  const card = NATIVE_CAPABILITY_CARDS[family === 'direct' ? 'respond_directly' : family];
  return Object.freeze({
    operation,
    tool,
    family,
    authority: authorityFor(operation),
    side_effect: card?.side_effect || 'none',
    use_when: card?.use_when || '',
    avoid_when: card?.avoid_when || '',
  });
}

export function getNativeToolSchemas(toolNames = []) {
  return [...new Set(toolNames.filter(Boolean))].map((name) => {
    const schema = SCHEMAS.get(name);
    if (!schema) throw new Error(`native_meta_schema_missing:${name}`);
    return schema;
  });
}

export function buildNativeMetaReceipt({ plan, validation }) {
  const capability = searchNativeCapabilities(plan);
  const schemas = getNativeToolSchemas(capability.tool ? [capability.tool] : []);
  return Object.freeze({
    schema_version: 'hivemind-native-meta.v1',
    capability,
    schemas,
    validation: {
      status: validation?.status || 'valid',
      repairs: Array.isArray(validation?.repairs) ? validation.repairs : [],
    },
  });
}

export function assertNativeMetaAuthority(receipt) {
  const capability = receipt?.capability;
  if (!capability) throw new Error('native_meta_capability_missing');
  if (capability.tool && !String(capability.tool).startsWith('hivemind_')
      && !['get_user_profile', 'update_user_profile'].includes(capability.tool)) {
    throw new Error('native_meta_external_tool_forbidden');
  }
  return receipt;
}

function semanticArgumentPool(plan = {}) {
  const query = plan.query_canonical_en || plan.queries?.[0] || plan.user_message || null;
  const source = plan.source || {};
  const retrieval = plan.retrieval || {};
  const time = plan.time || {};
  const save = plan.save_intent || plan.save || {};
  return {
    query,
    query_original: plan.user_message || plan.query_original || null,
    context: query,
    contains: query,
    title: save.title || null,
    content: save.content || null,
    id: source.memory_id || null,
    memory_id: source.memory_id || null,
    file_path: source.file_path || null,
    document_title: source.title || null,
    valid_at: time.valid_at || null,
    tags: retrieval.tags,
    memory_type: retrieval.memory_types?.length === 1 ? retrieval.memory_types[0] : null,
    limit: retrieval.limit,
    since: time.start || null,
    created_after: time.start || null,
    created_before: time.end || null,
    scope: retrieval.scope_filter || null,
    mode: plan.recall_mode || null,
    project: plan.project_id || null,
    return_samples: retrieval.limit,
  };
}

/**
 * Project the language-neutral plan into the selected canonical tool schema.
 * This is deliberately schema-driven: it never parses phrases or invents
 * provider-specific fields, and undeclared values cannot reach execution.
 */
export function bindNativeMetaArguments(plan, schema) {
  const parameters = schema?.function?.parameters || {};
  const properties = parameters.properties || {};
  const pool = semanticArgumentPool(plan);
  const args = {};
  for (const name of Object.keys(properties)) {
    const value = pool[name];
    if (value !== undefined && value !== null && (!Array.isArray(value) || value.length)) args[name] = value;
  }
  const unresolved = (parameters.required || []).filter((name) => (
    args[name] === undefined || args[name] === null || args[name] === ''
  ));
  return Object.freeze({ args: Object.freeze(args), unresolved: Object.freeze(unresolved) });
}
