/**
 * AgentScope-style registration adapter for native HIVEMIND capabilities.
 * Connector and native tools now share the same Toolkit contract, directory,
 * schema exposure, group activation, middleware, and execution surface.
 */
import { TOOL_SCHEMAS, dispatchTool } from '../tool-registry.js';
import { HIVEMIND_TOOL_GROUPS, WRITE_TOOLS, hivemindGroupFor } from './hivemind-tool-groups.js';

export { HIVEMIND_TOOL_GROUPS, WRITE_TOOLS };

function groupFor(name) {
  return hivemindGroupFor(name) || 'hivemind-recall';
}

export function getHivemindToolCatalog() {
  return Object.entries(HIVEMIND_TOOL_GROUPS).map(([name, group]) => ({
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
  for (const [name, group] of Object.entries(HIVEMIND_TOOL_GROUPS)) {
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
