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

// RFC-2047 encode a header value when it contains non-ASCII, so email Subjects with umlauts/accents
// (German/French/etc.) render correctly instead of mojibake. Pure-ASCII passes through unchanged.
function _encodeHeader(s) {
  const v = String(s || '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

// ─── Markdown → email-safe HTML (agents write markdown; Gmail must not show raw ** | ```) ───
// Inline-styled (email clients strip <style>), bounded subset: headings, bold/italic,
// links, inline code, bullet/numbered lists, tables, hr, code fences. mermaid fences are
// STRIPPED (never emailable as text) and replaced with a short note — "(diagram attached)"
// when the send carries image attachments, else "(diagram available in the room)".
function _escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _mdInline(s) {
  return _escHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code style="background:#f4f4f4;padding:1px 4px;border-radius:3px;font-size:90%">$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" style="color:#117dff">$1</a>');
}
function _mdToHtml(md, { hasAttachments = false } = {}) {
  const note = hasAttachments ? '(diagram attached)' : '(diagram available in the HIVEMIND room)';
  // Pull out fenced blocks first (```mermaid → note token; other fences → pre token).
  const src = String(md || '').replace(/\r/g, '')
    .replace(/```mermaid[\s\S]*?```/g, '\n@@MERMAIDNOTE@@\n')
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `\n@@PRE${Buffer.from(code).toString('base64')}@@\n`);
  const out = [];
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*\|[\s:|-]+\|\s*$/.test(ln)) continue; // |---| separator
    if (/^\s*\|.*\|\s*$/.test(ln)) {               // table block
      closeList();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) {
          rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => _mdInline(c.trim())));
        }
        i++;
      }
      i--;
      const [head, ...tbody] = rows;
      out.push('<table style="border-collapse:collapse;margin:12px 0;font-size:14px">');
      if (head) out.push('<tr>' + head.map(c => `<th style="border:1px solid #ddd;padding:6px 10px;background:#f7f7f5;text-align:left">${c}</th>`).join('') + '</tr>');
      tbody.forEach(r => out.push('<tr>' + r.map(c => `<td style="border:1px solid #ddd;padding:6px 10px">${c}</td>`).join('') + '</tr>'));
      out.push('</table>');
      continue;
    }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); const lv = h[1].length; out.push(`<h${lv + 1} style="margin:16px 0 6px;font-size:${20 - lv * 2}px">${_mdInline(h[2])}</h${lv + 1}>`); continue; }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(ln)) { closeList(); out.push('<hr style="border:none;border-top:1px solid #e3e0db;margin:14px 0">'); continue; }
    const bullet = ln.match(/^\s*[-*•]\s+(.*)$/);
    const num = ln.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || num) {
      const want = bullet ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want} style="margin:6px 0 6px 22px;padding:0">`); list = want; }
      out.push(`<li style="margin:3px 0">${_mdInline((bullet || num)[1])}</li>`);
      continue;
    }
    closeList();
    if (!ln.trim()) continue;
    if (/^@@MERMAIDNOTE@@$/.test(ln.trim())) { out.push(`<p style="margin:8px 0;color:#737373"><em>${note}</em></p>`); continue; }
    const pre = ln.trim().match(/^@@PRE([A-Za-z0-9+/=]*)@@$/);
    if (pre) {
      out.push(`<pre style="background:#f7f7f5;border:1px solid #e3e0db;padding:10px;overflow-x:auto;font-size:13px">${_escHtml(Buffer.from(pre[1], 'base64').toString('utf8'))}</pre>`);
      continue;
    }
    out.push(`<p style="margin:8px 0">${_mdInline(ln)}</p>`);
  }
  closeList();
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a1a1a;max-width:680px">${out.join('\n')}</div>`;
}
// Readable plain-text fallback for the multipart/alternative — markdown tokens stripped.
function _mdToPlain(md) {
  return String(md || '').replace(/\r/g, '')
    .replace(/```mermaid[\s\S]*?```/g, '(diagram omitted)')
    .replace(/```\w*\n?([\s\S]*?)```/g, '$1')
    .replace(/^\s*\|[\s:|-]+\|\s*$/gm, '')
    .replace(/^\s*\|(.*)\|\s*$/gm, (_, r) => r.split('|').map(c => c.trim()).join(' — '))
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/^#{1,4}\s+/gm, '').replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)');
}

// RFC-2822 MIME → base64url for Gmail send/draft. threadId/inReplyTo optional.
// html → multipart/alternative (plain + html). attachments [{filename, mime, data_b64}]
// → multipart/mixed wrapping the alternative. No html/attachments → text/plain (unchanged).
function _gmailRaw({ to, subject, body, html, cc, inReplyTo, references, attachments }) {
  const top = [
    to ? `To: ${to}` : null,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${_encodeHeader(subject)}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    'MIME-Version: 1.0',
  ].filter(Boolean);
  let payload;
  const atts = (attachments || []).filter(a => a && a.filename && a.data_b64).slice(0, 6); // bounded
  if (!html && !atts.length) {
    payload = top.concat(['Content-Type: text/plain; charset="UTF-8"']).join('\r\n')
      + `\r\n\r\n${body || ''}`;
  } else {
    const altB = `alt${Date.now().toString(36)}`;
    const alt = [
      `--${altB}`, 'Content-Type: text/plain; charset="UTF-8"', '', body || '',
      `--${altB}`, 'Content-Type: text/html; charset="UTF-8"', '', html || `<pre>${_escHtml(body || '')}</pre>`,
      `--${altB}--`,
    ].join('\r\n');
    if (!atts.length) {
      payload = top.concat([`Content-Type: multipart/alternative; boundary="${altB}"`]).join('\r\n')
        + `\r\n\r\n${alt}`;
    } else {
      const mixB = `mix${Date.now().toString(36)}`;
      const parts = [
        `--${mixB}`, `Content-Type: multipart/alternative; boundary="${altB}"`, '', alt,
      ];
      for (const a of atts) {
        parts.push(
          `--${mixB}`,
          `Content-Type: ${a.mime || 'application/octet-stream'}; name="${a.filename}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${a.filename}"`,
          '', String(a.data_b64).replace(/[^A-Za-z0-9+/=]/g, ''),
        );
      }
      parts.push(`--${mixB}--`);
      payload = top.concat([`Content-Type: multipart/mixed; boundary="${mixB}"`]).join('\r\n')
        + `\r\n\r\n${parts.join('\r\n')}`;
    }
  }
  return Buffer.from(payload, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
        const m = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`, token);
        const h = Object.fromEntries((m.payload?.headers || []).map(x => [x.name, x.value]));
        messages.push({ id, threadId: m.threadId, subject: h.Subject || '(no subject)', from: h.From || '', to: h.To || '', date: h.Date || '', snippet: m.snippet || '' });
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
    description: 'Send an email directly. args: { to, subject, body, cc }. (In HyperAgents the agent path saves a draft + approval; this is the raw send used as a fallback.)',
    run: async (token, a) => {
      if (!a.to || !a.subject) throw new Error('gmail_send requires { to, subject, body }');
      // markdown:true → the body is agent-written markdown: send polished HTML
      // (multipart/alternative) instead of raw asterisks/pipes in the inbox.
      const args = a.markdown
        ? { ...a, html: _mdToHtml(a.body, { hasAttachments: (a.attachments || []).length > 0 }), body: _mdToPlain(a.body) }
        : a;
      const raw = _gmailRaw(args);
      const res = await g('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', token, {
        method: 'POST', body: JSON.stringify({ raw, threadId: a.threadId || undefined }),
      });
      return { id: res.id, threadId: res.threadId, to: a.to, subject: a.subject, sent: true };
    },
  },
  gmail_create_draft: {
    provider: 'gmail',
    description: 'Save an email as a Gmail DRAFT (not sent). args: { to, subject, body, cc, threadId (for replies) }. Returns draftId + a Drafts link.',
    run: async (token, a) => {
      if (!a.to && !a.threadId) throw new Error('gmail_create_draft requires { to } (or threadId for a reply)');
      // markdown:true → draft saved with a polished HTML alternative (see gmail_send).
      const args = a.markdown
        ? { ...a, html: _mdToHtml(a.body, { hasAttachments: (a.attachments || []).length > 0 }), body: _mdToPlain(a.body) }
        : a;
      const raw = _gmailRaw(args);
      const message = { raw };
      if (a.threadId) message.threadId = a.threadId;
      const res = await g('https://gmail.googleapis.com/gmail/v1/users/me/drafts', token, {
        method: 'POST', body: JSON.stringify({ message }),
      });
      return {
        draftId: res.id,
        messageId: res.message?.id,
        threadId: res.message?.threadId,
        to: a.to, subject: a.subject,
        url: 'https://mail.google.com/mail/u/0/#drafts',
      };
    },
  },
  gmail_send_draft: {
    provider: 'gmail',
    description: 'Send an existing Gmail draft. args: { draftId }.',
    run: async (token, a) => {
      if (!a.draftId) throw new Error('gmail_send_draft requires { draftId }');
      const res = await g('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', token, {
        method: 'POST', body: JSON.stringify({ id: a.draftId }),
      });
      return { id: res.id, threadId: res.threadId, sent: true };
    },
  },
  gmail_list_drafts: {
    provider: 'gmail',
    description: 'List saved Gmail drafts. args: { max (default 10) }.',
    run: async (token, a) => {
      const max = Math.min(Math.max(parseInt(a.max, 10) || 10, 1), 30);
      const list = await g(`https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=${max}`, token);
      const drafts = [];
      for (const d of (list.drafts || []).slice(0, max)) {
        const full = await g(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${d.id}?format=metadata`, token);
        const h = Object.fromEntries((full.message?.payload?.headers || []).map(x => [x.name, x.value]));
        drafts.push({ draftId: d.id, subject: h.Subject || '', to: h.To || '', snippet: full.message?.snippet || '' });
      }
      return { count: drafts.length, drafts };
    },
  },
  gmail_get_thread: {
    provider: 'gmail',
    description: 'Fetch a full Gmail thread (all messages). args: { threadId }.',
    run: async (token, a) => {
      if (!a.threadId) throw new Error('gmail_get_thread requires { threadId }');
      const t = await g(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${a.threadId}?format=full`, token);
      const messages = (t.messages || []).map(m => {
        const h = Object.fromEntries((m.payload?.headers || []).map(x => [x.name, x.value]));
        return { id: m.id, from: h.From || '', to: h.To || '', date: h.Date || '', subject: h.Subject || '', body: extractBody(m.payload).slice(0, 6000) };
      });
      return { threadId: a.threadId, count: messages.length, messages };
    },
  },
  gmail_list_labels: {
    provider: 'gmail',
    description: 'List Gmail labels (id + name). No args.',
    run: async (token) => {
      const r = await g('https://gmail.googleapis.com/gmail/v1/users/me/labels', token);
      return { labels: (r.labels || []).map(l => ({ id: l.id, name: l.name, type: l.type })) };
    },
  },
  gmail_modify: {
    provider: 'gmail',
    description: 'Modify a message: add/remove labels, mark read (remove UNREAD), archive (remove INBOX). args: { id, addLabelIds[], removeLabelIds[] }.',
    run: async (token, a) => {
      if (!a.id) throw new Error('gmail_modify requires { id }');
      const r = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${a.id}/modify`, token, {
        method: 'POST',
        body: JSON.stringify({ addLabelIds: a.addLabelIds || [], removeLabelIds: a.removeLabelIds || [] }),
      });
      return { id: r.id, labelIds: r.labelIds || [] };
    },
  },
  gmail_trash: {
    provider: 'gmail',
    description: 'Move a message to Trash (reversible). args: { id }.',
    run: async (token, a) => {
      if (!a.id) throw new Error('gmail_trash requires { id }');
      const r = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${a.id}/trash`, token, { method: 'POST', body: '{}' });
      return { id: r.id, trashed: true };
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
  drive_search: {
    provider: 'google-docs',
    description: 'Search Google Drive (docs, sheets, slides, files) by name/content. args: { query, max (default 8) }. Returns id/name/type/url per file.',
    run: async (token, a) => {
      const max = Math.min(Math.max(parseInt(a.max, 10) || 8, 1), 20);
      const raw = String(a.query || '').replace(/['\\]/g, ' ').trim();
      if (!raw) return { count: 0, files: [] };
      // OR over individual terms (>3 chars) — a single `contains '<phrase>'` is an
      // exact-phrase match and misses everything. Cap at 6 terms.
      const terms = [...new Set(raw.split(/\s+/).filter(w => w.length > 3))].slice(0, 6);
      const list = terms.length ? terms : [raw];
      const clause = list.map(t => `name contains '${t}' or fullText contains '${t}'`).join(' or ');
      const q = encodeURIComponent(`(${clause}) and trashed = false`);
      const r = await g(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=${max}&fields=files(id,name,mimeType,webViewLink,modifiedTime)&orderBy=modifiedTime desc`, token);
      const TYPE = {
        'application/vnd.google-apps.document': 'doc',
        'application/vnd.google-apps.spreadsheet': 'sheet',
        'application/vnd.google-apps.presentation': 'slides',
      };
      const files = (r.files || []).map(f => ({
        id: f.id, name: f.name, type: TYPE[f.mimeType] || 'file',
        url: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
        modified: f.modifiedTime || '',
      }));
      return { count: files.length, files };
    },
  },
  docs_get: {
    provider: 'google-docs',
    description: "Read an existing Google Doc's text by id. args: { documentId } (or { id }). Returns { documentId, title, text } — the plain-text body for grounding/context. READ-only.",
    run: async (token, a) => {
      const id = String(a.documentId || a.id || '').trim();
      if (!id) return { error: 'documentId required' };
      const doc = await g(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}`, token);
      const out = [];
      const walk = (elements) => {
        for (const el of (elements || [])) {
          if (el.paragraph) {
            for (const pe of (el.paragraph.elements || [])) {
              if (pe.textRun && pe.textRun.content) out.push(pe.textRun.content);
            }
          } else if (el.table) {
            for (const row of (el.table.tableRows || [])) {
              for (const cell of (row.tableCells || [])) walk(cell.content);
            }
          }
        }
      };
      walk(((doc || {}).body || {}).content);
      // Cap the body so a huge doc can't blow the agent's context window.
      const text = out.join('').trim().slice(0, 12000);
      return { documentId: id, title: doc.title || '', text };
    },
  },
  sheets_get: {
    provider: 'google-sheets',
    description: "Read an existing Google Sheet's cell values by id. args: { spreadsheetId } (or { id }), optional { range } (default 'A1:Z500', first sheet). Returns { spreadsheetId, range, rows }. READ-only.",
    run: async (token, a) => {
      const id = String(a.spreadsheetId || a.id || '').trim();
      if (!id) return { error: 'spreadsheetId required' };
      const range = String(a.range || 'A1:Z500').trim();
      const r = await g(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`, token);
      const rows = (r.values || []).slice(0, 500);
      return { spreadsheetId: id, range: r.range || range, rows };
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
  'google-docs': ['google-docs', 'google-sheets', 'gmail'],
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
