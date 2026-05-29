/**
 * System email service — send transactional email as the enterprise HIVEMIND
 * account via the existing Gmail-over-Nango path. No new vendor, no SMTP creds.
 *
 * Design goals (production):
 *   • One call, few lines, anywhere:  await sendSystemEmail({ templateId, to, vars })
 *   • Message copy lives in templates.json — add a type, no code change.
 *   • Never throws / never blocks the caller's flow (login must not fail because
 *     an email failed). Returns a result object instead.
 *   • Quiet by default — structured one-line logs, no console noise.
 *
 * Fixed sender: a single enterprise Gmail connection in Nango, identified by
 *   SYSTEM_EMAIL_NANGO_CONNECTION_ID  (the connection_id you used when you
 *                                      connected the enterprise mailbox)
 *   SYSTEM_EMAIL_FROM                 (optional "Name <addr>" From header)
 * If the connection id is absent, the service no-ops gracefully (logs once).
 *
 * @module core/src/email/email-service
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchBearerFromNango } from '../connectors/mcp/nango-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Nango provider_config_key (the integration's UNIQUE KEY, not the template
// name). The enterprise mailbox is registered under the 'gmail' integration in
// Nango — its unique_key is 'gmail' (template/provider is 'google-mail').
// Passing 'google-mail' here 404s the /connection lookup. Override via env if
// the mailbox is connected under a different integration key.
const GMAIL_PROVIDER = process.env.SYSTEM_EMAIL_NANGO_PROVIDER_KEY || 'gmail';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const SEND_TIMEOUT_MS = 15_000;

const CONNECTION_ID = process.env.SYSTEM_EMAIL_NANGO_CONNECTION_ID || '';
const FROM_HEADER = process.env.SYSTEM_EMAIL_FROM || '';
const APP_URL = process.env.HIVEMIND_APP_URL || 'https://hivemind.davinciai.eu/hivemind/app';

let _templates = null;
let _warnedNoConnection = false;

function log(level, event, extra = {}) {
  const rec = { svc: 'email', level, event, ...extra };
  // single structured line — keep prod logs quiet and greppable
  (level === 'error' ? console.error : console.log)(JSON.stringify(rec));
}

function loadTemplates() {
  if (_templates) return _templates;
  const raw = readFileSync(join(__dirname, 'templates.json'), 'utf8');
  _templates = JSON.parse(raw);
  return _templates;
}

/** Escape a value for safe interpolation into an HTML context. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Replace {{key}} tokens. `escape` toggles HTML escaping of values. */
function fill(str, vars, escape) {
  return String(str).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    if (v === undefined || v === null) return '';
    return escape ? escapeHtml(v) : String(v);
  });
}

/** Base64url-encode a UTF-8 string for the Gmail `raw` field. */
function toBase64Url(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Render a template into { subject, text, html }.
 * @param {string} templateId
 * @param {Record<string, any>} vars
 */
export function renderTemplate(templateId, vars = {}) {
  const templates = loadTemplates();
  const tpl = templates[templateId];
  if (!tpl) throw new Error(`unknown_template:${templateId}`);
  const ctx = { appUrl: APP_URL, year: new Date().getFullYear(), ...vars };
  const subject = fill(tpl.subject, ctx, false);
  const text = tpl.text ? fill(tpl.text, ctx, false) : '';
  const inner = tpl.html ? fill(tpl.html, ctx, true) : `<p>${escapeHtml(text)}</p>`;
  const preheader = tpl.preheader ? fill(tpl.preheader, ctx, true) : '';
  const html = wrapHtml(inner, preheader, ctx);
  return { subject, text, html };
}

/** Wrap inner HTML in a minimal, email-client-safe shell. */
function wrapHtml(inner, preheader, ctx) {
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;background:#faf9f4;padding:32px 0;font-family:Inter,Arial,sans-serif">${pre}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:92%">` +
    `<tr><td style="background:#fff;border:1px solid #e3e0db;border-radius:20px;padding:32px">${inner}</td></tr>` +
    `<tr><td style="padding:16px 8px;text-align:center;font-size:11px;color:#a3a3a3">© ${escapeHtml(ctx.year)} Da'vinci Solutions · Sovereign AI</td></tr>` +
    `</table></td></tr></table></body></html>`;
}

/** Build a base64url RFC 5322 multipart/alternative message. */
function buildRawMessage({ to, from, subject, text, html }) {
  const boundary = `hm_${Date.now().toString(36)}`;
  const headers = [
    `To: ${to}`,
    from ? `From: ${from}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean).join('\r\n');
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    text || '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    html || '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return toBase64Url(`${headers}\r\n\r\n${body}`);
}

/**
 * Send a system email. Fire-and-forget safe: never throws.
 *
 * @param {object} args
 * @param {string} args.templateId   key in templates.json (e.g. 'welcome_login')
 * @param {string} args.to           recipient address
 * @param {Record<string,any>} [args.vars]   placeholder values (name, orgName, ...)
 * @param {string} [args.from]       override From header (defaults to SYSTEM_EMAIL_FROM)
 * @param {string} [args.connectionId]  override Nango sender connection id
 * @returns {Promise<{ok: boolean, skipped?: boolean, messageId?: string, error?: string}>}
 */
export async function sendSystemEmail({ templateId, to, vars = {}, from, connectionId } = {}) {
  const sender = connectionId || CONNECTION_ID;
  if (!sender) {
    if (!_warnedNoConnection) {
      log('warn', 'no_sender_connection', { hint: 'set SYSTEM_EMAIL_NANGO_CONNECTION_ID' });
      _warnedNoConnection = true;
    }
    return { ok: false, skipped: true, error: 'no_sender_connection' };
  }
  if (!to) return { ok: false, skipped: true, error: 'no_recipient' };

  let rendered;
  try {
    rendered = renderTemplate(templateId, vars);
  } catch (err) {
    log('error', 'render_failed', { templateId, error: err.message });
    return { ok: false, error: err.message };
  }

  const raw = buildRawMessage({
    to,
    from: from || FROM_HEADER || undefined,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });

  // One retry on transient (429 / 5xx). Token fetched fresh per send attempt.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const bearer = await fetchBearerFromNango(GMAIL_PROVIDER, sender);
      const res = await fetch(GMAIL_SEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const txt = await res.text().catch(() => '');
      if (res.ok) {
        let id;
        try { id = JSON.parse(txt).id; } catch { /* ignore */ }
        log('info', 'sent', { templateId, to, messageId: id });
        return { ok: true, messageId: id };
      }
      const transient = res.status === 429 || res.status >= 500;
      log(transient && attempt === 0 ? 'warn' : 'error', 'send_failed', {
        templateId, to, status: res.status, body: txt.slice(0, 200), attempt,
      });
      if (!transient) return { ok: false, error: `http_${res.status}` };
    } catch (err) {
      log(attempt === 0 ? 'warn' : 'error', 'send_error', { templateId, to, error: err.message, attempt });
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
  }
  return { ok: false, error: 'send_failed' };
}

export default { sendSystemEmail, renderTemplate };
