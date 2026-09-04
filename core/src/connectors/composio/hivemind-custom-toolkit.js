/**
 * Composio custom-toolkit spec for native HIVEMIND chat tools.
 *
 * Same inventory and group filters as use_tools:false (`registerHivemindTools`).
 * Schemas come from TOOL_SCHEMAS. Execute stays in-process via dispatchTool:
 * Composio session custom tools cannot run HIVEMIND on Composio's cloud.
 */
import { HIVEMIND_TOOL_GROUPS, WRITE_TOOLS, hivemindGroupFor } from '../../agent/connector-toolkits/hivemind-tool-groups.js';

export const HIVEMIND_COMPOSIO_TOOLKIT_SLUG = 'HIVEMIND';

export const HIVEMIND_COMPOSIO_TOOLKIT_DESCRIPTION =
  'HIVEMIND is the tenant company brain and memory engine. Use it to recall company facts, org/user profile, stored memories, and projects BEFORE drafting or sending email or sharing in other apps. No OAuth. These tools run in-process on HIVEMIND, not on Composio cloud. Prefer HIVEMIND recall/profile for company information instead of YouTube, LinkedIn, GitHub, or Gmail search unless the user named those apps.';

const PRELOAD_NATIVE = new Set([
  'hivemind_recall',
  'hivemind_list_projects',
  'get_user_profile',
  'hivemind_get_memory',
  'hivemind_list_memories',
]);

/** Composio search-planner hints prepended to native TOOL_SCHEMAS descriptions. */
const COMPOSIO_TOOL_HINTS = {
  hivemind_recall:
    'PRIMARY company-brain retrieval. Call this FIRST when the user wants to send, share, draft, or brief someone about the company, products, mission, org facts, or anything stored in HIVEMIND memory. The query is the information need (for example "company information"), not the email send itself.',
  get_user_profile:
    'Return the current user and organization profile: company name, mission, role, ICP, location. Use when drafting a message about the company or the sender.',
  hivemind_get_memory:
    'Fetch the full text of one HIVEMIND memory after recall returned an id. Use to expand a company-fact snippet before putting it in an email draft.',
  hivemind_list_memories:
    'List stored HIVEMIND memories about a topic (company, project, person). Use when recall needs a broader inventory of company facts.',
  hivemind_list_projects:
    'List HIVEMIND projects (sub-brains) the user can access. Use when company information may live in a named project.',
};

/** Composio rejects object fields that have no properties/additionalProperties. */
export function composioSafeInputSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const out = { ...schema };
  if (out.items && typeof out.items === 'object') out.items = composioSafeInputSchema(out.items);
  const isObject = out.type === 'object' || (!out.type && (out.properties || out.additionalProperties || out.description));
  if (isObject) {
    if (!out.type) out.type = 'object';
    const hadProperties = Boolean(schema.properties && typeof schema.properties === 'object');
    if (!hadProperties) {
      out.properties = {};
      if (!out.additionalProperties) out.additionalProperties = { type: 'string' };
    }
    const props = {};
    for (const [key, value] of Object.entries(out.properties || {})) {
      props[key] = composioSafeInputSchema(value);
    }
    out.properties = props;
  }
  return out;
}

export function composioFacingDescription(native, schemaDescription) {
  const hint = COMPOSIO_TOOL_HINTS[native];
  const body = String(schemaDescription || native).trim();
  if (!hint) return body.slice(0, 4096);
  return `${hint}\n\n${body}`.slice(0, 4096);
}

async function loadToolSchemas() {
  const { TOOL_SCHEMAS } = await import('../../agent/tool-registry.js');
  return TOOL_SCHEMAS;
}

export function nativeNameFromComposioSlug(slug) {
  let raw = String(slug || '').trim().replace(/^LOCAL_/, '');
  if (raw.startsWith('HIVEMIND_HIVEMIND_')) raw = raw.slice('HIVEMIND_'.length);
  let native = raw.toLowerCase();
  if (native === 'hivemind_get_user_profile' || native === 'get_user_profile') return 'get_user_profile';
  if (native === 'hivemind_update_user_profile' || native === 'update_user_profile') return 'update_user_profile';
  if (native === 'recall') return 'hivemind_recall';
  return native;
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
      description: composioFacingDescription(native, schema.function.description),
      group,
      read_only: !WRITE_TOOLS.has(native),
      preload: PRELOAD_NATIVE.has(native),
      input_schema: composioSafeInputSchema(schema.function.parameters || { type: 'object', properties: {} }),
      output_schema: { type: 'object', additionalProperties: true },
    });
  }
  return {
    slug: HIVEMIND_COMPOSIO_TOOLKIT_SLUG,
    name: 'HIVEMIND',
    description: HIVEMIND_COMPOSIO_TOOLKIT_DESCRIPTION,
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
      tools: spec.tools.filter((tool) => tool.preload).map((tool) => ({
        slug: tool.slug,
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        output_schema: tool.output_schema,
        original_slug: tool.original_slug,
        preload: true,
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
