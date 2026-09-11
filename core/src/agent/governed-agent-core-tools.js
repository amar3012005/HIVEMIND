import { capabilityCard, capabilityRelevance } from './governed-agent-contract.js';
import { TOOL_SCHEMAS } from './tool-schemas.js';

const CORE_WRITE_CAPABILITIES = new Set([
  'hivemind_save_memory',
  'hivemind_update_memory',
  'hivemind_delete_memory',
  'hivemind_brand_dna',
  'hivemind_set_assistant_name',
  'update_user_profile',
  'hivemind_log_decision',
]);

const CORE_CAPABILITIES = new Set(TOOL_SCHEMAS.map(tool => tool?.function?.name).filter(Boolean));

export function coreCapabilityAuthority(slug) {
  return CORE_WRITE_CAPABILITIES.has(String(slug || '')) ? 'write' : 'read';
}

/** Compile the canonical Core registry without initializing retrieval engines. */
export function loadGovernedCoreCapabilities({ intent = null, limit = 8 } = {}) {
  const cards = TOOL_SCHEMAS.map(tool => {
    const parameters = tool.function.parameters || { type: 'object', properties: {} };
    const publicParameters = {
      ...parameters,
      properties: Object.fromEntries(Object.entries(parameters.properties || {}).filter(([field]) => !field.startsWith('_'))),
      ...(Array.isArray(parameters.required) ? { required: parameters.required.filter(field => !field.startsWith('_')) } : {}),
    };
    return capabilityCard({
      tool: { slug: tool.function.name, function: { ...tool.function, parameters: publicParameters } },
      schema: {
        toolkit: 'hivemind',
        description: tool.function.description,
        input_schema: publicParameters,
      },
      source: 'core',
      authority: coreCapabilityAuthority(tool.function.name),
    });
  });
  if (!intent) return cards;
  const baseline = new Set(['hivemind_recall', 'get_user_profile']);
  const selected = cards.filter(card => baseline.has(card.slug));
  const ranked = cards
    .filter(card => !baseline.has(card.slug))
    .map(card => ({ card, score: capabilityRelevance(card, { intent }) }))
    .sort((left, right) => right.score - left.score || left.card.slug.localeCompare(right.card.slug))
    .slice(0, Math.max(0, limit - selected.length))
    .map(row => row.card);
  return [...selected, ...ranked].slice(0, Math.max(1, limit));
}

export async function executeGovernedCoreTool(slug, args, ctx, { authority = null } = {}) {
  const name = String(slug || '').trim();
  if (!CORE_CAPABILITIES.has(name) || (authority && coreCapabilityAuthority(name) !== authority)) {
    return { successful: false, data: null, error: 'governed_core_capability_denied' };
  }
  try {
    const dispatch = ctx?._tracedDispatch;
    let result;
    if (typeof dispatch === 'function') result = await dispatch(name, args || {}, ctx);
    else {
      const { dispatchTool } = await import('./tool-registry.js');
      result = await dispatchTool(name, args || {}, ctx);
    }
    return result?.error
      ? { successful: false, data: result, error: String(result.error) }
      : { successful: true, data: result, error: null };
  } catch (error) {
    return { successful: false, data: null, error: String(error?.message || error).slice(0, 300) };
  }
}

export function executeGovernedCoreRead(slug, args, ctx) {
  return executeGovernedCoreTool(slug, args, ctx, { authority: 'read' });
}

export function executeGovernedCoreWrite(slug, args, ctx) {
  return executeGovernedCoreTool(slug, args, ctx, { authority: 'write' });
}
