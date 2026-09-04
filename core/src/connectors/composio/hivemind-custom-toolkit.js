/**
 * Composio custom-toolkit spec for native HIVEMIND chat tools.
 *
 * Same inventory and group filters as use_tools:false (`registerHivemindTools`).
 * Schemas come from TOOL_SCHEMAS. Execute stays in-process via dispatchTool:
 * Composio session custom tools cannot run HIVEMIND on Composio's cloud.
 */
import { HIVEMIND_TOOL_GROUPS, WRITE_TOOLS, hivemindGroupFor } from '../../agent/connector-toolkits/hivemind-tool-groups.js';

export const HIVEMIND_COMPOSIO_TOOLKIT_SLUG = 'HIVEMIND';

const PRELOAD_NATIVE = new Set([
  'hivemind_recall',
  'hivemind_list_projects',
  'get_user_profile',
  'hivemind_get_memory',
  'hivemind_list_memories',
]);

async function loadToolSchemas() {
  const { TOOL_SCHEMAS } = await import('../../agent/tool-registry.js');
  return TOOL_SCHEMAS;
}

export function nativeNameFromComposioSlug(slug) {
  let raw = String(slug || '').trim().replace(/^LOCAL_/, '');
  if (raw.startsWith('HIVEMIND_HIVEMIND_')) raw = raw.slice('HIVEMIND_'.length);
  return raw.toLowerCase();
}

export function composioSlugFromNativeName(name) {
  return String(name || '').trim().toUpperCase();
}

export function buildHivemindCustomToolkit({ selectedGroups = null, schemas = [] } = {}) {
  const selected = selectedGroups?.length ? new Set(selectedGroups) : null;
  const tools = [];
  for (const schema of schemas) {
    const native = schema.function.name;
    const group = hivemindGroupFor(native);
    if (!group) continue;
    if (selected && !selected.has(group)) continue;
    tools.push({
      slug: composioSlugFromNativeName(native),
      original_slug: native,
      name: native.replace(/_/g, ' '),
      description: String(schema.function.description || native).slice(0, 4096),
      group,
      read_only: !WRITE_TOOLS.has(native),
      preload: PRELOAD_NATIVE.has(native),
      input_schema: schema.function.parameters || { type: 'object', properties: {} },
      output_schema: { type: 'object', additionalProperties: true },
    });
  }
  return {
    slug: HIVEMIND_COMPOSIO_TOOLKIT_SLUG,
    name: 'HIVEMIND',
    description: 'Native HIVEMIND memory, projects, web, and engineering tools. Same filters as use_tools:false chat.',
    preload: true,
    no_auth: true,
    tools,
  };
}

export async function loadHivemindCustomToolkit(opts = {}) {
  const schemas = opts.schemas || await loadToolSchemas();
  return buildHivemindCustomToolkit({ ...opts, schemas });
}

export function composioSessionExperimentalFromToolkit(toolkit) {
  const spec = toolkit || buildHivemindCustomToolkit({ schemas: [] });
  return {
    custom_toolkits: [{
      slug: spec.slug,
      name: spec.name,
      description: spec.description,
      preload: spec.preload,
      tools: spec.tools.map((tool) => ({
        slug: tool.slug,
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        output_schema: tool.output_schema,
        original_slug: tool.original_slug,
        preload: tool.preload,
      })),
    }],
  };
}

export async function executeHivemindCustomTool(slug, args, ctx) {
  const { TOOL_SCHEMAS, dispatchTool } = await import('../../agent/tool-registry.js');
  let native = nativeNameFromComposioSlug(slug);
  if (!TOOL_SCHEMAS.some((schema) => schema.function.name === native)) {
    const prefixed = native.startsWith('hivemind_') ? native : `hivemind_${native}`;
    if (TOOL_SCHEMAS.some((schema) => schema.function.name === prefixed)) native = prefixed;
  }
  if (!TOOL_SCHEMAS.some((schema) => schema.function.name === native)) {
    return { successful: false, data: null, error: `unknown hivemind tool: ${slug}` };
  }
  const result = await dispatchTool(native, args || {}, ctx);
  if (result?.error) return { successful: false, data: result, error: result.error };
  return { successful: true, data: result, error: null };
}
