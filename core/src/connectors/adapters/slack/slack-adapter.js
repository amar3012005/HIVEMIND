/**
 * SlackAdapter
 *
 * Fetches Slack messages via the Web API (conversations.history / conversations.list)
 * and verifies incoming Events API webhook payloads.
 *
 * Registered as provider key 'slack' in AdapterRegistry.
 */

import crypto from 'node:crypto';
import { BaseConnectorAdapter } from '../../framework/base-connector-adapter.js';
import adapterRegistry from '../../framework/adapter-registry.js';

const SLACK_API = 'https://slack.com/api';
const MAX_CHANNELS_PER_BULK = 5;
const WEBHOOK_REPLAY_WINDOW_S = 300; // 5 minutes

/**
 * @param {string} token
 * @param {string} endpoint  e.g. 'conversations.history'
 * @param {Record<string, string|number>} params  query-string params
 * @returns {Promise<Object>}
 */
async function slackGet(token, endpoint, params = {}) {
  const url = new URL(`${SLACK_API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = new Error(`Slack HTTP ${res.status} on ${endpoint}`);
    /** @type {any} */ (err).status = res.status;
    throw err;
  }
  const body = await res.json();
  if (!body.ok) {
    const err = new Error(`Slack API error on ${endpoint}: ${body.error}`);
    /** @type {any} */ (err).slackError = body.error;
    throw err;
  }
  return body;
}

/**
 * Normalize a single raw Slack message object into a NormalizedRecord.
 * @param {Object} msg  Raw message from conversations.history/replies
 * @param {string} channel  Channel ID
 * @returns {import('../../framework/base-connector-adapter.js').NormalizedRecord}
 */
function normalizeMessage(msg, channel) {
  const text = msg.text || '';
  return {
    resource_id: `${channel}-${msg.ts}`,
    resource_type: 'message',
    title: text.slice(0, 80),
    body: text,
    ts: new Date(parseFloat(msg.ts) * 1000).toISOString(),
    refs: {
      channel,
      user: msg.user || null,
      thread_ts: msg.thread_ts || null,
      slack_ts: msg.ts,
    },
  };
}

export class SlackAdapter extends BaseConnectorAdapter {
  constructor(ctx) {
    super(ctx);
    /** @type {true} */
    this.supportsWebhooks = true;
  }

  /**
   * Fetch a page of Slack messages. Scopes to a single channel when
   * scope.channelId is provided; otherwise lists up to MAX_CHANNELS_PER_BULK
   * channels and fetches recent messages from each.
   *
   * @param {{ userId: string, orgId: string, cursor?: string|null, scope?: { channelId?: string }, limit?: number }} params
   * @returns {Promise<{ records: import('../../framework/base-connector-adapter.js').NormalizedRecord[], nextCursor: string|null }>}
   */
  async fetchBulk({ userId, orgId, cursor, scope = {}, limit = 100 }) {
    const token = await this.getBearer({ userId, orgId });

    if (scope.channelId) {
      const data = await slackGet(token, 'conversations.history', {
        channel: scope.channelId,
        limit,
        cursor: cursor || '',
      });
      const records = (data.messages || []).map(m => normalizeMessage(m, scope.channelId));
      return { records, nextCursor: data.response_metadata?.next_cursor || null };
    }

    // No specific channel — list channels and fetch recent messages from each
    const channelList = await slackGet(token, 'conversations.list', {
      limit: MAX_CHANNELS_PER_BULK,
      types: 'public_channel,private_channel',
      cursor: cursor || '',
    });
    const channels = (channelList.channels || []).slice(0, MAX_CHANNELS_PER_BULK);
    const nextCursor = channelList.response_metadata?.next_cursor || null;

    const allRecords = [];
    for (const ch of channels) {
      try {
        const hist = await slackGet(token, 'conversations.history', {
          channel: ch.id,
          limit: Math.ceil(limit / Math.max(channels.length, 1)),
        });
        allRecords.push(...(hist.messages || []).map(m => normalizeMessage(m, ch.id)));
      } catch (err) {
        // Skip channels we cannot read (e.g. not_in_channel) but log
        this.logger.warn({ err, channelId: ch.id }, 'slack fetchBulk: skipping channel');
      }
    }
    return { records: allRecords, nextCursor };
  }

  /**
   * Fetch a single message (plus thread replies) by resourceId.
   *
   * @param {{ userId: string, orgId: string, resourceId: string, type?: string }} params
   * @returns {Promise<import('../../framework/base-connector-adapter.js').NormalizedRecord>}
   */
  async fetchResource({ userId, orgId, resourceId }) {
    const token = await this.getBearer({ userId, orgId });

    // resourceId format: `${channel}-${ts}`
    const dashIdx = resourceId.indexOf('-');
    if (dashIdx === -1) throw new Error(`SlackAdapter: invalid resourceId "${resourceId}"`);
    const channel = resourceId.slice(0, dashIdx);
    const ts = resourceId.slice(dashIdx + 1);

    const data = await slackGet(token, 'conversations.replies', { channel, ts });
    const primary = data.messages?.[0];
    if (!primary) throw new Error(`SlackAdapter: no message found for ${resourceId}`);
    return normalizeMessage(primary, channel);
  }

  /**
   * Convert normalized Slack records into canonical memory payloads.
   * @param {import('../../framework/base-connector-adapter.js').NormalizedRecord} record
   * @param {Object} context
   * @returns {Object[]}
   */
  toMemoryPayloads(record, context) {
    const channel = record?.refs?.channel || 'unknown';
    const tags = ['slack', `channel:${channel}`];
    if (record?.refs?.thread_ts) tags.push('threaded');

    return [this.buildMemoryPayload(record, context, {
      memory_type: 'event',
      tags,
      source_type: 'message',
      metadata: {
        source_type_normalized: 'slack',
        slack_channel: channel,
        slack_user: record?.refs?.user || null,
        thread_ts: record?.refs?.thread_ts || null,
        slack_ts: record?.refs?.slack_ts || null,
      },
    })];
  }

  /**
   * Verify a Slack Events API webhook request.
   * Uses HMAC-SHA256 over `v0:${timestamp}:${rawBody}`.
   * Rejects requests older than 5 minutes to prevent replay attacks.
   *
   * @param {Record<string, string>} headers  Incoming request headers (lowercased keys)
   * @param {string} rawBody  Raw request body as UTF-8 string
   * @returns {true}  Throws on invalid / expired signature
   */
  verifyWebhookSignature(headers, rawBody) {
    // TODO: migrate to webhook_subscriptions.webhook_secret_encrypted decryption
    const secret = process.env.SLACK_SIGNING_SECRET;
    if (!secret) throw new Error('SlackAdapter: SLACK_SIGNING_SECRET not configured');

    const timestamp = headers['x-slack-request-timestamp'];
    const signature = headers['x-slack-signature'];
    if (!timestamp || !signature) {
      throw Object.assign(new Error('SlackAdapter: missing signature headers'), { code: 'missing_headers' });
    }

    const nowS = Math.floor(Date.now() / 1000);
    if (Math.abs(nowS - Number(timestamp)) > WEBHOOK_REPLAY_WINDOW_S) {
      throw Object.assign(new Error('SlackAdapter: webhook timestamp too old (replay?)'), { code: 'replay' });
    }

    const sigBase = `v0:${timestamp}:${rawBody}`;
    const computed = `v0=${crypto.createHmac('sha256', secret).update(sigBase).digest('hex')}`;

    const expectedBuf = Buffer.from(signature, 'utf8');
    const computedBuf = Buffer.from(computed, 'utf8');
    if (
      expectedBuf.length !== computedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, computedBuf)
    ) {
      throw Object.assign(new Error('SlackAdapter: invalid webhook signature'), { code: 'invalid_signature' });
    }
    return true;
  }

  /**
   * Parse a Slack Events API payload.
   * Returns a special shape for URL verification challenges.
   *
   * @param {Object} payload  Parsed JSON body from Slack
   * @returns {{ urlVerification: true, challenge: string }
   *          | { eventId: string, eventType: string, resourceId: string, type: string, externalId: string }}
   */
  parseEvent(payload) {
    if (payload.type === 'url_verification') {
      return { urlVerification: true, challenge: payload.challenge };
    }

    const event = payload.event || {};
    const channel = event.channel || event.item?.channel || '';
    const ts = event.ts || event.item?.ts || '';

    return {
      eventId: payload.event_id,
      eventType: event.type,
      resourceId: `${channel}-${ts}`,
      type: 'message',
      externalId: payload.team_id,
    };
  }

  /**
   * Register a webhook. Slack webhooks are configured at the app level, not
   * per-tenant via API. This method calls auth.test to confirm the connection
   * and returns the team_id as the externalId.
   *
   * @param {{ userId: string, orgId: string, callbackUrl: string, secret: string }} params
   * @returns {Promise<{ externalId: string, manual: true }>}
   */
  async registerWebhook({ userId, orgId }) {
    const token = await this.getBearer({ userId, orgId });
    const data = await slackGet(token, 'auth.test', {});
    return { externalId: data.team_id, manual: true };
  }
}

adapterRegistry.register('slack', SlackAdapter);
