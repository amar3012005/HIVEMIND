/**
 * Native Google Workspace tools for HyperAgents (Gmail + Docs).
 *
 * No google-workspace-mcp / npx / refresh-token shim (openswarm needs that
 * only because of its pool-minted refresh tokens). HIVEMIND's Nango already
 * centralizes refresh and hands us a fresh access_token — we call Google REST
 * directly. Proven path: fetchBearerFromNango('gmail', connId) → live read.
 *
 * Provider keys (Nango unique_key): gmail → Gmail API, google-docs → Docs API.
 */

import { getConnectionId, fetchBearerFromNango } from './mcp/nango-service.js';

async function resolveToken(provider, { user_id, org_id }, db) {
  if (!db) throw new Error('db required for Google token resolution');
  if (!user_id) throw new Error('user_id required for Google token resolution');
  const connectionId = await getConnectionId({ userId: user_id, orgId: org_id, providerKey: provider }, { db });
  if (!connectionId) throw new Error(`${provider} not connected for this user — connect it on the Connectors page`);
  return fetchBearerFromNango(provider, connectionId);
}

async function g(url, token, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`Google API ${res.status}: ${text.slice(0, 240)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// Walk a Gmail payload for the first text/plain (fallback text/html stripped).
function extractBody(payload) {
  if (!payload) return '';
  const decode = (data) => {
    try { return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
    catch { return ''; }
  };
  const walk = (part, wantHtml) => {
    if (!part) return '';
    if (part.mimeType === (wantHtml ? 'text/html' : 'text/plain') && part.body?.data) return decode(part.body.data);
    for (const sub of part.parts || []) {
      const r = walk(sub, wantHtml);
      if (r) return r;
    }
    return '';
  };
  const plain = walk(payload, false);
  if (plain) return plain;
  const html = walk(payload, true);
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Tool registry. Each: provider (Nango key) + async run(token, args).
export const GOOGLE_TOOLS = {
  gmail_search: {
    provider: 'gmail',
    description: 'Search the connected Gmail account. args: { query (Gmail search syntax), max (default 5, cap 20) }. Returns id/subject/from/date/snippet per message.',
    run: async (token, a) => {
      const max = Math.min(Math.max(parseInt(a.max, 10) || 5, 1), 20);
      const q = encodeURIComponent(a.query || '');
      const list = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${q}`, token);
      const ids = (list.messages || []).map(m => m.id);
      const messages = [];
      for (const id of ids) {
        const m = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, token);
        const h = Object.fromEntries((m.payload?.headers || []).map(x => [x.name, x.value]));
        messages.push({ id, subject: h.Subject || '(no subject)', from: h.From || '', date: h.Date || '', snippet: m.snippet || '' });
      }
      return { count: messages.length, messages };
    },
  },
  gmail_get: {
    provider: 'gmail',
    description: 'Fetch one Gmail message in full. args: { id }. Returns subject/from/to/date/body (text, capped 12k).',
    run: async (token, a) => {
      if (!a.id) throw new Error('gmail_get requires { id }');
      const m = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${a.id}?format=full`, token);
      const h = Object.fromEntries((m.payload?.headers || []).map(x => [x.name, x.value]));
      return {
        id: a.id, subject: h.Subject || '', from: h.From || '', to: h.To || '', date: h.Date || '',
        body: extractBody(m.payload).slice(0, 12000),
      };
    },
  },
  gmail_send: {
    provider: 'gmail',
    description: 'Send an email from the connected Gmail account. args: { to, subject, body, cc (optional) }. Side-effectful WRITE — gated for the user\'s approval in HyperAgents rooms.',
    run: async (token, a) => {
      if (!a.to || !a.subject) throw new Error('gmail_send requires { to, subject, body }');
      const headers = [
        `To: ${a.to}`,
        a.cc ? `Cc: ${a.cc}` : null,
        `Subject: ${a.subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
      ].filter(Boolean).join('\r\n');
      const mime = `${headers}\r\n\r\n${a.body || ''}`;
      const raw = Buffer.from(mime, 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const res = await g('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', token, {
        method: 'POST', body: JSON.stringify({ raw }),
      });
      return { id: res.id, threadId: res.threadId, to: a.to, subject: a.subject, sent: true };
    },
  },
  docs_create: {
    provider: 'google-docs',
    description: 'Create a new Google Doc. args: { title, content (optional initial text) }. Returns documentId + shareable url.',
    run: async (token, a) => {
      const doc = await g('https://docs.googleapis.com/v1/documents', token, {
        method: 'POST', body: JSON.stringify({ title: a.title || 'Untitled' }),
      });
      if (a.content) {
        await g(`https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, token, {
          method: 'POST',
          body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: String(a.content) } }] }),
        });
      }
      return { documentId: doc.documentId, title: doc.title, url: `https://docs.google.com/document/d/${doc.documentId}/edit` };
    },
  },
  docs_append: {
    provider: 'google-docs',
    description: 'Append text to the end of an existing Google Doc. args: { documentId, text }.',
    run: async (token, a) => {
      if (!a.documentId || a.text == null) throw new Error('docs_append requires { documentId, text }');
      const doc = await g(`https://docs.googleapis.com/v1/documents/${a.documentId}`, token);
      const end = (doc.body?.content || []).reduce((mx, el) => Math.max(mx, el.endIndex || 1), 1);
      await g(`https://docs.googleapis.com/v1/documents/${a.documentId}:batchUpdate`, token, {
        method: 'POST',
        body: JSON.stringify({ requests: [{ insertText: { location: { index: Math.max(end - 1, 1) }, text: String(a.text) } }] }),
      });
      return { documentId: a.documentId, appended: String(a.text).length, url: `https://docs.google.com/document/d/${a.documentId}/edit` };
    },
  },
  sheets_create: {
    provider: 'google-sheets',
    description: 'Create a new Google Sheet. args: { title, rows (2-D array; first row = headers) }. Returns spreadsheetId + url.',
    run: async (token, a) => {
      const sheet = await g('https://sheets.googleapis.com/v4/spreadsheets', token, {
        method: 'POST',
        body: JSON.stringify({ properties: { title: a.title || 'Untitled' } }),
      });
      const rows = Array.isArray(a.rows) ? a.rows : [];
      if (rows.length) {
        const values = rows.map(r => (Array.isArray(r) ? r.map(c => (c == null ? '' : String(c))) : [String(r)]));
        await g(`https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`, token, {
          method: 'POST', body: JSON.stringify({ values }),
        });
      }
      return {
        spreadsheetId: sheet.spreadsheetId,
        title: sheet.properties?.title || a.title,
        rows: rows.length,
        url: sheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit`,
      };
    },
  },
  sheets_append: {
    provider: 'google-sheets',
    description: 'Append rows to an existing Google Sheet. args: { spreadsheetId, rows (2-D array) }.',
    run: async (token, a) => {
      if (!a.spreadsheetId || !Array.isArray(a.rows)) throw new Error('sheets_append requires { spreadsheetId, rows[] }');
      const values = a.rows.map(r => (Array.isArray(r) ? r.map(c => (c == null ? '' : String(c))) : [String(r)]));
      await g(`https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`, token, {
        method: 'POST', body: JSON.stringify({ values }),
      });
      return { spreadsheetId: a.spreadsheetId, appended: values.length, url: `https://docs.google.com/spreadsheets/d/${a.spreadsheetId}/edit` };
    },
  },
};

export function listGoogleTools() {
  return Object.entries(GOOGLE_TOOLS).map(([name, def]) => ({ name, description: def.description, provider: def.provider }));
}

/**
 * Execute a native Google tool. scope = { user_id, org_id }.
 * Resolves the right Nango provider token, runs the REST call.
 */
// Provider fallback per primary: same Google account is connected under one of
// these Nango keys, and a broad-scope grant carries Docs/Sheets/Gmail. So if the
// exact product key isn't connected, reuse a sibling Google token (the REST call
// still 403s if that *API* is disabled in GCP — an ops step, not a token issue).
const GOOGLE_PROVIDER_FALLBACKS = {
  'google-sheets': ['google-sheets', 'google-docs', 'gmail'],
  'google-docs': ['google-docs', 'gmail'],
  'gmail': ['gmail'],
};

export async function runGoogleTool(tool, args, scope, db) {
  const def = GOOGLE_TOOLS[tool];
  if (!def) throw new Error(`unknown google tool: ${tool}`);
  const chain = GOOGLE_PROVIDER_FALLBACKS[def.provider] || [def.provider];
  let token = null;
  let lastErr = null;
  for (const provider of chain) {
    try { token = await resolveToken(provider, scope || {}, db); break; }
    catch (e) { lastErr = e; }
  }
  if (!token) throw lastErr || new Error(`no connected Google provider for ${def.provider}`);
  return def.run(token, args || {});
}
