// Connector Runtime V1 — Notion plugin (connector-wise script).
// MCP-backed (wraps the existing MCP runner for the notion connector). Canonical
// <connector>__<operation> names; provider tool names are the Notion MCP
// registrations (refine at first live tools/list inspect — a wrong name fails
// gracefully as a structured result, never a crash, and legacy falls through).
import { McpBackedPlugin, mcpRead, mcpWrite } from '../mcp-backed-base.js';

const MAP = Object.freeze({
  notion__search: 'notion-search',
  notion__get_page: 'notion-fetch',
  notion__create_page: 'notion-create-pages',
  notion__update_page: 'notion-update-page',
  notion__create_comment: 'notion-create-comment',
});

export const NOTION_MANIFEST = {
  id: 'notion',
  version: '1.0.0',
  displayName: 'Notion',
  description: 'Search and read authorized Notion pages; create/update behind approval',
  authProvider: 'notion',
  connectionAliases: ['notion'],
  supportedSurfaces: ['chat', 'hyperagents', 'mcp', 'admin'],
  syncMode: 'none',
  tools: [
    mcpRead('notion__search', 'Search the connected Notion workspace. args: { query, max? }.',
      { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'] },
      'notion-search', ['chat', 'hyperagents', 'mcp', 'admin']),
    mcpRead('notion__get_page', 'Fetch a Notion page by id/url. args: { id }.',
      { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] },
      'notion-fetch', ['chat', 'hyperagents', 'mcp', 'admin']),
    mcpWrite('notion__create_page', 'Create a Notion page. Requires approval.',
      { type: 'object', additionalProperties: false, properties: { parent_id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['title'] },
      'notion-create-pages'),
    mcpWrite('notion__update_page', 'Update a Notion page. Requires approval.',
      { type: 'object', additionalProperties: false, properties: { page_id: { type: 'string' }, content: { type: 'string' } }, required: ['page_id'] },
      'notion-update-page'),
    mcpWrite('notion__create_comment', 'Comment on a Notion page. Requires approval.',
      { type: 'object', additionalProperties: false, properties: { page_id: { type: 'string' }, text: { type: 'string' } }, required: ['page_id', 'text'] },
      'notion-create-comment'),
  ],
};

export function createNotionPlugin(deps = {}) {
  return new McpBackedPlugin(NOTION_MANIFEST, MAP, deps);
}
