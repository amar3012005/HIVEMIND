/**
 * Gmail tool group — registers 4 minimal-surface tools on the Toolkit.
 *
 * Tools stay INACTIVE in the toolkit until the agent activates the group
 * via reset_equipped_tools({ group_names: ['gmail'] }). Once activated,
 * the per-tool descriptions + group skill notes inject into the LLM
 * tool-call schema. This keeps the primary system prompt small.
 *
 * Write tools (send) route through draft-approval middleware so nothing
 * leaves the system without user Approve.
 */

import { nangoProxyFetch } from './nango-fetch.js';

const GMAIL_PROVIDER = 'gmail';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const SKILL_NOTES = [
  'GMAIL TOOLS — read and act on the user\'s Gmail.',
  '  • gmail_search_threads(query) — Gmail search syntax (from:, subject:, after:, label:). Use this BEFORE gmail_read_thread.',
  '  • gmail_read_thread(thread_id) — full message bodies in a thread. Pass an id returned by search.',
  '  • gmail_send_email(to, subject, body) — composes and SENDS. Routes through draft-approval — user must click Approve before send.',
  '  • gmail_label_thread(thread_id, add_labels?, remove_labels?) — labels are Gmail label names, NOT IDs.',
  'Search syntax examples: "from:ethan after:2026-05-01", "subject:invoice", "label:starred is:unread".',
].join('\n');

export function registerGmailTools(toolkit) {
  toolkit.createToolGroup({
    name: 'gmail',
    description: 'Gmail read + send + label tools (Nango-routed).',
    active: false,
    notes: SKILL_NOTES,
  });

  toolkit.registerToolFunction({
    name: 'gmail_search_threads',
    description: 'Search Gmail threads with native Gmail search syntax (from:, subject:, after:, label:, has:attachment). Returns thread metadata only — call gmail_read_thread for bodies.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query, e.g. "from:ethan@acme.com after:2026-05-01"' },
        max_results: { type: 'integer', description: 'Max threads to return (default 10, max 25)', minimum: 1, maximum: 25 },
      },
      required: ['query'],
    },
    groupName: 'gmail',
    readOnly: true,
    handler: async (args, ctx) => {
      const max = Math.min(Math.max(Number(args.max_results) || 10, 1), 25);
      const url = `${GMAIL_API}/threads?q=${encodeURIComponent(args.query)}&maxResults=${max}`;
      const data = await nangoProxyFetch({ providerKey: GMAIL_PROVIDER, url, ctx });
      return {
        count: data.threads?.length || 0,
        threads: (data.threads || []).map(t => ({
          thread_id: t.id,
          snippet: t.snippet,
          history_id: t.historyId,
        })),
      };
    },
  });

  toolkit.registerToolFunction({
    name: 'gmail_read_thread',
    description: 'Read the full content of a Gmail thread by ID. Returns all messages with from, to, subject, date, body (cleaned).',
    parameters: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'Thread ID returned by gmail_search_threads.' },
      },
      required: ['thread_id'],
    },
    groupName: 'gmail',
    readOnly: true,
    handler: async (args, ctx) => {
      const url = `${GMAIL_API}/threads/${encodeURIComponent(args.thread_id)}?format=full`;
      const data = await nangoProxyFetch({ providerKey: GMAIL_PROVIDER, url, ctx });
      const messages = (data.messages || []).map(m => {
        const headers = Object.fromEntries((m.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
        return {
          id: m.id,
          from: headers.from,
          to: headers.to,
          subject: headers.subject,
          date: headers.date,
          body: extractBody(m.payload).slice(0, 4000),
          snippet: m.snippet,
        };
      });
      return {
        thread_id: data.id,
        message_count: messages.length,
        messages,
      };
    },
  });

  toolkit.registerToolFunction({
    name: 'gmail_send_email',
    description: 'Send a NEW email via Gmail. Routes through draft-approval — user must Approve before send. Use ONLY when user explicitly asked to send something.',
    parameters: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient address (or comma-separated for multiple).' },
        subject: { type: 'string', description: 'Subject line.' },
        body:    { type: 'string', description: 'Plain-text or HTML body. Multi-line OK.' },
        cc:      { type: 'string', description: 'CC addresses (optional, comma-separated).' },
      },
      required: ['to', 'subject', 'body'],
    },
    groupName: 'gmail',
    readOnly: false,
    handler: async (args, ctx) => {
      const headers = [
        `To: ${args.to}`,
        args.cc ? `Cc: ${args.cc}` : null,
        `Subject: ${args.subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
      ].filter(Boolean).join('\r\n');
      const raw = Buffer.from(`${headers}\r\n\r\n${args.body}`, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const url = `${GMAIL_API}/messages/send`;
      const data = await nangoProxyFetch({
        providerKey: GMAIL_PROVIDER, url, method: 'POST',
        body: { raw }, ctx,
      });
      return { sent: true, message_id: data.id, thread_id: data.threadId };
    },
  });

  toolkit.registerToolFunction({
    name: 'gmail_label_thread',
    description: 'Add and/or remove labels from a Gmail thread. Pass label NAMES (e.g. "STARRED", "TRASH", "Important"), not IDs.',
    parameters: {
      type: 'object',
      properties: {
        thread_id:      { type: 'string', description: 'Thread to modify.' },
        add_labels:     { type: 'array', items: { type: 'string' }, description: 'Labels to apply.' },
        remove_labels:  { type: 'array', items: { type: 'string' }, description: 'Labels to remove.' },
      },
      required: ['thread_id'],
    },
    groupName: 'gmail',
    readOnly: false,
    handler: async (args, ctx) => {
      // Resolve label NAMES → IDs (Gmail API requires IDs).
      const labelsData = await nangoProxyFetch({
        providerKey: GMAIL_PROVIDER, url: `${GMAIL_API}/labels`, ctx,
      });
      const byName = new Map((labelsData.labels || []).map(l => [String(l.name).toLowerCase(), l.id]));
      const resolve = (names) =>
        (names || []).map(n => byName.get(String(n).toLowerCase()) || n);
      const body = {
        addLabelIds: resolve(args.add_labels),
        removeLabelIds: resolve(args.remove_labels),
      };
      const url = `${GMAIL_API}/threads/${encodeURIComponent(args.thread_id)}/modify`;
      const data = await nangoProxyFetch({
        providerKey: GMAIL_PROVIDER, url, method: 'POST', body, ctx,
      });
      return { thread_id: data.id, applied: body };
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) return decodeB64(payload.body.data);
  // Multipart — prefer text/plain, fallback to text/html stripped.
  const parts = payload.parts || [];
  const plain = parts.find(p => p.mimeType === 'text/plain');
  if (plain?.body?.data) return decodeB64(plain.body.data);
  const html = parts.find(p => p.mimeType === 'text/html');
  if (html?.body?.data) return decodeB64(html.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  // Recurse into nested multipart.
  for (const p of parts) {
    if (Array.isArray(p.parts)) {
      const r = extractBody(p);
      if (r) return r;
    }
  }
  return '';
}

function decodeB64(s) {
  try {
    return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch { return ''; }
}
