/**
 * Slack Provider Adapter
 *
 * Production-grade Slack connector with:
 * - Thread grouping and hydration
 * - Non-threaded message clustering (30-min windows)
 * - Noise filtering (joins, leaves, bots, reactions, short messages)
 * - Decision/commitment detection via regex
 * - Proper attribution (first_person vs third_party)
 * - Rate-limited API calls with 429 retry
 * - User name resolution with caching
 */

import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

const SLACK_API = 'https://slack.com/api';
const MAX_CHANNELS = 30;
const HISTORY_LIMIT = 100;
const CLUSTER_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const MIN_CLUSTER_SIZE = 2;
const MIN_THREAD_MEANINGFUL = 3;
const MIN_MSG_LENGTH = 15;
const BOT_MSG_MIN_LENGTH = 100;

// --- Noise filtering ---

const SKIP_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
  'bot_message', 'message_deleted', 'message_changed',
  'thread_broadcast', 'tombstone',
]);

const REACTION_ONLY = /^(\p{Emoji_Presentation}|\+1|ok|thanks|lgtm|ty|thx|yep|yup|sure|np|ack|done|nice|great|cool|👍|👎|🎉|✅|❌|🙏|💯)\s*$/iu;

// --- Decision/commitment detection ---

const DECISION_PATTERNS = /\b(decided|decision|let's go with|we'll use|going with|agreed|approved|confirmed|selected|chose|picked)\b/i;
const COMMITMENT_PATTERNS = /\b(i'll|i will|by friday|by monday|by end of|deadline|ship it|i'll send|i'll handle|action item|todo|follow up)\b/i;
const URL_PATTERN = /https?:\/\/\S+/;

/**
 * Check whether a question was asked and then resolved with a decision.
 */
function questionResolved(messages) {
  return messages.some(m => m.text?.includes('?'))
    && messages.some(m => DECISION_PATTERNS.test(m.text));
}

/**
 * Return true if the message passes the noise filter (i.e. is meaningful).
 */
function isMeaningful(msg) {
  if (!msg || !msg.text) return false;
  if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) return false;
  if (msg.bot_id && (msg.text || '').length < BOT_MSG_MIN_LENGTH) return false;
  if (REACTION_ONLY.test(msg.text)) return false;
  if (msg.text.length < MIN_MSG_LENGTH && !URL_PATTERN.test(msg.text)) return false;
  return true;
}

/**
 * Extract a short decision summary from messages that contain a decision pattern.
 */
function extractDecisionSummary(messages) {
  const decisionMsg = messages.find(m => DECISION_PATTERNS.test(m.text));
  if (!decisionMsg) return messages[0]?.text?.slice(0, 60) || 'Untitled decision';
  return decisionMsg.text.slice(0, 80).replace(/\n/g, ' ');
}


export class SlackAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      providerId: 'slack',
      requiredScopes: [
        'channels:history', 'channels:read', 'users:read', 'team:read',
        'groups:history', 'im:history', 'mpim:history',
      ],
      defaultTags: ['slack'],
    });
    /** @type {Map<string, string>} userId -> display name */
    this._userCache = new Map();
  }

  // ─────────────────────────────────────────────
  //  Fetch
  // ─────────────────────────────────────────────

  /**
   * Full backfill: list conversations, pull history, group into units.
   */
  async fetchInitial({ accessToken, cursor, context }) {
    return this._fetchMessages({ accessToken, cursor, context });
  }

  /**
   * Incremental delta sync using `oldest` timestamp cursor.
   */
  async fetchIncremental({ accessToken, cursor, context }) {
    return this._fetchMessages({ accessToken, cursor, context });
  }

  /**
   * Shared fetch logic for both initial and incremental syncs.
   */
  async _fetchMessages({ accessToken, cursor, context }) {
    const channelsRes = await this._slackFetch('conversations.list', {
      types: 'public_channel,private_channel,im,mpim',
      limit: 200,
      exclude_archived: true,
    }, accessToken);

    const channels = (channelsRes.channels || []).slice(0, MAX_CHANNELS);
    const records = [];
    let latestTs = cursor || '0';

    for (const ch of channels) {
      try {
        const units = await this._fetchChannelUnits(ch, cursor, accessToken);
        for (const unit of units) {
          records.push(unit);
          // Track the latest timestamp for cursor advancement
          for (const msg of unit.messages) {
            if (msg.ts && msg.ts > latestTs) latestTs = msg.ts;
          }
        }
      } catch (err) {
        // Skip channels we can't access (e.g. missing scope for private)
        if (err.message?.includes('not_in_channel') || err.message?.includes('channel_not_found')) {
          continue;
        }
        console.warn(`[slack-adapter] Failed to fetch channel ${ch.id}: ${err.message}`);
      }
    }

    return {
      records,
      nextCursor: latestTs !== '0' ? latestTs : null,
      hasMore: false,
    };
  }

  /**
   * Fetch messages for a single channel and group them into conversation units.
   */
  async _fetchChannelUnits(channel, oldest, accessToken) {
    const params = { channel: channel.id, limit: HISTORY_LIMIT };
    if (oldest) params.oldest = oldest;

    const histRes = await this._slackFetch('conversations.history', params, accessToken);
    const allMessages = histRes.messages || [];
    if (allMessages.length === 0) return [];

    const channelName = channel.name || channel.id;
    const channelType = channel.is_im ? 'dm'
      : channel.is_mpim ? 'group_dm'
      : channel.is_private ? 'private_channel'
      : 'public_channel';

    const units = [];
    const threadRoots = [];
    const nonThreaded = [];

    // Separate thread roots from standalone messages
    for (const msg of allMessages) {
      if (msg.thread_ts && msg.thread_ts === msg.ts && msg.reply_count > 0) {
        threadRoots.push(msg);
      } else if (!msg.thread_ts || msg.thread_ts === msg.ts) {
        // Standalone message (not a reply, not a thread root with replies)
        nonThreaded.push(msg);
      }
      // Skip replies that appear in channel history — they'll be hydrated via thread
    }

    // Hydrate threads
    for (const root of threadRoots) {
      try {
        const threadMsgs = await this._hydrateThread(channel.id, root.ts, accessToken);
        const participants = [...new Set(threadMsgs.map(m => m.user).filter(Boolean))];

        await this._resolveParticipants(threadMsgs, accessToken);

        units.push({
          channel_id: channel.id,
          channel_name: channelName,
          channel_type: channelType,
          unit_type: 'thread',
          root_ts: root.ts,
          messages: threadMsgs,
          participants,
        });
      } catch (err) {
        console.warn(`[slack-adapter] Failed to hydrate thread ${root.ts}: ${err.message}`);
      }
    }

    // Resolve names for non-threaded messages
    if (nonThreaded.length > 0) {
      await this._resolveParticipants(nonThreaded, accessToken);
    }

    // Cluster non-threaded messages by 30-minute windows
    const clusters = this._clusterMessages(nonThreaded);
    for (const cluster of clusters) {
      const participants = [...new Set(cluster.map(m => m.user).filter(Boolean))];
      units.push({
        channel_id: channel.id,
        channel_name: channelName,
        channel_type: channelType,
        unit_type: 'cluster',
        root_ts: cluster[0].ts,
        messages: cluster,
        participants,
      });
    }

    // Single standalone messages that didn't fit in a cluster
    // (only if they're substantial enough on their own)
    const clusteredTs = new Set(clusters.flat().map(m => m.ts));
    for (const msg of nonThreaded) {
      if (clusteredTs.has(msg.ts)) continue;
      if (!isMeaningful(msg)) continue;
      // Only keep singles that have real substance
      if ((msg.text || '').length < 50 && !URL_PATTERN.test(msg.text || '')) continue;

      units.push({
        channel_id: channel.id,
        channel_name: channelName,
        channel_type: channelType,
        unit_type: 'single',
        root_ts: msg.ts,
        messages: [msg],
        participants: [msg.user].filter(Boolean),
      });
    }

    return units;
  }

  // ─────────────────────────────────────────────
  //  Normalize
  // ─────────────────────────────────────────────

  /**
   * Transform a conversation unit into memory payloads.
   */
  normalize(record, context) {
    const {
      channel_id, channel_name, channel_type,
      unit_type, root_ts, messages, participants,
    } = record;

    // Apply noise filter
    const meaningful = messages.filter(isMeaningful);

    // Threads with fewer than 3 meaningful messages after filtering are noise
    if (unit_type === 'thread' && meaningful.length < MIN_THREAD_MEANINGFUL) return [];
    // Clusters/singles must have at least 1 meaningful message
    if (meaningful.length === 0) return [];

    // --- Detection ---
    const hasDecision = meaningful.some(m => DECISION_PATTERNS.test(m.text)) || questionResolved(meaningful);
    const hasCommitment = meaningful.some(m => COMMITMENT_PATTERNS.test(m.text));
    const hasUrl = meaningful.some(m => URL_PATTERN.test(m.text));

    // --- Memory type ---
    let memory_type = 'event';
    if (hasDecision) memory_type = 'decision';
    else if (hasCommitment) memory_type = 'goal';
    else if (hasUrl && meaningful.some(m => URL_PATTERN.test(m.text) && m.text.length > 60)) memory_type = 'fact';

    // --- Attribution ---
    const userSlackId = context.user_account_ref;
    const sentByUser = meaningful.some(m => m.user === userSlackId);
    const attribution = sentByUser ? 'first_person' : 'third_party';

    // --- Content ---
    const dateStr = root_ts
      ? new Date(parseFloat(root_ts) * 1000).toISOString().split('T')[0]
      : 'unknown date';

    const firstMsg = meaningful[0];
    const content = [
      `${unit_type === 'thread' ? 'Thread' : 'Conversation'} in #${channel_name} (${dateStr}):`,
      '',
      ...meaningful.map(m => `${m._resolved_name || m.user || 'unknown'}: ${m.text}`),
    ].join('\n');

    // --- Title ---
    const title = hasDecision
      ? `Decision: ${extractDecisionSummary(meaningful)}`
      : `#${channel_name}: ${(firstMsg.text || '').slice(0, 60)}`;

    // --- Participant names (use cached _resolved_name or fall back to IDs) ---
    const participantNames = participants.map(p => this._userCache.get(p) || p);

    // --- Tags ---
    const tags = [
      'slack',
      `channel:${channel_name}`,
      ...participants.slice(0, 5).map(p => `from:${this._userCache.get(p) || p}`),
      hasDecision ? 'decision' : null,
      hasCommitment ? 'commitment' : null,
      hasUrl ? 'has-url' : null,
      sentByUser ? 'sent-by-user' : null,
    ].filter(Boolean);

    return [{
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content,
      title,
      tags,
      memory_type,
      document_date: root_ts ? new Date(parseFloat(root_ts) * 1000).toISOString() : null,
      source_metadata: {
        source_type: 'slack',
        source_platform: 'slack',
        source_id: `slack:${unit_type}:${channel_id}:${root_ts}`,
        thread_id: root_ts,
      },
      metadata: {
        slack_channel_id: channel_id,
        slack_channel_name: channel_name,
        slack_channel_type: channel_type,
        slack_thread_ts: root_ts,
        participants: participantNames,
        message_count: meaningful.length,
        content_attribution: attribution,
        sent_by_user: sentByUser,
        has_decision: hasDecision,
        has_commitment: hasCommitment,
        has_url: hasUrl,
        unit_type,
      },
    }];
  }

  // ─────────────────────────────────────────────
  //  Dedupe
  // ─────────────────────────────────────────────

  dedupeKey(record) {
    return `slack:${record.unit_type}:${record.channel_id}:${record.root_ts}`;
  }

  // ─────────────────────────────────────────────
  //  Helpers
  // ─────────────────────────────────────────────

  /**
   * Hydrate a thread by fetching all replies.
   */
  async _hydrateThread(channelId, threadTs, accessToken) {
    const res = await this._slackFetch('conversations.replies', {
      channel: channelId,
      ts: threadTs,
      limit: 100,
    }, accessToken);
    return res.messages || [];
  }

  /**
   * Cluster non-threaded messages into 30-minute windows.
   * Only keeps clusters with >= 2 messages.
   */
  _clusterMessages(messages) {
    if (!messages.length) return [];

    // Sort chronologically
    const sorted = [...messages].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
    const clusters = [];
    let current = [sorted[0]];
    let windowStart = parseFloat(sorted[0].ts) * 1000;

    for (let i = 1; i < sorted.length; i++) {
      const ts = parseFloat(sorted[i].ts) * 1000;
      if (ts - windowStart > CLUSTER_WINDOW_MS) {
        if (current.length >= MIN_CLUSTER_SIZE) clusters.push(current);
        current = [sorted[i]];
        windowStart = ts;
      } else {
        current.push(sorted[i]);
      }
    }
    if (current.length >= MIN_CLUSTER_SIZE) clusters.push(current);

    return clusters;
  }

  /**
   * Resolve a Slack user ID to a display name, with caching.
   */
  async _resolveUserName(userId, accessToken) {
    if (!userId) return 'unknown';
    if (this._userCache.has(userId)) return this._userCache.get(userId);
    try {
      const res = await this._slackFetch('users.info', { user: userId }, accessToken);
      const name = res.user?.real_name || res.user?.name || userId;
      this._userCache.set(userId, name);
      return name;
    } catch {
      this._userCache.set(userId, userId); // cache the miss to avoid repeat failures
      return userId;
    }
  }

  /**
   * Resolve user names for all messages in a unit (mutates messages with _resolved_name).
   * Called during fetch so normalize() can use the cached names synchronously.
   */
  async _resolveParticipants(messages, accessToken) {
    const userIds = [...new Set(messages.map(m => m.user).filter(Boolean))];
    for (const uid of userIds) {
      await this._resolveUserName(uid, accessToken);
    }
    // Stamp resolved names onto messages for normalize()
    for (const msg of messages) {
      if (msg.user) {
        msg._resolved_name = this._userCache.get(msg.user) || msg.user;
      }
    }
  }

  /**
   * Rate-limited Slack API fetch with 429 retry.
   */
  async _slackFetch(method, params, token) {
    // 1 req/sec to stay safe with Slack rate limits
    await new Promise(r => setTimeout(r, 1000));

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null) qs.set(k, String(v));
    }

    const res = await fetch(`${SLACK_API}/${method}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10) * 1000;
      console.warn(`[slack-adapter] Rate limited on ${method}, retrying in ${retryAfter}ms`);
      await new Promise(r => setTimeout(r, retryAfter));
      return this._slackFetch(method, params, token); // retry once
    }

    if (!res.ok) {
      const e = new Error(`Slack API ${method} returned ${res.status}`);
      e.status = res.status;
      throw e;
    }

    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Slack API ${method} error: ${data.error}`);
    }

    return data;
  }
}
