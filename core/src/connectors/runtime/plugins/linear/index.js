// Connector Runtime V1 — Linear plugin (connector-wise script). MCP-backed.
// Provider tool names = Linear MCP registrations (refine at first live inspect).
import { McpBackedPlugin, mcpRead, mcpWrite } from '../mcp-backed-base.js';

const MAP = Object.freeze({
  linear__search_issues: 'linear_search_issues',
  linear__get_issue: 'linear_get_issue',
  linear__list_projects: 'linear_list_projects',
  linear__create_issue: 'linear_create_issue',
  linear__update_issue: 'linear_update_issue',
});

export const LINEAR_MANIFEST = {
  id: 'linear',
  version: '1.0.0',
  displayName: 'Linear',
  description: 'Search and read authorized Linear issues/projects; create/update behind approval',
  authProvider: 'linear',
  connectionAliases: ['linear'],
  supportedSurfaces: ['chat', 'hyperagents', 'mcp', 'admin'],
  syncMode: 'none',
  tools: [
    mcpRead('linear__search_issues', 'Search Linear issues. args: { query, max? }.',
      { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'] },
      'linear_search_issues', ['chat', 'hyperagents', 'mcp', 'admin']),
    mcpRead('linear__get_issue', 'Fetch a Linear issue. args: { id }.',
      { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] },
      'linear_get_issue', ['chat', 'hyperagents', 'mcp', 'admin']),
    mcpRead('linear__list_projects', 'List Linear projects.',
      { type: 'object', additionalProperties: false, properties: { max: { type: 'integer', minimum: 1, maximum: 100 } } },
      'linear_list_projects', ['chat', 'hyperagents', 'mcp', 'admin']),
    mcpWrite('linear__create_issue', 'Create a Linear issue. Requires approval.',
      { type: 'object', additionalProperties: false, properties: { team_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['title'] },
      'linear_create_issue'),
    mcpWrite('linear__update_issue', 'Update a Linear issue. Requires approval.',
      { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, state: { type: 'string' }, description: { type: 'string' } }, required: ['id'] },
      'linear_update_issue'),
  ],
};

export function createLinearPlugin(deps = {}) {
  return new McpBackedPlugin(LINEAR_MANIFEST, MAP, deps);
}
