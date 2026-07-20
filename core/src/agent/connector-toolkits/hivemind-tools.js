/**
 * AgentScope-style registration adapter for native HIVEMIND capabilities.
 * Connector and native tools now share the same Toolkit contract, directory,
 * schema exposure, group activation, middleware, and execution surface.
 */
import { TOOL_SCHEMAS, dispatchTool } from '../tool-registry.js';

const WRITE_TOOLS = new Set([
  'hivemind_save_memory', 'hivemind_update_memory', 'hivemind_delete_memory',
  'hivemind_log_decision', 'hivemind_set_assistant_name',
]);

const GROUPS = {
  'hivemind-recall': {
    description: 'Tenant-scoped HIVEMIND memory, evidence, exact-source, entity aggregation, temporal recall and graph retrieval.',
    tools: new Set(['hivemind_recall', 'hivemind_relation_between', 'hivemind_aggregate_entities', 'hivemind_get_memory', 'hivemind_list_memories', 'hivemind_traverse_graph', 'hivemind_at', 'hivemind_diff', 'hivemind_timeline', 'hivemind_query_with_ai', 'get_user_profile']),
  },
  'hivemind-memory-write': {
    description: 'Versioned HIVEMIND memory creation, update, deletion, decisions and assistant identity. Mutations are scoped and approval/policy checked.',
    tools: new Set(['hivemind_save_memory', 'hivemind_update_memory', 'hivemind_delete_memory', 'hivemind_log_decision', 'hivemind_set_assistant_name', 'update_user_profile']),
  },
  'hivemind-projects': {
    description: 'Authorized project discovery and project-aware memory placement.',
    tools: new Set(['hivemind_list_projects']),
  },
  'hivemind-web': {
    description: 'Explicit external web research and asynchronous crawl jobs.',
    tools: new Set(['hivemind_web_search', 'hivemind_web_crawl', 'hivemind_web_job_status']),
  },
  'hivemind-engineering': {
    description: 'Engineering memory, bugs, code history and decision provenance.',
    tools: new Set(['hivemind_recall_bugs', 'hivemind_code_at', 'hivemind_why_code']),
  },
};

function groupFor(name) {
  return Object.entries(GROUPS).find(([, group]) => group.tools.has(name))?.[0] || 'hivemind-recall';
}

export function getHivemindToolCatalog() {
  return Object.entries(GROUPS).map(([name, group]) => ({
    name,
    description: group.description,
    tools: TOOL_SCHEMAS.filter((schema) => groupFor(schema.function.name) === name).map((schema) => ({
      name: schema.function.name,
      description: schema.function.description,
      readOnly: !WRITE_TOOLS.has(schema.function.name),
    })),
  }));
}

export function registerHivemindTools(toolkit, { selectedGroups = null } = {}) {
  const selected = selectedGroups ? new Set(selectedGroups) : null;
  for (const [name, group] of Object.entries(GROUPS)) {
    if (selected && !selected.has(name)) continue;
    toolkit.createToolGroup({ name, description: group.description, active: false });
  }
  for (const schema of TOOL_SCHEMAS) {
    const fn = schema.function;
    const groupName = groupFor(fn.name);
    if (selected && !selected.has(groupName)) continue;
    const readOnly = !WRITE_TOOLS.has(fn.name);
    toolkit.registerToolFunction({
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
      groupName,
      readOnly,
      concurrencySafe: readOnly,
      handler: (args, ctx) => dispatchTool(fn.name, args, ctx),
    });
  }
}
