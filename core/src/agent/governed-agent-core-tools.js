import { capabilityCard } from './governed-agent-contract.js';

/**
 * The governed graph owns Core capabilities directly.  They are deliberately
 * separate from Composio custom toolkits: Core remains the authority for
 * memory and profile reads, while a Composio session remains the authority for
 * a connected application.  The narrow allowlist is a policy boundary, not a
 * provider-specific routing table.
 */
const CORE_READ_CAPABILITIES = new Set([
  'hivemind_recall',
  'hivemind_get_memory',
  'hivemind_list_memories',
  'hivemind_list_projects',
  'get_user_profile',
]);

// This is intentionally a tiny contract mirror, rather than importing the
// full Core tool registry at graph admission. The registry initializes native
// retrieval dependencies; loading it just to render five capability cards can
// make an otherwise external-only turn fail before planning. Execution still
// dispatches through the canonical registry below.
const CORE_READ_CARDS = Object.freeze([
  {
    name: 'hivemind_recall',
    description: 'Tenant-scoped memory and evidence retrieval for a question.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The evidence question to retrieve.' },
        mode: { type: 'string', enum: ['fact', 'explain', 'quick', 'panorama', 'insight'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
  },
  {
    name: 'hivemind_get_memory',
    description: 'Fetch full content for a memory already identified by a prior Core receipt.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'hivemind_list_memories',
    description: 'List the authenticated user’s memories with optional tags, type, time, or limit filters.',
    parameters: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        memory_type: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, since: { type: 'string' },
      },
    },
  },
  {
    name: 'hivemind_list_projects',
    description: 'List projects the authenticated user can access.',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'get_user_profile',
    description: 'Read the maintained profile of the authenticated user and organization.',
    parameters: { type: 'object', properties: {} },
  },
]);

export function loadGovernedCoreCapabilities() {
  return CORE_READ_CARDS.map(card => capabilityCard({
      tool: { slug: card.name, function: { description: card.description, parameters: card.parameters } },
      schema: { toolkit: 'hivemind', description: card.description, input_schema: card.parameters },
      source: 'core',
      authority: 'read',
    }));
}

export async function executeGovernedCoreRead(slug, args, ctx) {
  const name = String(slug || '').trim();
  if (!CORE_READ_CAPABILITIES.has(name)) {
    return { successful: false, data: null, error: 'governed_core_capability_denied' };
  }
  try {
    // Most production requests arrive with the canonical traced dispatcher.
    // Do not even initialize the full registry in that case: importing it at
    // graph admission can load native retrieval dependencies that this tool
    // invocation does not need. The dynamic fallback retains the canonical
    // Core registry as the authority when no dispatcher was supplied.
    const dispatch = ctx?._tracedDispatch;
    let result;
    if (typeof dispatch === 'function') {
      result = await dispatch(name, args || {}, ctx);
    } else {
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
