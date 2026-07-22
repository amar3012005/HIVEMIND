// Connector Runtime V1 — GitHub plugin (connector-wise script). MCP-backed.
// Provider tool names = GitHub MCP registrations (refine at first live inspect).
import { McpBackedPlugin, mcpRead, mcpWrite } from '../mcp-backed-base.js';

const MAP = Object.freeze({
  github__search_issues: 'github_search_issues',
  github__get_issue: 'github_get_issue',
  github__search_code: 'github_search_code',
  github__create_issue: 'github_create_issue',
  github__comment_issue: 'github_add_issue_comment',
});

export const GITHUB_MANIFEST = {
  id: 'github',
  version: '1.0.0',
  displayName: 'GitHub',
  description: 'Search and read authorized GitHub issues/code; create/comment behind approval',
  authProvider: 'github',
  connectionAliases: ['github'],
  supportedSurfaces: ['chat', 'hyperagents', 'mcp', 'admin'],
  syncMode: 'none',
  tools: [
    mcpRead('github__search_issues', 'Search GitHub issues/PRs. args: { query, max? }.',
      { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'] },
      'github_search_issues', ['chat', 'hyperagents', 'mcp', 'admin']),
    mcpRead('github__get_issue', 'Fetch a GitHub issue. args: { repo, number }.',
      { type: 'object', additionalProperties: false, properties: { repo: { type: 'string' }, number: { type: 'integer' } }, required: ['repo', 'number'] },
      'github_get_issue', ['chat', 'hyperagents', 'mcp', 'admin']),
    mcpRead('github__search_code', 'Search code in authorized GitHub repos. args: { query, max? }.',
      { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'] },
      'github_search_code', ['chat', 'hyperagents', 'mcp', 'admin']),
    mcpWrite('github__create_issue', 'Create a GitHub issue. Requires approval.',
      { type: 'object', additionalProperties: false, properties: { repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['repo', 'title'] },
      'github_create_issue'),
    mcpWrite('github__comment_issue', 'Comment on a GitHub issue. Requires approval.',
      { type: 'object', additionalProperties: false, properties: { repo: { type: 'string' }, number: { type: 'integer' }, body: { type: 'string' } }, required: ['repo', 'number', 'body'] },
      'github_add_issue_comment'),
  ],
};

export function createGithubPlugin(deps = {}) {
  return new McpBackedPlugin(GITHUB_MANIFEST, MAP, deps);
}
