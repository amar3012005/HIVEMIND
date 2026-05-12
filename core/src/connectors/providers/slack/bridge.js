/**
 * Slack Bridge — live Web API access for HIVEMIND chat fallback and MCP tools.
 *
 * Goals:
 * - White-labelled: callers see HIVEMIND, never raw Slack API surface.
 * - Token retrieval via ConnectorStore.getAccessToken(userId, 'slack').
 * - Rate-limit aware: 429 → Retry-After honoured, single retry.
 * - Stateless: each call resolves a fresh token.
 *
 * Used by:
 * - /api/chat fallback (search.messages when local recall is thin)
 * - Future MCP tools (hivemind_slack_search/send/history/thread)
 */

const SLACK_API = 'https://slack.com/api';

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Detect whether a user query likely refers to Slack content.
 * Returns true if any signal matches; false otherwise.
 */
export function slackShapeDetector(query) {
  if (!query || typeof query !== 'string') return false;
  const q = query.toLowerCase();
  const PATTERNS = [
    /\bslack\b/,
    /\b(channel|dm|direct message|thread)\b/,
    /\b(yesterday|today|last (week|monday|tuesday|wednesday|thursday|friday)|recent(ly)?)\b/,
    /\b(team|teammate|coworker|colleague)\b/,
    /\b(what did|did anyone|who said|who mentioned|conversation about|discussion about)\b/,
    /@[\w.-]+/,
    /#[\w-]+/,
  ];
  return PATTERNS.some(p => p.test(q));
}

export class SlackBridge {
  /**
   * @param {Object} deps
   * @param {Object} deps.connectorStore - instance with getAccessToken(userId, provider)
   */
  constructor({ connectorStore }) {
    if (!connectorStore) throw new Error('SlackBridge: connectorStore required');
    this.connectorStore = connectorStore;
  }

  async _token(userId) {
    const t = await this.connectorStore.getAccessToken(userId, 'slack');
    if (!t) {
      const err = new Error('Slack not connected for user');
      err.code = 'SLACK_NOT_CONNECTED';
      throw err;
    }
    return t;
  }

  /**
   * Slack issues two tokens at install time: a bot token (xoxb-…) and a user
   * token (xoxp-…). Some methods — notably search.messages — only accept user
   * tokens. The user token is persisted in provider_metadata.user_access_token.
   * Fall back to the bot token if no user token is available.
   */
  async _userToken(userId) {
    try {
      const conn = await this.connectorStore.getConnector?.(userId, 'slack');
      const meta = conn?.provider_metadata || {};
      if (meta.user_access_token) return meta.user_access_token;
    } catch {}
    return this._token(userId);
  }

  /**
   * Low-level Slack Web API call with 429 retry.
   * @param {string} method e.g. 'search.messages'
   * @param {Object} params
   * @param {string} token bearer
   * @param {string} httpMethod 'GET' | 'POST'
   */
  async _call(method, params, token, httpMethod = 'GET') {
    const url = `${SLACK_API}/${method}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let res;
    try {
      if (httpMethod === 'POST') {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(params || {})) {
          if (v != null) body.set(k, String(v));
        }
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
          signal: controller.signal,
        });
      } else {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params || {})) {
          if (v != null) qs.set(k, String(v));
        }
        const full = qs.toString() ? `${url}?${qs}` : url;
        res = await fetch(full, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
      }
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10) * 1000;
      console.warn(`[slack-bridge] 429 on ${method}, retry in ${retryAfter}ms`);
      await new Promise(r => setTimeout(r, retryAfter));
      return this._call(method, params, token, httpMethod);
    }

    if (!res.ok) {
      const e = new Error(`Slack ${method} HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }

    const data = await res.json();
    if (!data.ok) {
      const e = new Error(`Slack ${method} error: ${data.error}`);
      e.code = data.error;
      throw e;
    }
    return data;
  }

  /**
   * Full-text search across the user's Slack workspace.
   * Requires scope: search:read.
   */
  async searchMessages(userId, query, opts = {}) {
    // search.messages requires a user token (search:read is a user-only scope)
    const token = await this._userToken(userId);
    const data = await this._call('search.messages', {
      query,
      count: opts.count || 10,
      sort: opts.sort || 'timestamp',
      sort_dir: opts.sortDir || 'desc',
      highlight: 0,
    }, token, 'GET');
    const matches = data.messages?.matches || [];
    return matches.map(m => ({
      text: m.text,
      user: m.user,
      username: m.username,
      channel_id: m.channel?.id,
      channel_name: m.channel?.name,
      ts: m.ts,
      permalink: m.permalink,
      iid: m.iid,
    }));
  }

  /**
   * Channel history since a timestamp.
   * Requires scope: channels:history (or groups/im/mpim equivalents).
   */
  async getChannelHistory(userId, channelId, opts = {}) {
    const token = await this._token(userId);
    const data = await this._call('conversations.history', {
      channel: channelId,
      oldest: opts.since || undefined,
      latest: opts.until || undefined,
      limit: opts.limit || 50,
      inclusive: opts.inclusive ? 1 : 0,
    }, token, 'GET');
    return data.messages || [];
  }

  /**
   * Single thread's replies.
   */
  async getThread(userId, channelId, ts, opts = {}) {
    const token = await this._token(userId);
    const data = await this._call('conversations.replies', {
      channel: channelId,
      ts,
      limit: opts.limit || 200,
    }, token, 'GET');
    return data.messages || [];
  }

  /**
   * Post a message. Requires scope: chat:write.
   *
   * Per-message identity override (Digital Employees one-app pattern):
   *   opts.username   — overrides bot display name (needs chat:write.customize)
   *   opts.iconUrl    — overrides avatar with a hosted image
   *   opts.iconEmoji  — overrides avatar with an emoji (e.g. ":robot_face:")
   * Only set when caller (e.g. employees-service) supplies them; otherwise
   * Slack falls back to the app's default identity.
   */
  async postMessage(userId, channel, text, opts = {}) {
    const token = await this._token(userId);
    return this._call('chat.postMessage', {
      channel,
      text,
      thread_ts: opts.threadTs || undefined,
      mrkdwn: opts.mrkdwn !== false ? 1 : 0,
      username: opts.username || undefined,
      icon_url: opts.iconUrl || undefined,
      icon_emoji: opts.iconEmoji || undefined,
    }, token, 'POST');
  }

  /**
   * Resolve a Slack user by ID or email.
   */
  async getUser(userId, identifier) {
    const token = await this._token(userId);
    const isEmail = /@/.test(identifier);
    const method = isEmail ? 'users.lookupByEmail' : 'users.info';
    const params = isEmail ? { email: identifier } : { user: identifier };
    const data = await this._call(method, params, token, 'GET');
    return data.user || null;
  }

  /**
   * List canvases in workspace.
   */
  async listCanvases(userId, opts = {}) {
    const token = await this._token(userId);
    const data = await this._call('canvases.list', {
      limit: opts.limit || 100,
    }, token, 'GET');
    return data.canvases || [];
  }
}

/**
 * Format a slack search hit for inline LLM context.
 */
export function formatSlackHitForContext(hit) {
  const who = hit.username || hit.user || 'unknown';
  const where = hit.channel_name ? `#${hit.channel_name}` : (hit.channel_id || '');
  const when = hit.ts ? new Date(parseFloat(hit.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
  const text = (hit.text || '').replace(/\s+/g, ' ').slice(0, 400);
  return `[live-slack] ${where} · ${who}${when ? ' · ' + when : ''}: ${text}`;
}
