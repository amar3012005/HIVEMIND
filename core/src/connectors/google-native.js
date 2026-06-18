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

// ─── Markdown → polished Google Doc renderer (in-tool, with NATIVE tables) ───
// Agents write the doc body in markdown; this renders headings, bold, bullet +
// numbered lists, AND real drawn Google Docs tables (insertTable + populated
// cells), not a plain text dump. A markdown table block becomes an actual table.

async function _docsGet(token, id) {
  return g(`https://docs.googleapis.com/v1/documents/${id}`, token);
}
async function _docsBatch(token, id, requests) {
  if (!requests || !requests.length) return;
  await g(`https://docs.googleapis.com/v1/documents/${id}:batchUpdate`, token, {
    method: 'POST', body: JSON.stringify({ requests }),
  });
}
function _bodyEnd(doc) {
  const c = doc.body?.content || [];
  return c.length ? (c[c.length - 1].endIndex || 1) : 1;
}

// Split markdown into ordered blocks: { kind:'text', lines:[] } | { kind:'table', rows:[[cell]] }.
function _parseBlocks(content) {
  const lines = String(content || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let cur = null;
  for (const ln of lines) {
    if (/^\s*\|.*\|\s*$/.test(ln)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(ln)) continue; // |---| separator
      const cells = ln.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      if (!cur || cur.kind !== 'table') { cur = { kind: 'table', rows: [] }; blocks.push(cur); }
      cur.rows.push(cells);
    } else {
      if (!cur || cur.kind !== 'text') { cur = { kind: 'text', lines: [] }; blocks.push(cur); }
      cur.lines.push(ln);
    }
  }
  return blocks;
}

// Build insertText + style requests for a text block, inserted at `start`.
function _textRequests(lines, start) {
  let text = '';
  let cursor = start;
  const paraStyles = [];
  const bulletRanges = [];
  const boldRanges = [];
  const parseBold = (line, base) => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (line[i] === '*' && line[i + 1] === '*') {
        const close = line.indexOf('**', i + 2);
        if (close !== -1) {
          const inner = line.slice(i + 2, close);
          const s = base + out.length;
          out += inner;
          boldRanges.push({ start: s, end: base + out.length });
          i = close + 2; continue;
        }
      }
      out += line[i]; i += 1;
    }
    return out;
  };
  for (const raw of lines) {
    let line = raw;
    let type = null;
    let bullet = null;
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      type = h[1].length === 1 ? 'HEADING_1' : h[1].length === 2 ? 'HEADING_2' : 'HEADING_3';
      line = h[2];
    } else if (/^\s*[-*+]\s+/.test(line)) {
      bullet = 'BULLET_DISC_CIRCLE_SQUARE'; line = line.replace(/^\s*[-*+]\s+/, '');
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      bullet = 'NUMBERED_DECIMAL_ALPHA_ROMAN'; line = line.replace(/^\s*\d+[.)]\s+/, '');
    }
    const lineStart = cursor;
    const stripped = parseBold(line, lineStart);
    const piece = `${stripped}\n`;
    text += piece; cursor += piece.length;
    const lineEnd = cursor;
    if (type) paraStyles.push({ start: lineStart, end: lineEnd, type });
    if (bullet) bulletRanges.push({ start: lineStart, end: lineEnd, preset: bullet });
  }
  if (!text) return [];
  const requests = [{ insertText: { location: { index: start }, text } }];
  for (const p of paraStyles) requests.push({ updateParagraphStyle: {
    range: { startIndex: p.start, endIndex: p.end }, paragraphStyle: { namedStyleType: p.type }, fields: 'namedStyleType' } });
  for (const b of bulletRanges) requests.push({ createParagraphBullets: {
    range: { startIndex: b.start, endIndex: b.end }, bulletPreset: b.preset } });
  for (const r of boldRanges) if (r.end > r.start) requests.push({ updateTextStyle: {
    range: { startIndex: r.start, endIndex: r.end }, textStyle: { bold: true }, fields: 'bold' } });
  return requests;
}

// Render a whole markdown doc, drawing native tables. Processes blocks in order,
// always appending at the current end of the body. For tables: insertTable, then
// re-fetch to read real cell indices and populate them (reverse-order inserts so
// earlier cells' indices stay valid), then bold the header row.
async function renderMarkdownDoc(token, id, content) {
  const blocks = _parseBlocks(content);
  for (const b of blocks) {
    const doc = await _docsGet(token, id);
    const at = Math.max(_bodyEnd(doc) - 1, 1);
    if (b.kind === 'text') {
      await _docsBatch(token, id, _textRequests(b.lines, at));
      continue;
    }
    // native table
    const nRows = b.rows.length;
    const nCols = Math.max(...b.rows.map(r => r.length), 1);
    if (nRows < 1) continue;
    await _docsBatch(token, id, [{ insertTable: { rows: nRows, columns: nCols, location: { index: at } } }]);
    const doc2 = await _docsGet(token, id);
    const el = (doc2.body?.content || []).find(e => e.table && e.startIndex >= at);
    if (!el || !el.table) continue;
    const inserts = [];
    el.table.tableRows.forEach((row, r) => {
      row.tableCells.forEach((cell, c) => {
        const val = (b.rows[r] && b.rows[r][c] != null) ? String(b.rows[r][c]).replace(/\*\*/g, '') : '';
        const idx = cell.content?.[0]?.startIndex;
        if (val && idx != null) inserts.push({ index: idx, text: val });
      });
    });
    inserts.sort((x, y) => y.index - x.index); // reverse → lower indices stay valid
    await _docsBatch(token, id, inserts.map(i => ({ insertText: { location: { index: i.index }, text: i.text } })));
    // bold the header row (re-fetch for accurate ranges after text inserts)
    const doc3 = await _docsGet(token, id);
    const el3 = (doc3.body?.content || []).find(e => e.table && e.startIndex >= at);
    const headerCells = el3?.table?.tableRows?.[0]?.tableCells || [];
    const boldReqs = [];
    for (const cell of headerCells) {
      const p = cell.content?.[0];
      if (p?.startIndex != null && p?.endIndex != null && p.endIndex - 1 > p.startIndex) {
        boldReqs.push({ updateTextStyle: {
          range: { startIndex: p.startIndex, endIndex: p.endIndex - 1 },
          textStyle: { bold: true }, fields: 'bold' } });
      }
    }
    await _docsBatch(token, id, boldReqs);
  }
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
    description: 'Create a new Google Doc. args: { title, content (markdown: # headings, **bold**, - bullets, 1. lists, | tables |) }. Rendered into a polished document. Returns documentId + url.',
    run: async (token, a) => {
      const doc = await g('https://docs.googleapis.com/v1/documents', token, {
        method: 'POST', body: JSON.stringify({ title: a.title || 'Untitled' }),
      });
      if (a.content) {
        await renderMarkdownDoc(token, doc.documentId, String(a.content));
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
