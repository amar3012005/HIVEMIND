import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

const SLACK_API = 'https://slack.com/api';

export class SlackAdapter extends BaseProviderAdapter {
  constructor() {
    super({ providerId: 'slack', requiredScopes: ['channels:history'], defaultTags: ['slack'] });
  }

  async fetchInitial({ accessToken, cursor, context }) {
    const channelsRes = await this._slackFetch('conversations.list', { types: 'public_channel,private_channel', limit: 100 }, accessToken);
    const channels = channelsRes.channels || [];
    const records = [];

    for (const ch of channels.slice(0, 20)) {
      const params = { channel: ch.id, limit: 50 };
      if (cursor) params.oldest = cursor;
      const histRes = await this._slackFetch('conversations.history', params, accessToken);
      for (const msg of histRes.messages || []) {
        records.push({ ...msg, _channel: ch.name, _channel_id: ch.id });
      }
    }

    return { records, nextCursor: null, hasMore: false };
  }

  async fetchIncremental({ accessToken, cursor, context }) {
    return this.fetchInitial({ accessToken, cursor, context });
  }

  normalize(record, context) {
    const text = record.text || '';
    if (text.length < 10) return [];

    return [{
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content: text,
      title: `Slack: #${record._channel} — ${text.slice(0, 60)}`,
      tags: [...this.defaultTags, record._channel],
      memory_type: 'fact',
      document_date: record.ts ? new Date(parseFloat(record.ts) * 1000).toISOString() : null,
      source_metadata: {
        source_type: 'slack',
        source_platform: 'slack',
        source_id: `${record._channel_id}:${record.ts}`,
        thread_id: record.thread_ts || null,
      },
      metadata: { channel: record._channel, user: record.user, ts: record.ts },
    }];
  }

  dedupeKey(record) {
    return `slack:msg:${record._channel_id}:${record.ts}`;
  }

  async _slackFetch(method, params, token) {
    const qs = new URLSearchParams(params);
    const res = await fetch(`${SLACK_API}/${method}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { const e = new Error(`Slack API ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  }
}
