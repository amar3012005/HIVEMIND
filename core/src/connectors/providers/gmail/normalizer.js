/**
 * Gmail normalizer — turns a raw Gmail thread (messages[] with payload headers
 * + parts) into HIVEMIND memory payloads.
 *
 * Pure functions (no `this`, no network). The adapter's `normalize()` delegates
 * here. Two emission modes:
 *   - 'thread'      (default): ONE consolidated memory per thread.
 *   - 'per-message' (legacy):  one memory per message + a summary for long
 *                              threads. Reachable only via
 *                              context.gmail_thread_mode !== 'thread'.
 *
 * Body cleaning + noise classification live in ./noise-filter.js.
 */

import { cleanEmailBody } from './noise-filter.js';

const LONG_THREAD_THRESHOLD = 5; // per-message mode: threads ≥ this get a summary

/** Read a header value (case-insensitive) from a Gmail message. */
export function getHeader(message, name) {
  const headers = message?.payload?.headers || [];
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header?.value || null;
}

/** Decode Gmail base64url (falls back to base64) body data. */
export function decodeBase64(data) {
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

/** Walk MIME parts and collect attachment descriptors. */
export function extractAttachments(msg) {
  const attachments = [];
  const walk = (parts) => {
    for (const part of parts || []) {
      if (part.filename && part.filename.length > 0) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType || 'application/octet-stream',
          size: part.body?.size || 0,
          attachmentId: part.body?.attachmentId || null,
        });
      }
      if (part.parts) walk(part.parts);
    }
  };
  walk(msg?.payload?.parts || []);
  return attachments;
}

/** Readable thread label set (CATEGORY_ prefix stripped, unread/inbox dropped). */
export function getThreadLabels(messages) {
  const labels = new Set();
  for (const msg of messages || []) {
    for (const labelId of msg.labelIds || []) {
      const readable = labelId.replace(/^CATEGORY_/, '').toLowerCase();
      if (!['unread', 'inbox'].includes(readable)) labels.add(readable);
    }
  }
  return [...labels];
}

/**
 * Extract clean markdown body + noise classification + trim stats from a
 * Gmail message. Falls back to the snippet when the body is empty.
 */
export function extractBody(message) {
  const payload = message?.payload;
  if (!payload) return { markdown: message?.snippet || '', noise: { skip: false }, trimStats: {} };

  let rawText = '';
  let rawHtml = '';
  const walk = (part) => {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) {
      rawText = rawText || decodeBase64(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      rawHtml = rawHtml || decodeBase64(part.body.data);
    }
    if (part.parts) part.parts.forEach(walk);
  };
  walk(payload);

  const headers = {};
  for (const h of payload.headers || []) headers[h.name.toLowerCase()] = h.value;

  const result = cleanEmailBody({ rawText, rawHtml, headers });
  if (!result.markdown && message.snippet) result.markdown = message.snippet;
  return result;
}

/**
 * Build the rich, queryable tag set (sender/recipient/subject/label/year-month
 * + attribution facets) so recall can filter precisely.
 */
export function buildRichTags({ messages, threadLabels, attribution, sentByUser, hasAttachments, isThread, subject, date, defaultTags = [] }) {
  const tags = new Set([...(defaultTags || []), 'gmail']);
  if (isThread) tags.add('gmail_thread');

  (threadLabels || []).forEach((l) => {
    if (!l) return;
    tags.add(String(l).toLowerCase());          // legacy bare label
    tags.add(`label:${String(l).toLowerCase()}`);
  });

  const emails = new Set();
  const fromEmails = new Set();
  const toEmails = new Set();
  const extractAddr = (header) => {
    if (!header) return null;
    const m = header.match(/<([^>]+)>/);
    const addr = (m ? m[1] : header).trim().toLowerCase();
    return /@/.test(addr) ? addr : null;
  };
  (messages || []).forEach((msg) => {
    const f = extractAddr(getHeader(msg, 'From'));
    const t = extractAddr(getHeader(msg, 'To'));
    const c = extractAddr(getHeader(msg, 'Cc'));
    if (f) { fromEmails.add(f); emails.add(f); }
    if (t) { toEmails.add(t); emails.add(t); }
    if (c) { emails.add(c); }
  });
  fromEmails.forEach((e) => tags.add(`from:${e}`));
  toEmails.forEach((e) => tags.add(`to:${e}`));
  emails.forEach((e) => tags.add(`participant:${e}`));

  if (subject) {
    const slug = String(subject)
      .toLowerCase()
      .replace(/^(re|fwd?|fw):\s*/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (slug) tags.add(`subject:${slug}`);
  }

  if (date) {
    try {
      const d = new Date(date);
      if (!isNaN(d)) {
        tags.add(`yyyy-mm:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
        tags.add(`year:${d.getUTCFullYear()}`);
      }
    } catch { /* ignore bad date */ }
  }

  if (attribution === 'newsletter') tags.add('newsletter');
  if (sentByUser) tags.add('sent-by-user');
  if (hasAttachments) tags.add('has-attachments');

  return [...tags];
}

/** Plain-text thread summary (per-message mode, long threads only). */
export function buildThreadSummary(thread, messages, subject) {
  const participants = new Set();
  const dates = [];
  for (const msg of messages) {
    const from = getHeader(msg, 'From') || '';
    const emailMatch = from.match(/<([^>]+)>/);
    participants.add(emailMatch ? emailMatch[1] : from);
    const date = getHeader(msg, 'Date');
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
      const from = getHeader(msg, 'From') || 'Unknown';
      const snippet = msg.snippet || '';
      return `  ${i + 1}. ${from}: ${snippet.slice(0, 120)}`;
    }),
  ].filter(Boolean).join('\n');
}

/**
 * Normalize a Gmail thread into one or more memory payloads.
 *
 * ACL rule: under org/team scope, purely-personal outgoing mail (sent by the
 * installer to recipients all on the installer's own domain) is skipped, to
 * avoid org-wide exposure of private threads. Shared/external traffic passes.
 * SENT mail to external recipients always passes — it is ground truth.
 *
 * @param {object} thread   Raw Gmail thread ({ id, messages: [...] }).
 * @param {object} context  { user_id, org_id, target_scope, user_account_ref,
 *                            gmail_thread_mode, ingest_newsletters }
 * @param {{ defaultTags?: string[] }} [opts]
 * @returns {object[]} memory payloads
 */
export function normalizeThread(thread, context, opts = {}) {
  const defaultTags = opts.defaultTags || [];
  const messages = thread?.messages || [];
  if (!messages.length) return [];

  const targetScope = context?.target_scope || 'personal';
  const orgScopeMode = targetScope === 'organization' || targetScope === 'team';

  const payloads = [];
  const firstMessage = messages[0];
  const subject = getHeader(firstMessage, 'Subject') || '(no subject)';
  const threadLabels = getThreadLabels(messages);
  const userEmail = (context.user_account_ref || '').toLowerCase();
  const threadMode = context?.gmail_thread_mode || 'thread';
  const ingestNewsletters = context?.ingest_newsletters === true;
  const threadMessageBlocks = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const from = getHeader(msg, 'From') || '';
    const to = getHeader(msg, 'To') || '';
    const date = getHeader(msg, 'Date');
    const cleanResult = extractBody(msg);
    const body = cleanResult.markdown || '';

    if (cleanResult.noise?.skip) {
      console.log(`[gmail-normalizer] Skipping message ${msg.id}: ${cleanResult.noise.reason}`);
      continue;
    }

    const fromEmail = (from.match(/[\w.+-]+@[\w.-]+\.\w{2,}/) || [''])[0].toLowerCase();
    const sentByUser = userEmail && fromEmail === userEmail;

    // ACL gate: org/team scope skips purely-internal personal outgoing mail.
    if (orgScopeMode && sentByUser) {
      const installerDomain = userEmail.split('@')[1] || '';
      const recipientEmails = (to + ' ' + (getHeader(msg, 'Cc') || ''))
        .match(/[\w.+-]+@[\w.-]+\.\w{2,}/g) || [];
      const allSameDomain = recipientEmails.length > 0
        && recipientEmails.every((e) => e.toLowerCase().endsWith(`@${installerDomain}`));
      if (allSameDomain) continue;
    }

    const isNewsletter = /\b(newsletter|noreply|no-reply|unsubscribe|marketing|digest|updates@|info@|hello@)\b/i
      .test(from + ' ' + body.slice(0, 200));
    const attribution = sentByUser ? 'first_person' : isNewsletter ? 'newsletter' : 'third_party';

    // Newsletter gate — SENT mail always passes (the user's own outbound).
    if (isNewsletter && !ingestNewsletters && !sentByUser) {
      console.log(`[gmail-normalizer] Skipping newsletter ${msg.id}: from=${fromEmail}`);
      continue;
    }

    // Quality gate — trivial content skipped unless sent by the user (a short
    // reply still records the relationship).
    const bodyLen = body.replace(/\s+/g, ' ').trim().length;
    if (bodyLen < 50 && !sentByUser) {
      console.log(`[gmail-normalizer] Skipping low-signal message ${msg.id}: body=${bodyLen} chars`);
      continue;
    }

    const attachments = extractAttachments(msg);
    const content = [
      `**Subject:** ${subject}`,
      `**From:** ${from}`,
      `**To:** ${to}`,
      date ? `**Date:** ${date}` : null,
      attachments.length > 0
        ? `**Attachments:** ${attachments.map((a) => `${a.filename} (${a.mimeType})`).join(', ')}`
        : null,
      '',
      '---',
      '',
      body,
    ].filter(Boolean).join('\n');

    if (threadMode === 'thread') {
      threadMessageBlocks.push({ index: i, from, to, date, body, attachments, sentByUser });
      continue; // emit one thread payload at end
    }

    // ── per-message mode (legacy) ──
    const tags = buildRichTags({
      messages: [msg], threadLabels, attribution, sentByUser,
      hasAttachments: attachments.length > 0, isThread: false, subject, date, defaultTags,
    });

    const payload = {
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content,
      title: i === 0 ? subject : `Re: ${subject}`,
      tags: [...new Set(tags)],
      memory_type: 'event',
      skipProcessing: true,
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
        attachment_names: attachments.map((a) => a.filename),
        force_entity_linking: true,
      },
    };
    if (i > 0) payload.relationship = { type: 'Extends', related_to: null };
    payloads.push(payload);
  }

  // ── thread mode: one consolidated memory per thread ──
  if (threadMode === 'thread' && threadMessageBlocks.length > 0) {
    const lastMsg = messages[messages.length - 1];
    const lastDate = getHeader(lastMsg, 'Date');
    const firstDate = getHeader(messages[0], 'Date');
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
      allAttachments.length > 0 ? `**Attachments:** ${allAttachments.map((a) => a.filename).join(', ')}` : null,
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

    const threadTags = buildRichTags({
      messages, threadLabels, attribution: null, sentByUser: false,
      hasAttachments: allAttachments.length > 0, isThread: true, subject,
      date: lastDate || firstDate, defaultTags,
    });
    threadTags.push('gmail-thread'); // back-compat legacy tag

    const allEventDates = threadMessageBlocks
      .map((b) => b.date)
      .filter(Boolean)
      .map((d) => { try { return new Date(d).toISOString(); } catch { return null; } })
      .filter(Boolean);

    payloads.push({
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content: threadContent,
      title: subject,
      tags: [...new Set(threadTags)],
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
        from: messages[0] ? getHeader(messages[0], 'From') : null,
        to: messages[0] ? getHeader(messages[0], 'To') : null,
        date_first: firstDate,
        date_last: lastDate,
        message_count: threadMessageBlocks.length,
        participants: [...participants],
        attachment_count: allAttachments.length,
        attachment_names: allAttachments.map((a) => a.filename),
        labels: threadLabels,
        force_entity_linking: true,
      },
    });
    return payloads;
  }

  // per-message mode: long-thread summary
  if (messages.length >= LONG_THREAD_THRESHOLD) {
    const summaryContent = buildThreadSummary(thread, messages, subject);
    payloads.push({
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content: summaryContent,
      title: `Thread Summary: ${subject}`,
      tags: [...defaultTags, 'thread-summary', ...threadLabels],
      memory_type: 'event',
      skipProcessing: true,
      document_date: getHeader(messages[messages.length - 1], 'Date')
        ? new Date(getHeader(messages[messages.length - 1], 'Date')).toISOString()
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
