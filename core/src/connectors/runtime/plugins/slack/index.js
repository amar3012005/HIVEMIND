// Connector Runtime V1 — Slack plugin (connector-wise script).
// Wraps the existing MCPIngestionService internal Slack bridge (execSlackReadTool
// for reads). Reads immediate; post_message is a write → approval-gated.
// Provider tool names are the concrete slack-tools.js registrations.

import { McpBackedPlugin, mcpRead, mcpWrite } from '../mcp-backed-base.js';

const MAP = Object.freeze({
  slack__search: 'slack_search_messages',
  slack__list_channels: 'slack_list_channels',
  slack__get_history: 'slack_channel_history',
  slack__read_thread: 'slack_read_thread',
  slack__post_message: 'slack_post_message',
});

export const SLACK_MANIFEST = {
  id: 'slack',
  version: '1.0.0',
  displayName: 'Slack',
  description: 'Search, read, and post to authorized Slack workspaces',
  authProvider: 'slack',
  connectionAliases: ['slack'],
  supportedSurfaces: ['chat', 'hyperagents', 'mcp', 'admin'],
  syncMode: 'none',
  tools: [
    mcpRead('slack__search', 'Search Slack messages. args: { query, max? }.',
      { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'] },
      'slack_search_messages', ['chat', 'hyperagents', 'mcp', 'admin']),
    mcpRead('slack__list_channels', 'List Slack channels the user can access.',
      { type: 'object', additionalProperties: false, properties: { max: { type: 'integer', minimum: 1, maximum: 200 } } },
      'slack_list_channels', ['chat', 'hyperagents', 'mcp', 'admin']),
    mcpRead('slack__get_history', 'Read recent messages in a Slack channel. args: { channel_id, max? }.',
      { type: 'object', additionalProperties: false, properties: { channel_id: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['channel_id'] },
      'slack_channel_history', ['chat', 'hyperagents', 'mcp', 'admin']),
    mcpRead('slack__read_thread', 'Read a Slack thread. args: { channel_id, thread_ts }.',
      { type: 'object', additionalProperties: false, properties: { channel_id: { type: 'string' }, thread_ts: { type: 'string' } }, required: ['channel_id', 'thread_ts'] },
      'slack_read_thread', ['chat', 'hyperagents', 'mcp', 'admin']),
    mcpWrite('slack__post_message', 'Post a message to a Slack channel. args: { channel_id, message }. Requires approval.',
      { type: 'object', additionalProperties: false, properties: { channel_id: { type: 'string' }, message: { type: 'string' } }, required: ['channel_id', 'message'] },
      'slack_post_message'),
  ],
};

export function createSlackPlugin(deps = {}) {
  return new McpBackedPlugin(SLACK_MANIFEST, MAP, deps);
}
