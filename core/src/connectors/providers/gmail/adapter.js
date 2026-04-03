/**
 * Gmail Provider Adapter
 *
 * Fetches Gmail messages via the Gmail API and normalizes them into
 * HIVEMIND memory payloads with thread continuity as Updates/Extends.
 */

import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_RESULTS_PER_PAGE = 50;
const LONG_THREAD_THRESHOLD = 5; // threads with more messages get a summary memory

export class GmailAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      providerId: 'gmail',
      requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      defaultTags: ['gmail'],
    });
  }

  /**
   * Full backfill: list threads, then fetch each thread's messages.
   */
  async fetchInitial({ accessToken, cursor, context }) {
    const params = new URLSearchParams({
      maxResults: String(MAX_RESULTS_PER_PAGE),
    });
    if (cursor) {
      params.set('pageToken', cursor);
    }

    const response = await this._gmailFetch(`/threads?${params}`, accessToken);
    const threads = response.threads || [];

    // Fetch full thread details
    const records = [];
    for (const threadStub of threads) {
      try {
        const thread = await this._gmailFetch(`/threads/${threadStub.id}?format=full`, accessToken);
        records.push(thread);
      } catch (err) {
        // Skip individual thread failures
        console.warn(`[gmail-adapter] Failed to fetch thread ${threadStub.id}: ${err.message}`);
      }
    }

    return {
      records,
      nextCursor: response.nextPageToken || null,
      hasMore: !!response.nextPageToken,
    };
  }

  /**
   * Incremental sync using Gmail history API.
   * Cursor is a Gmail historyId.
   */
  async fetchIncremental({ accessToken, cursor, context }) {
    if (!cursor) {
      return this.fetchInitial({ accessToken, cursor: null, context });
    }

    const params = new URLSearchParams({
      startHistoryId: cursor,
      historyTypes: 'messageAdded',
      maxResults: String(MAX_RESULTS_PER_PAGE),
    });

    let response;
    try {
      response = await this._gmailFetch(`/history?${params}`, accessToken);
    } catch (err) {
      // historyId too old — fall back to full sync
      if (err.status === 404) {
        return this.fetchInitial({ accessToken, cursor: null, context });
      }
      throw err;
    }

    const newHistoryId = response.historyId;
    const histories = response.history || [];

    // Collect unique thread IDs from new messages
    const threadIds = new Set();
    for (const h of histories) {
      for (const added of h.messagesAdded || []) {
        if (added.message?.threadId) {
          threadIds.add(added.message.threadId);
        }
      }
    }

    // Fetch full threads
    const records = [];
    for (const threadId of threadIds) {
      try {
        const thread = await this._gmailFetch(`/threads/${threadId}?format=full`, accessToken);
        records.push(thread);
      } catch {
        // Skip
      }
    }

    return {
      records,
      nextCursor: newHistoryId || cursor,
      hasMore: !!response.nextPageToken,
    };
  }

  /**
   * Normalize a Gmail thread into memory payloads.
   */
  normalize(thread, context) {
    const messages = thread.messages || [];
    if (!messages.length) return [];

    const payloads = [];
    const firstMessage = messages[0];
    const subject = this._getHeader(firstMessage, 'Subject') || '(no subject)';
    const threadLabels = this._getThreadLabels(messages);

    // Determine user's own email for content attribution
    const userEmail = (context.user_account_ref || '').toLowerCase();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const from = this._getHeader(msg, 'From') || '';
      const to = this._getHeader(msg, 'To') || '';
      const date = this._getHeader(msg, 'Date');
      const body = this._extractBody(msg);

      // Determine content attribution: did the user send this or receive it?
      const fromEmail = (from.match(/[\w.+-]+@[\w.-]+\.\w{2,}/) || [''])[0].toLowerCase();
      const sentByUser = userEmail && fromEmail === userEmail;
      const isNewsletter = /\b(newsletter|noreply|no-reply|unsubscribe|marketing|digest|updates@|info@|hello@)\b/i.test(from + ' ' + body.slice(0, 200));
      const attribution = sentByUser ? 'first_person' : isNewsletter ? 'newsletter' : 'third_party';

      const content = [
        `Subject: ${subject}`,
        `From: ${from}`,
        `To: ${to}`,
        date ? `Date: ${date}` : null,
        '',
        body,
      ].filter(Boolean).join('\n');

      const tags = [...this.defaultTags, ...threadLabels];
      const participants = this._extractParticipants(msg);
      if (participants.length) {
        tags.push(...participants.slice(0, 3).map(p => `from:${p}`));
      }
      // Tag attribution for downstream filtering
      if (attribution === 'newsletter') tags.push('newsletter');
      if (sentByUser) tags.push('sent-by-user');

      const payload = {
        user_id: context.user_id,
        org_id: context.org_id,
        project: null,
        content,
        title: i === 0 ? subject : `Re: ${subject}`,
        tags: [...new Set(tags)],
        memory_type: 'fact',
        document_date: date ? new Date(date).toISOString() : null,
        source_metadata: {
          source_type: 'gmail',
          source_platform: 'gmail',
          source_id: msg.id,
          thread_id: thread.id,
          parent_message_id: i > 0 ? messages[i - 1].id : null,
        },
        metadata: {
          gmail_thread_id: thread.id,
          gmail_message_id: msg.id,
          from,
          to,
          labels: threadLabels,
          message_index: i,
          thread_length: messages.length,
          content_attribution: attribution,
          sent_by_user: sentByUser,
        },
      };

      // Thread continuity: replies extend the original
      if (i > 0) {
        payload.relationship = {
          type: 'Extends',
          related_to: null, // Will be resolved by source_id dedupe
        };
      }

      payloads.push(payload);
    }

    // Thread summary for long threads (feature-flagged on by default)
    if (messages.length >= LONG_THREAD_THRESHOLD) {
      const summaryContent = this._buildThreadSummary(thread, messages, subject);
      payloads.push({
        user_id: context.user_id,
        org_id: context.org_id,
        project: null,
        content: summaryContent,
        title: `Thread Summary: ${subject}`,
        tags: [...this.defaultTags, 'thread-summary', ...threadLabels],
        memory_type: 'fact',
        document_date: this._getHeader(messages[messages.length - 1], 'Date')
          ? new Date(this._getHeader(messages[messages.length - 1], 'Date')).toISOString()
          : null,
        source_metadata: {
          source_type: 'gmail',
          source_platform: 'gmail',
          source_id: `thread-summary:${thread.id}`,
          thread_id: thread.id,
        },
        metadata: {
          gmail_thread_id: thread.id,
          is_thread_summary: true,
          message_count: messages.length,
        },
        skip_relationship_classification: true,
      });
    }

    return payloads;
  }

  /**
   * Dedupe key: gmail message ID (unique per message).
   */
  dedupeKey(thread) {
    return `gmail:thread:${thread.id}`;
  }

  // ─── Internal helpers ──────────────────────────────────────

  async _gmailFetch(path, accessToken) {
    const url = `${GMAIL_API_BASE}${path}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const error = new Error(`Gmail API ${response.status}: ${await response.text()}`);
      error.status = response.status;
      error.response = { status: response.status };
      throw error;
    }

    return response.json();
  }

  _getHeader(message, name) {
    const headers = message.payload?.headers || [];
    const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return header?.value || null;
  }

  _extractBody(message) {
    const payload = message.payload;
    if (!payload) return message.snippet || '';

    // Try plain text first
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return this._decodeBase64(payload.body.data);
    }

    // Search parts for text/plain
    const parts = payload.parts || [];
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return this._decodeBase64(part.body.data);
      }
    }

    // Fallback to HTML stripped or snippet
    for (const part of parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return this._stripHtml(this._decodeBase64(part.body.data));
      }
    }

    return message.snippet || '';
  }

  _decodeBase64(data) {
    try {
      return Buffer.from(data, 'base64url').toString('utf-8');
    } catch {
      try {
        return Buffer.from(data, 'base64').toString('utf-8');
      } catch {
        return '';
      }
    }
  }

  _stripHtml(html) {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _getThreadLabels(messages) {
    const labels = new Set();
    for (const msg of messages) {
      for (const labelId of msg.labelIds || []) {
        const readable = labelId.replace(/^CATEGORY_/, '').toLowerCase();
        if (!['unread', 'inbox'].includes(readable)) {
          labels.add(readable);
        }
      }
    }
    return [...labels];
  }

  _extractParticipants(message) {
    const from = this._getHeader(message, 'From') || '';
    const match = from.match(/<([^>]+)>/);
    return match ? [match[1].split('@')[0]] : from ? [from.split('@')[0]] : [];
  }

  _buildThreadSummary(thread, messages, subject) {
    const participants = new Set();
    const dates = [];

    for (const msg of messages) {
      const from = this._getHeader(msg, 'From') || '';
      const emailMatch = from.match(/<([^>]+)>/);
      participants.add(emailMatch ? emailMatch[1] : from);
      const date = this._getHeader(msg, 'Date');
      if (date) dates.push(date);
    }

    return [
      `Thread: ${subject}`,
      `Messages: ${messages.length}`,
      `Participants: ${[...participants].join(', ')}`,
      dates.length ? `Date range: ${dates[0]} → ${dates[dates.length - 1]}` : '',
      '',
      'Message summaries:',
      ...messages.map((msg, i) => {
        const from = this._getHeader(msg, 'From') || 'Unknown';
        const snippet = msg.snippet || '';
        return `  ${i + 1}. ${from}: ${snippet.slice(0, 120)}`;
      }),
    ].filter(Boolean).join('\n');
  }
}
