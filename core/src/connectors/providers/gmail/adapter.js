/**
 * Gmail Provider Adapter
 *
 * Fetches Gmail messages via the Gmail API and normalizes them into
 * HIVEMIND memory payloads with thread continuity as Updates/Extends.
 */

import { BaseProviderAdapter } from '../../framework/provider-adapter.js';
import { cleanEmailBody } from './email-cleaner.js';

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
   *
   * ACL rule: when context.target_scope is 'organization' or 'team', only
   * emails sent FROM or TO a shared / domain alias are ingested. Messages
   * that appear to be personal inbox traffic (sent to/from a personal address
   * that is not a shared alias) are skipped. This prevents org-wide exposure
   * of personal email when the installer uses a corporate Gmail account.
   *
   * Heuristic: skip threads where every message was sent by the installer's
   * own personal address (sentByUser=true for all) AND the thread has no
   * external recipient at a different domain. In practice, "shared inbox" or
   * forwarded-to-team email lands in the "received from external" bucket and
   * passes through.
   */
  normalize(thread, context) {
    const messages = thread.messages || [];
    if (!messages.length) return [];

    const targetScope = context?.target_scope || 'personal';
    const orgScopeMode = targetScope === 'organization' || targetScope === 'team';

    const payloads = [];
    const firstMessage = messages[0];
    const subject = this._getHeader(firstMessage, 'Subject') || '(no subject)';
    const threadLabels = this._getThreadLabels(messages);

    // Determine user's own email for content attribution
    const userEmail = (context.user_account_ref || '').toLowerCase();

    // Thread mode: 'thread' (default, one memory per thread) or 'per-message' (legacy fine-grained)
    // Thread mode reduces fragmentation — one trivial email no longer creates 5 garbage facts.
    const threadMode = context?.gmail_thread_mode || 'thread';
    // Newsletter opt-in: by default, marketing emails are SKIPPED entirely.
    // Caller can pass context.ingest_newsletters = true to include them.
    const ingestNewsletters = context?.ingest_newsletters === true;
    const threadMessageBlocks = []; // Used when threadMode === 'thread'

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const from = this._getHeader(msg, 'From') || '';
      const to = this._getHeader(msg, 'To') || '';
      const date = this._getHeader(msg, 'Date');
      const cleanResult = this._extractBody(msg);
      const body = cleanResult.markdown || '';

      // Noise filter: skip auto-replies, OOO, bounces, empty messages
      if (cleanResult.noise?.skip) {
        console.log(`[gmail-adapter] Skipping message ${msg.id}: ${cleanResult.noise.reason}`);
        continue;
      }

      // Determine content attribution: did the user send this or receive it?
      const fromEmail = (from.match(/[\w.+-]+@[\w.-]+\.\w{2,}/) || [''])[0].toLowerCase();
      const sentByUser = userEmail && fromEmail === userEmail;

      // ACL gate: in org/team scope, skip purely-personal outgoing messages.
      // A message is considered personal if it was sent by the installer AND
      // all recipients share the same personal domain as the installer
      // (i.e. not routed through a shared/team alias or external domain).
      // This is a best-effort filter; shared-mailbox traffic always passes.
      if (orgScopeMode && sentByUser) {
        const installerDomain = userEmail.split('@')[1] || '';
        const recipientEmails = (to + ' ' + (this._getHeader(msg, 'Cc') || ''))
          .match(/[\w.+-]+@[\w.-]+\.\w{2,}/g) || [];
        const allSameDomain = recipientEmails.length > 0 &&
          recipientEmails.every(e => e.toLowerCase().endsWith(`@${installerDomain}`));
        if (allSameDomain) {
          // Personal internal email — skip under org/team scope
          continue;
        }
      }
      const isNewsletter = /\b(newsletter|noreply|no-reply|unsubscribe|marketing|digest|updates@|info@|hello@)\b/i.test(from + ' ' + body.slice(0, 200));
      const attribution = sentByUser ? 'first_person' : isNewsletter ? 'newsletter' : 'third_party';

      // Newsletter opt-in gate: skip marketing unless explicitly enabled
      if (isNewsletter && !ingestNewsletters) {
        console.log(`[gmail-adapter] Skipping newsletter ${msg.id}: from=${fromEmail}`);
        continue;
      }

      // Quality gate: skip trivial content ("ok", "thanks", "got it")
      const bodyLen = body.replace(/\s+/g, ' ').trim().length;
      if (bodyLen < 50) {
        console.log(`[gmail-adapter] Skipping low-signal message ${msg.id}: body=${bodyLen} chars`);
        continue;
      }

      const attachments = this._extractAttachments(msg);
      const attachmentLine = attachments.length > 0
        ? `\nAttachments: ${attachments.map(a => `${a.filename} (${a.mimeType})`).join(', ')}`
        : '';

      // Structured markdown content — uniform format, easy for LLMs to parse
      const content = [
        `**Subject:** ${subject}`,
        `**From:** ${from}`,
        `**To:** ${to}`,
        date ? `**Date:** ${date}` : null,
        attachments.length > 0
          ? `**Attachments:** ${attachments.map(a => `${a.filename} (${a.mimeType})`).join(', ')}`
          : null,
        '',
        '---',
        '',
        body,
      ].filter(Boolean).join('\n');

      // Collect per-message blocks for thread-mode aggregation
      if (threadMode === 'thread') {
        threadMessageBlocks.push({
          index: i,
          from,
          to,
          date,
          body,
          attachments,
          sentByUser,
        });
        continue; // skip per-message payload — emit one thread payload at end
      }

      const tags = [...this.defaultTags, ...threadLabels];
      if (attachments.length > 0) tags.push('has-attachments');
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
        // Email is an EVENT type — temporal, decay-friendly, NOT a fact.
        // Fact-extraction is skipped at the ingestion layer to prevent
        // garbage outputs like "X sent email on Y date".
        memory_type: 'event',
        skipProcessing: true,
        // document_date = email Date header (when it happened, not when ingested).
        // Critical for time-aware recall ("emails from last week").
        document_date: date ? new Date(date).toISOString() : null,
        event_dates: date ? [new Date(date).toISOString()] : [],
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
          attachments: attachments.length > 0 ? attachments : undefined,
          attachment_count: attachments.length,
          attachment_names: attachments.map(a => a.filename),
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

    // Thread-mode: emit one consolidated memory per thread with all messages
    // preserved in order. Mirrors Supermemory's gmail_thread doc shape.
    if (threadMode === 'thread' && threadMessageBlocks.length > 0) {
      const lastMsg = messages[messages.length - 1];
      const lastDate = this._getHeader(lastMsg, 'Date');
      const firstDate = this._getHeader(messages[0], 'Date');
      const participants = new Set();
      const allAttachments = [];

      for (const b of threadMessageBlocks) {
        const emailMatch = (b.from || '').match(/<([^>]+)>/);
        participants.add(emailMatch ? emailMatch[1] : b.from);
        allAttachments.push(...b.attachments);
      }

      const threadContent = [
        `**Subject:** ${subject}`,
        `**Participants:** ${[...participants].join(', ')}`,
        firstDate ? `**Date:** ${firstDate}${lastDate && lastDate !== firstDate ? ` → ${lastDate}` : ''}` : null,
        `**Messages:** ${threadMessageBlocks.length}`,
        allAttachments.length > 0
          ? `**Attachments:** ${allAttachments.map(a => a.filename).join(', ')}`
          : null,
        '',
        '---',
        '',
        ...threadMessageBlocks.map((b, idx) => [
          `### Message ${idx + 1} — ${b.from}${b.date ? ` · ${b.date}` : ''}`,
          b.to ? `*To: ${b.to}*` : null,
          '',
          b.body,
          '',
        ].filter(Boolean).join('\n')),
      ].filter(Boolean).join('\n');

      const threadTags = [...this.defaultTags, 'gmail-thread', ...threadLabels];
      if (allAttachments.length > 0) threadTags.push('has-attachments');
      const senderParticipants = [...participants].slice(0, 3).map(p => `from:${p.split('@')[0]}`);
      threadTags.push(...senderParticipants);

      // Collect every message's date for time-aware retrieval
      const allEventDates = threadMessageBlocks
        .map(b => b.date)
        .filter(Boolean)
        .map(d => {
          try { return new Date(d).toISOString(); } catch { return null; }
        })
        .filter(Boolean);

      payloads.push({
        user_id: context.user_id,
        org_id: context.org_id,
        project: null,
        content: threadContent,
        title: subject,
        tags: [...new Set(threadTags)],
        // EVENT type + skip-processing → no garbage facts extracted
        memory_type: 'event',
        skipProcessing: true,
        document_date: lastDate ? new Date(lastDate).toISOString() : null,
        event_dates: allEventDates,
        source_metadata: {
          source_type: 'gmail',
          source_platform: 'gmail',
          source_id: `gmail:thread:${thread.id}`,
          thread_id: thread.id,
        },
        metadata: {
          type: 'gmail_thread',
          gmail_thread_id: thread.id,
          subject,
          from: messages[0] ? this._getHeader(messages[0], 'From') : null,
          to: messages[0] ? this._getHeader(messages[0], 'To') : null,
          date_first: firstDate,
          date_last: lastDate,
          message_count: threadMessageBlocks.length,
          participants: [...participants],
          attachment_count: allAttachments.length,
          attachment_names: allAttachments.map(a => a.filename),
          labels: threadLabels,
        },
      });

      return payloads;
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
        memory_type: 'event',
        skipProcessing: true,
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

  /**
   * Post-normalize structured extraction.
   * Pulls contact info (sender, recipients) from every message header in the
   * thread and upserts into hivemind.contacts. Prevents "Fact: X email is Y@z.com"
   * memory pollution.
   *
   * Called by SyncEngine after normalize() for adapters that implement it.
   */
  async extractStructured(thread, ctx) {
    if (!ctx?.prisma) return;
    try {
      const { ContactsStore } = await import('./contacts-store.js');
      const store = new ContactsStore(ctx.prisma);
      const messages = thread.messages || [];
      for (const msg of messages) {
        const headers = {};
        for (const h of (msg.payload?.headers || [])) {
          headers[h.name.toLowerCase()] = h.value;
        }
        const eventDate = headers['date'] ? new Date(headers['date']) : null;
        await store.upsertFromMessageHeaders({
          userId: ctx.user_id,
          orgId: ctx.org_id,
          headers,
          sourcePlatform: 'gmail',
          eventDate,
        });
      }
    } catch (err) {
      console.warn(`[gmail-adapter] extractStructured failed: ${err.message}`);
    }
  }

  // ─── Internal helpers ──────────────────────────────────────

  _extractAttachments(msg) {
    const attachments = [];
    const parts = msg.payload?.parts || [];

    const walk = (parts) => {
      for (const part of parts) {
        if (part.filename && part.filename.length > 0) {
          attachments.push({
            filename: part.filename,
            mimeType: part.mimeType || 'application/octet-stream',
            size: part.body?.size || 0,
            attachmentId: part.body?.attachmentId || null,
          });
        }
        if (part.parts) walk(part.parts); // recurse nested parts
      }
    };
    walk(parts);
    return attachments;
  }

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

  /**
   * Extract clean, structured body from a Gmail message.
   * Returns markdown content with quoted replies + signatures stripped,
   * plus noise classification + trim stats.
   */
  _extractBody(message) {
    const payload = message.payload;
    if (!payload) return { markdown: message.snippet || '', noise: { skip: false }, trimStats: {} };

    // Gather raw text + html bodies from message parts
    let rawText = '';
    let rawHtml = '';

    const walk = (part) => {
      if (!part) return;
      if (part.mimeType === 'text/plain' && part.body?.data) {
        rawText = rawText || this._decodeBase64(part.body.data);
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        rawHtml = rawHtml || this._decodeBase64(part.body.data);
      }
      if (part.parts) part.parts.forEach(walk);
    };
    walk(payload);

    // Build header map for noise classification
    const headers = {};
    for (const h of payload.headers || []) {
      headers[h.name.toLowerCase()] = h.value;
    }

    const result = cleanEmailBody({ rawText, rawHtml, headers });
    if (!result.markdown && message.snippet) {
      result.markdown = message.snippet;
    }
    return result;
  }

  /**
   * Legacy plain body extractor — kept for thread summary fallback.
   */
  _extractBodyPlain(message) {
    const result = this._extractBody(message);
    return result.markdown || '';
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
