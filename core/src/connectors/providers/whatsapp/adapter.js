/**
 * WhatsApp Provider Adapter
 *
 * QR-code based pairing (similar to Hermes/OpenClaw flow).
 * Uses whatsapp-web.js under the hood — Puppeteer-based WhatsApp Web client.
 *
 * Ingest flow:
 *  1. User clicks "Connect WhatsApp" → QR code shown
 *  2. User scans with phone → device pairs (creds stored in session dir)
 *  3. Adapter syncs recent conversations as HIVEMIND memories
 *
 * Outbound: see whatsapp/bridge.js (action gateway path)
 */

import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

const MAX_CHATS = 30;
const MESSAGE_LIMIT = 100;
const MIN_MSG_LENGTH = 10;

export class WhatsAppAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      providerId: 'whatsapp',
      requiredScopes: [],
      defaultTags: ['whatsapp'],
    });
    this._client = null;
    this._ready = false;
  }

  /**
   * Set the WhatsApp client after QR pairing completes.
   * Called by the control-plane / bridge lifecycle manager.
   */
  setClient(client) {
    this._client = client;
    this._ready = true;
  }

  isReady() {
    return this._ready && this._client !== null;
  }

  // ─────────────────────────────────────────────
  //  Fetch (ingestion)
  // ─────────────────────────────────────────────

  async fetchInitial({ cursor, context }) {
    return this._fetchMessages({ cursor, context });
  }

  async fetchIncremental({ cursor, context }) {
    return this._fetchMessages({ cursor, context });
  }

  async _fetchMessages({ cursor, context }) {
    if (!this.isReady()) {
      return { records: [], nextCursor: null, hasMore: false, error: 'WhatsApp client not ready' };
    }

    const chats = await this._client.getChats();
    const sorted = chats
      .filter(c => !c.isGroup && !c.isBroadcast) // personal + groups only for now
      .slice(0, MAX_CHATS);

    const records = [];
    let latestTimestamp = cursor || '0';

    for (const chat of sorted) {
      try {
        const messages = await chat.fetchMessages({
          limit: MESSAGE_LIMIT,
          fromMe: false,
        });

        if (messages.length === 0) continue;

        const participants = [chat.name || chat.id.user];
        const sortedMsgs = messages.sort((a, b) => a.timestamp - b.timestamp);

        records.push({
          chat_id: chat.id._serialized,
          chat_name: chat.name || chat.id.user,
          is_group: chat.isGroup,
          participants,
          messages: sortedMsgs.map(m => ({
            id: m.id._serialized,
            body: m.body,
            from: m.from,
            fromMe: m.fromMe,
            timestamp: m.timestamp,
            hasMedia: m.hasMedia,
          })),
        });

        // Track latest cursor
        for (const m of sortedMsgs) {
          if (m.timestamp > latestTimestamp) latestTimestamp = m.timestamp;
        }
      } catch (err) {
        console.warn(`[whatsapp-adapter] Failed to fetch chat ${chat.id._serialized}: ${err.message}`);
      }
    }

    return {
      records,
      nextCursor: latestTimestamp !== '0' ? String(latestTimestamp) : null,
      hasMore: false,
    };
  }

  // ─────────────────────────────────────────────
  //  Normalize → memory payloads
  // ─────────────────────────────────────────────

  normalize(record, context) {
    const { chat_id, chat_name, is_group, messages } = record;
    if (!messages || messages.length === 0) return [];

    const meaningful = messages.filter(m => (m.body || '').length >= MIN_MSG_LENGTH);
    if (meaningful.length === 0) return [];

    const firstMsg = meaningful[0];
    const dateStr = firstMsg.timestamp
      ? new Date(firstMsg.timestamp * 1000).toISOString().split('T')[0]
      : 'unknown date';

    const title = is_group
      ? `WhatsApp group: ${chat_name} (${dateStr})`
      : `WhatsApp: ${chat_name} (${dateStr})`;

    const content = [
      `WhatsApp conversation with ${is_group ? `group ${chat_name}` : chat_name} (${dateStr}):`,
      '',
      ...meaningful.map(m => `${m.fromMe ? 'Me' : (chat_name || m.from)}: ${m.body}`),
    ].join('\n');

    const tags = [
      'whatsapp',
      is_group ? 'group' : 'dm',
      `chat:${chat_name}`,
    ];

    return [{
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content,
      title,
      tags,
      memory_type: 'event',
      document_date: firstMsg.timestamp
        ? new Date(firstMsg.timestamp * 1000).toISOString()
        : null,
      source_metadata: {
        source_type: 'whatsapp',
        source_platform: 'whatsapp',
        source_id: `whatsapp:chat:${chat_id}`,
        thread_id: chat_id,
      },
      metadata: {
        whatsapp_chat_id: chat_id,
        whatsapp_chat_name: chat_name,
        is_group,
        message_count: meaningful.length,
        participants: [chat_name],
        content_attribution: 'third_party',
      },
    }];
  }

  // ─────────────────────────────────────────────
  //  Dedupe
  // ─────────────────────────────────────────────

  dedupeKey(record) {
    return `whatsapp:chat:${record.chat_id}`;
  }
}
