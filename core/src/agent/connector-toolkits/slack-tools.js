/**
 * Slack tool group — NATIVE (bot-token) Slack tools on the Toolkit.
 *
 * Slack OAuth moved off Nango to the native v2 bot flow
 * (control-plane /v1/connectors/slack/start → PlatformIntegration row with an
 * encrypted bot token + a search:read user token in provider_metadata). The
 * old slack MCP group resolved its bearer through Nango and therefore failed
 * token resolution on every chat turn for natively-connected users. This
 * group talks to the Slack Web API directly through SlackBridge, which
 * resolves tokens via ConnectorStore (Nango-first with native fallback), so
 * it works for BOTH auth generations.
 *
 * Tools stay INACTIVE until the agent activates the group via
 * reset_equipped_tools({ group_names: ['slack'] }). Write tools
 * (slack_post_message) are readOnly:false → routed through draft-approval —
 * nothing posts to Slack without the user clicking Approve.
 */

import { SlackBridge } from '../../connectors/providers/slack/bridge.js';

const SKILL_NOTES = [
  'SLACK TOOLS — read and act on the user\'s connected Slack workspace.',
  '  • slack_search_messages(query) — full-text search across the workspace (Slack search syntax: from:@name, in:#channel, after:2026-01-01).',
  '  • slack_list_channels() — channels the bot can see, with ids. Use to resolve a channel name to an id.',
  '  • slack_channel_history(channel_id, limit?) — recent messages in a channel. Pass the C… id from slack_list_channels.',
  '  • slack_read_thread(channel_id, thread_ts) — full reply thread for a message.',
  '  • slack_post_message(channel_id, text, thread_ts?) — POSTS to Slack. Routes through draft-approval — user must Approve before anything is sent.',
  'Search first, read second, post only when the user explicitly asked to send something.',
].join('\n');

/**
 * @param {import('../toolkit.js').Toolkit} toolkit
 * @param {{ connectorStore: any, userId: string }} deps
 */
export function registerSlackTools(toolkit, { connectorStore, userId }) {
  const bridge = new SlackBridge({ connectorStore });

  toolkit.createToolGroup({
    name: 'slack',
    description: 'Slack workspace tools — search, channel history, threads, post (native bot token).',
    active: false,
    notes: SKILL_NOTES,
  });

  toolkit.registerToolFunction({
    name: 'slack_search_messages',
    description: 'Full-text search the user\'s Slack workspace (Slack search syntax: from:@name, in:#channel, after:YYYY-MM-DD). Returns matching messages with channel + permalink.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Slack search query' },
        count: { type: 'number', description: 'Max results (default 10, max 20)' },
      },
      required: ['query'],
    },
    groupName: 'slack',
    readOnly: true,
    handler: async ({ query, count = 10 }) => {
      const res = await bridge.searchMessages(userId, query, { count: Math.min(count, 20) });
      const matches = (res?.matches || res || []).slice?.(0, Math.min(count, 20)) || [];
      if (!matches.length) return { text: 'No Slack messages matched that query.' };
      const lines = matches.map((m) => {
        const ch = m.channel?.name ? `#${m.channel.name}` : (m.channel?.id || m.channel || '?');
        return `[${ch}] ${m.username || m.user || '?'}: ${(m.text || '').slice(0, 300)}${m.permalink ? `\n  ${m.permalink}` : ''}`;
      });
      return { text: lines.join('\n\n') };
    },
  });

  toolkit.registerToolFunction({
    name: 'slack_list_channels',
    description: 'List Slack channels visible to the HIVEMIND bot (name + id). Use to resolve a channel name to a C… id before history/post.',
    parameters: { type: 'object', properties: {} },
    groupName: 'slack',
    readOnly: true,
    handler: async () => {
      const token = await bridge._token(userId);
      const data = await bridge._call('conversations.list', {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 100,
      }, token, 'GET');
      const chans = (data.channels || []).map((c) => `#${c.name} (${c.id})${c.is_member ? ' [bot is member]' : ''}`);
      return { text: chans.length ? chans.join('\n') : 'No channels visible to the bot.' };
    },
  });

  toolkit.registerToolFunction({
    name: 'slack_channel_history',
    description: 'Recent messages in a Slack channel. channel_id is the C… id (use slack_list_channels to resolve names).',
    parameters: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Slack channel id (C…)' },
        limit: { type: 'number', description: 'Messages to return (default 20, max 50)' },
      },
      required: ['channel_id'],
    },
    groupName: 'slack',
    readOnly: true,
    handler: async ({ channel_id, limit = 20 }) => {
      const msgs = await bridge.getChannelHistory(userId, channel_id, { limit: Math.min(limit, 50) });
      const list = msgs?.messages || msgs || [];
      if (!list.length) return { text: 'No messages in that channel (or the bot is not a member — invite it first).' };
      const lines = list.map((m) => `${m.user || m.username || 'bot'} @ ${m.ts}: ${(m.text || '').slice(0, 280)}`);
      return { text: lines.join('\n') };
    },
  });

  toolkit.registerToolFunction({
    name: 'slack_read_thread',
    description: 'Read a full Slack reply thread. Pass the channel id and the thread_ts of the root message (from history/search).',
    parameters: {
      type: 'object',
      properties: {
        channel_id: { type: 'string' },
        thread_ts: { type: 'string', description: 'ts of the thread root message' },
      },
      required: ['channel_id', 'thread_ts'],
    },
    groupName: 'slack',
    readOnly: true,
    handler: async ({ channel_id, thread_ts }) => {
      const res = await bridge.getThread(userId, channel_id, thread_ts, { limit: 50 });
      const list = res?.messages || res || [];
      if (!list.length) return { text: 'Thread not found or empty.' };
      const lines = list.map((m) => `${m.user || m.username || 'bot'}: ${(m.text || '').slice(0, 300)}`);
      return { text: lines.join('\n') };
    },
  });

  toolkit.registerToolFunction({
    name: 'slack_post_message',
    description: 'Post a message to a Slack channel as HIVEMIND. Routes through draft-approval — the user must Approve before it is sent. Use ONLY when the user explicitly asked to post/send to Slack.',
    parameters: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Slack channel id (C…)' },
        text: { type: 'string', description: 'Message text (Slack mrkdwn supported)' },
        thread_ts: { type: 'string', description: 'Optional: reply in this thread' },
      },
      required: ['channel_id', 'text'],
    },
    groupName: 'slack',
    readOnly: false,
    handler: async ({ channel_id, text, thread_ts }) => {
      const res = await bridge.postMessage(userId, channel_id, text, thread_ts ? { thread_ts } : {});
      return { text: `Posted to ${channel_id} (ts ${res?.ts || '?'}).` };
    },
  });
}
