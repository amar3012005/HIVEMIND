/**
 * System email service — send transactional email as the enterprise HIVEMIND
 * account through one provider-neutral transport. Cloudflare Email Sending REST
 * is preferred when configured; the existing Gmail-over-Nango path is a fallback.
 *
 * Design goals (production):
 *   • One call, few lines, anywhere:  await sendSystemEmail({ templateId, to, vars })
 *   • Message copy lives in templates.json — add a type, no code change.
 *   • Never throws / never blocks the caller's flow (login must not fail because
 *     an email failed). Returns a result object instead.
 *   • Quiet by default — structured one-line logs, no console noise.
 *
 * Cloudflare Email Sending (primary):
 *   CLOUDFLARE_EMAIL_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_EMAIL_FROM             (verified sender, defaults to SYSTEM_EMAIL_FROM)
 *
 * Gmail-over-Nango (fallback):
 *   SYSTEM_EMAIL_NANGO_CONNECTION_ID  (the connection_id you used when you
 *                                      connected the enterprise mailbox)
 *   SYSTEM_EMAIL_FROM                 (optional "Name <addr>" From header)
 * If neither provider is configured, the service no-ops gracefully and returns
 * a safe result to the caller. Provider credentials never leave this module.
 *
 * @module core/src/email/email-service
 */

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchBearerFromNango } from '../connectors/mcp/nango-service.js';
import { renderSingulanceTransactionalEmail } from './templates/singulance-transactional.js';
import { renderHivemindWelcomeEmail } from './templates/hivemind-welcome.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Nango provider_config_key (the integration's UNIQUE KEY, not the template
// name). The enterprise mailbox is registered under the 'gmail' integration in
// Nango — its unique_key is 'gmail' (template/provider is 'google-mail').
// Passing 'google-mail' here 404s the /connection lookup. Override via env if
// the mailbox is connected under a different integration key.
const GMAIL_PROVIDER = process.env.SYSTEM_EMAIL_NANGO_PROVIDER_KEY || 'gmail';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const CLOUDFLARE_SEND_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const SEND_TIMEOUT_MS = 15_000;

const APP_URL = process.env.HIVEMIND_APP_URL || 'https://hivemind.davinciai.eu/hivemind/app';
const EMAIL_ASSET_BASE_URL = process.env.HIVEMIND_EMAIL_ASSET_BASE_URL || 'https://next.singulancelabs.com/email/welcome-cartesia/v1';

let _templates = null;
let _warnedNoProvider = false;
let _notificationSink = null;

// Transactional email is deliberately separate from user-connected Gmail. A
// caller selects an approved template and recipient; this module owns
// rendering, provider selection, retries, and safe delivery results.
const EMAIL_ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

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

function recipientDomain(to) {
  return String(to || '').split('@')[1]?.toLowerCase() || 'invalid';
}

function validEmailAddress(value) {
  return typeof value === 'string'
    && value.length <= 320
    && !/[\r\n]/.test(value)
    && EMAIL_ADDRESS.test(value.trim());
}

function validFromHeader(value) {
  return !value || (typeof value === 'string' && value.length <= 512 && !/[\r\n]/.test(value));
}

function configuredProviders() {
  const previewGateway = { url: process.env.HIVEMIND_PREVIEW_EMAIL_GATEWAY_URL || '', token: process.env.HIVEMIND_PREVIEW_EMAIL_GATEWAY_TOKEN || '' };
  const cloudflare = {
    token: process.env.CLOUDFLARE_EMAIL_API_TOKEN || '',
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    from: process.env.CLOUDFLARE_EMAIL_FROM || process.env.SYSTEM_EMAIL_FROM || '',
  };
  const gmail = {
    connectionId: process.env.SYSTEM_EMAIL_NANGO_CONNECTION_ID || '',
    from: process.env.SYSTEM_EMAIL_FROM || '',
  };
  return {
    // Preview delivery is an explicit local-runtime capability. Merely
    // providing a URL/token can never divert a production mail send.
    previewGateway: process.env.HIVEMIND_LOCAL_MODE === 'true' && previewGateway.url && previewGateway.token ? previewGateway : null,
    cloudflare: cloudflare.token && cloudflare.accountId && cloudflare.from ? cloudflare : null,
    gmail: gmail.connectionId ? gmail : null,
  };
}

async function sendWithPreviewGateway({ config, to, rendered, templateId, attachments = [] }) {
  try {
    const res = await fetch(config.url, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ to, subject: rendered.subject, html: rendered.html, text: rendered.text, attachments: normalizeAttachments(attachments) }), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    const payload = await res.json().catch(() => null);
    if (res.ok && payload?.ok) return { ok: true, provider: 'cloudflare_preview_gateway', deliveryStatus: 'queued', messageId: payload.messageId || null };
    return { ok: false, provider: 'cloudflare_preview_gateway', error: payload?.error || `http_${res.status}`, permanent: res.status >= 400 && res.status < 500 };
  } catch { return { ok: false, provider: 'cloudflare_preview_gateway', retryable: true, error: 'request_failed' }; }
}

/** Configure the process-local projection of accepted email into the platform inbox. */
export function configureSystemEmailNotificationSink(sink) {
  _notificationSink = typeof sink === 'function' ? sink : null;
}

async function projectAcceptedEmail({ to, rendered, templateId, result, notification }) {
  if (!result?.ok || !_notificationSink) return result;
  try {
    const projection = await _notificationSink({ to, rendered, templateId, result, notification });
    return { ...result, platformNotification: projection || { created: 0 } };
  } catch (error) {
    // Provider acceptance is authoritative. Inbox projection is independently
    // retryable/observable and must never make a delivered email look failed.
    log('error', 'notification_projection_failed', {
      templateId,
      provider: result.provider,
      recipientDomain: recipientDomain(to),
      error: error?.name || 'projection_error',
    });
    return { ...result, platformNotification: { created: 0, error: 'projection_failed' } };
  }
}

function cloudflareError(payload, fallback) {
  const detail = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  return detail?.code ? `cloudflare_${detail.code}` : fallback;
}

function normalizeAttachments(attachments = []) {
  return attachments.filter((attachment) => attachment?.content && attachment?.filename && attachment?.type)
    .map((attachment) => ({
      content: Buffer.isBuffer(attachment.content) ? attachment.content.toString('base64') : String(attachment.content),
      filename: String(attachment.filename).slice(0, 180),
      type: String(attachment.type).slice(0, 120),
      disposition: 'attachment',
    }));
}

async function sendWithCloudflare({ config, to, from, rendered, templateId, threadHeaders, attachments = [] }) {
  const url = `${CLOUDFLARE_SEND_BASE}/${encodeURIComponent(config.accountId)}/email/sending/send`;
  // Cloudflare's Email Sending API rejects the request outright
  // (errors[0].code 10202, "email.sending.error.email.invalid") if a custom
  // `Message-ID` header is present in `headers` — confirmed live 2026-08-17
  // by isolating each header key against the real API; In-Reply-To/References
  // and arbitrary X-* headers are accepted fine, only Message-ID is rejected.
  // Cloudflare assigns and returns its own message_id in the response instead,
  // so we drop ours for this provider and use theirs as the thread anchor.
  const { 'Message-ID': _ignoredMessageId, ...cfHeaders } = threadHeaders || {};
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to,
          from: from || config.from,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          ...(Object.keys(cfHeaders).length ? { headers: cfHeaders } : {}),
          ...(attachments.length ? { attachments: normalizeAttachments(attachments) } : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const payload = await res.json().catch(() => null);
      const result = payload?.result || {};
      const delivered = Array.isArray(result.delivered) && result.delivered.includes(to);
      const queued = Array.isArray(result.queued) && result.queued.includes(to);
      const bounced = Array.isArray(result.permanent_bounces) && result.permanent_bounces.includes(to);
      if (res.ok && (delivered || queued)) {
        const deliveryStatus = delivered ? 'delivered' : 'queued';
        log('info', 'sent', { provider: 'cloudflare', templateId, recipientDomain: recipientDomain(to), deliveryStatus });
        return { ok: true, provider: 'cloudflare', deliveryStatus, messageId: result.message_id || null };
      }
      if (bounced) {
        log('warn', 'permanent_bounce', { provider: 'cloudflare', templateId, recipientDomain: recipientDomain(to) });
        return { ok: false, provider: 'cloudflare', permanent: true, error: 'permanent_bounce' };
      }
      const transient = res.status === 429 || res.status >= 500;
      const error = cloudflareError(payload, `http_${res.status}`);
      log(transient && attempt === 0 ? 'warn' : 'error', 'send_failed', {
        provider: 'cloudflare', templateId, recipientDomain: recipientDomain(to), status: res.status, error, attempt,
      });
      if (!transient || attempt === 1) return { ok: false, provider: 'cloudflare', retryable: transient, error };
    } catch (err) {
      const retryable = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err instanceof TypeError;
      log(attempt === 0 && retryable ? 'warn' : 'error', 'send_error', {
        provider: 'cloudflare', templateId, recipientDomain: recipientDomain(to), error: err?.name || 'request_error', attempt,
      });
      if (!retryable || attempt === 1) return { ok: false, provider: 'cloudflare', retryable, error: 'request_failed' };
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return { ok: false, provider: 'cloudflare', retryable: true, error: 'send_failed' };
}

async function sendWithGmail({ connectionId, to, from, rendered, templateId, threadHeaders, attachments = [] }) {
  const raw = buildRawMessage({
    to,
    from,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    threadHeaders,
    attachments,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const bearer = await fetchBearerFromNango(GMAIL_PROVIDER, connectionId);
      const res = await fetch(GMAIL_SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const txt = await res.text().catch(() => '');
      if (res.ok) {
        let id;
        try { id = JSON.parse(txt).id; } catch { /* Gmail may omit the id. */ }
        log('info', 'sent', { provider: 'gmail_nango', templateId, recipientDomain: recipientDomain(to), messageId: id });
        return { ok: true, provider: 'gmail_nango', messageId: id, deliveryStatus: 'accepted' };
      }
      const transient = res.status === 429 || res.status >= 500;
      log(transient && attempt === 0 ? 'warn' : 'error', 'send_failed', {
        provider: 'gmail_nango', templateId, recipientDomain: recipientDomain(to), status: res.status, attempt,
      });
      if (!transient || attempt === 1) return { ok: false, provider: 'gmail_nango', retryable: transient, error: `http_${res.status}` };
    } catch (err) {
      log(attempt === 0 ? 'warn' : 'error', 'send_error', {
        provider: 'gmail_nango', templateId, recipientDomain: recipientDomain(to), error: err?.name || 'request_error', attempt,
      });
      if (attempt === 1) return { ok: false, provider: 'gmail_nango', retryable: true, error: 'request_failed' };
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return { ok: false, provider: 'gmail_nango', retryable: true, error: 'send_failed' };
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
  const html = tpl.layout === 'hivemind_cartesia_welcome'
    ? renderHivemindWelcomeEmail({
      preheader,
      name: escapeHtml(ctx.name),
      appUrl: escapeHtml(ctx.appUrl),
      assetBaseUrl: escapeHtml(EMAIL_ASSET_BASE_URL),
      year: escapeHtml(ctx.year),
      orgName: escapeHtml(ctx.orgName),
      accountType: escapeHtml(ctx.accountType),
      welcomeKind: /_login$/.test(templateId) ? 'login' : 'workspace',
      hostingMode: escapeHtml(ctx.hostingMode),
      onboardingEndsAt: escapeHtml(ctx.onboardingEndsAt),
    })
    : tpl.layout === 'singulance_transactional'
      ? renderSingulanceTransactionalEmail({ preheader, innerHtml: inner, year: escapeHtml(ctx.year) })
      : tpl.layout === 'runtime_dark'
        ? renderRuntimeDarkEmail(inner, preheader)
        : wrapHtml(inner, preheader, ctx);
  return { subject, text, html };
}

/**
 * Runtime's dedicated persona theme: full-bleed dark background, text
 * directly on it — deliberately NOT the light card/box shell every other
 * transactional email uses (`wrapHtml`). Matches the dark investor-deck
 * aesthetic Runtime's brand reference uses. No card, no border, no shadow.
 */
function renderRuntimeDarkEmail(inner, preheader) {
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;background:#060b16;padding:0;font-family:Inter,Arial,sans-serif">${pre}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#060b16"><tr><td align="center" style="padding:64px 24px">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%">` +
    `<tr><td>${inner}</td></tr>` +
    `</table></td></tr></table></body></html>`;
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
    `<tr><td style="padding:16px 8px;text-align:center;font-size:11px;color:#a3a3a3">© ${escapeHtml(ctx.year)} SINGULANCE · Sovereign AI</td></tr>` +
    `</table></td></tr></table></body></html>`;
}

/** Build a base64url RFC 5322 multipart/alternative message. */
function buildRawMessage({ to, from, subject, text, html, threadHeaders, attachments = [] }) {
  const boundary = `hm_${Date.now().toString(36)}`;
  const altBoundary = `hm_alt_${Date.now().toString(36)}`;
  const headers = [
    `To: ${to}`,
    from ? `From: ${from}` : null,
    `Subject: ${subject}`,
    threadHeaders?.['Message-ID'] ? `Message-ID: ${threadHeaders['Message-ID']}` : null,
    threadHeaders?.['In-Reply-To'] ? `In-Reply-To: ${threadHeaders['In-Reply-To']}` : null,
    threadHeaders?.References ? `References: ${threadHeaders.References}` : null,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean).join('\r\n');
  const body = [
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    text || '',
    `--${altBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    html || '',
    `--${altBoundary}--`,
    ...normalizeAttachments(attachments).flatMap((attachment) => [
      `--${boundary}`,
      `Content-Type: ${attachment.type}; name="${attachment.filename.replace(/[\r\n"]/g, '')}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename.replace(/[\r\n"]/g, '')}"`,
      '',
      attachment.content,
    ]),
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
 * @param {{inReplyTo?: string, references?: string}} [args.thread]  RFC 5322
 *   threading: pass the thread's root Message-ID to group this send with
 *   prior ones. A fresh Message-ID is always minted for THIS send (returned
 *   as `messageId` in the result) — the caller persists it as the thread
 *   root on the first send, then passes it back in on every later send.
 * @returns {Promise<{ok: boolean, skipped?: boolean, messageId?: string, error?: string}>}
 */
export async function sendSystemEmail({ templateId, to, vars = {}, from, connectionId, thread, attachments = [], notification } = {}) {
  if (!to) return { ok: false, skipped: true, error: 'no_recipient' };
  if (!validEmailAddress(to)) return { ok: false, skipped: true, error: 'invalid_recipient' };
  if (!validFromHeader(from)) return { ok: false, skipped: true, error: 'invalid_sender' };

  const providers = configuredProviders();
  const gmail = connectionId ? { ...providers.gmail, connectionId } : providers.gmail;
  if (!providers.previewGateway && !providers.cloudflare && !gmail) {
    if (!_warnedNoProvider) {
      log('warn', 'no_provider', { hint: 'set CLOUDFLARE_EMAIL_API_TOKEN/CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_EMAIL_FROM or SYSTEM_EMAIL_NANGO_CONNECTION_ID' });
      _warnedNoProvider = true;
    }
    return { ok: false, skipped: true, error: 'no_email_provider' };
  }

  let rendered;
  try {
    rendered = renderTemplate(templateId, vars);
  } catch (err) {
    log('error', 'render_failed', { templateId, error: err.message });
    return { ok: false, error: err.message };
  }

  // Extract the bare domain even from a "Name <user@domain>" From header —
  // splitting the whole header on '@' left a trailing '>' in the domain,
  // confirmed by a failing existing test before this fix.
  const fromDomain = (String(from || providers.cloudflare?.from || providers.gmail?.from || 'runtime.local')
    .match(/@([^\s>]+)/)?.[1]) || 'runtime.local';
  const mintedMessageId = `<${crypto.randomUUID()}@${fromDomain}>`;
  const threadHeaders = {
    'Message-ID': mintedMessageId,
    ...(thread?.inReplyTo ? { 'In-Reply-To': thread.inReplyTo, References: thread.references || thread.inReplyTo } : {}),
  };

  if (providers.previewGateway) {
    const previewResult = await sendWithPreviewGateway({ config: providers.previewGateway, to, rendered, templateId, attachments });
    if (previewResult.ok || previewResult.permanent || (!providers.cloudflare && !gmail)) {
      const result = { ...previewResult, messageId: previewResult.messageId || mintedMessageId };
      return projectAcceptedEmail({ to, rendered, templateId, result, notification });
    }
  }

  if (providers.cloudflare) {
    const cloudflareResult = await sendWithCloudflare({ config: providers.cloudflare, to, from, rendered, templateId, threadHeaders, attachments });
    // Cloudflare rejects our self-minted Message-ID (see sendWithCloudflare) —
    // prefer its own returned message_id for thread continuity; only fall
    // back to our mint if Cloudflare's response is somehow missing one.
    if (cloudflareResult.ok || cloudflareResult.permanent || !gmail) {
      const result = { ...cloudflareResult, messageId: cloudflareResult.messageId || mintedMessageId };
      return projectAcceptedEmail({ to, rendered, templateId, result, notification });
    }
    log('warn', 'provider_fallback', { from: 'cloudflare', to: 'gmail_nango', templateId, recipientDomain: recipientDomain(to) });
  }
  const gmailResult = await sendWithGmail({ connectionId: gmail.connectionId, to, from: from || gmail.from || undefined, rendered, templateId, threadHeaders, attachments });
  const result = { ...gmailResult, messageId: gmailResult.messageId || mintedMessageId };
  return projectAcceptedEmail({ to, rendered, templateId, result, notification });
}

/** Send a fully rendered branded message through the canonical delivery path. */
export async function sendRenderedSystemEmail({ to, rendered, from, connectionId, templateId = 'rendered_message', attachments = [], notification } = {}) {
  if (!to || !validEmailAddress(to)) return { ok: false, skipped: true, error: 'invalid_recipient' };
  if (!rendered?.subject || !rendered?.html) return { ok: false, skipped: true, error: 'invalid_rendered_message' };
  const providers = configuredProviders();
  const gmail = connectionId ? { ...providers.gmail, connectionId } : providers.gmail;
  if (!providers.previewGateway && !providers.cloudflare && !gmail) return { ok: false, skipped: true, error: 'no_email_provider' };
  if (providers.previewGateway) {
    const result = await sendWithPreviewGateway({ config: providers.previewGateway, to, rendered, templateId, attachments });
    if (result.ok || result.permanent || (!providers.cloudflare && !gmail)) return projectAcceptedEmail({ to, rendered, templateId, result, notification });
  }
  if (providers.cloudflare) {
    const result = await sendWithCloudflare({ config: providers.cloudflare, to, from, rendered, templateId, attachments, threadHeaders: {} });
    if (result.ok || result.permanent || !gmail) return projectAcceptedEmail({ to, rendered, templateId, result, notification });
  }
  const result = await sendWithGmail({ connectionId: gmail.connectionId, to, from: from || gmail.from || undefined, rendered, templateId, attachments, threadHeaders: {} });
  return projectAcceptedEmail({ to, rendered, templateId, result, notification });
}

/**
 * Send a named group of approved transactional messages.  The result shape is
 * stable for every caller, while preserving the exact message key chosen by
 * the product flow (for example `member`, `admin`, or `owner`).
 *
 * @param {Array<{key?: string, templateId: string, to: string, vars?: object, from?: string, connectionId?: string}>} messages
 * @returns {Promise<Record<string, object>>}
 */
export async function sendSystemEmailBundle(messages = []) {
  const entries = Array.isArray(messages) ? messages : [];
  const seen = new Set();
  const results = {};
  for (let index = 0; index < entries.length; index += 1) {
    const message = entries[index] || {};
    const key = String(message.key || `message_${index + 1}`);
    if (seen.has(key)) {
      results[key] = { ok: false, skipped: true, error: 'duplicate_message_key' };
      continue;
    }
    seen.add(key);
    // Send in a deliberate order. Some workflows use the first receipt to
    // safely describe the state of the second notification.
    // eslint-disable-next-line no-await-in-loop
    results[key] = await sendSystemEmail(message);
  }
  return results;
}

/**
 * Start transactional delivery without keeping an HTTP request open. This is
 * the canonical handoff for durable product actions: persist the action first,
 * call this function, then reconcile delivery in `onSettled`.
 *
 * The returned object contains no provider secret or recipient content.
 */
export function queueEmailDelivery(execute, { onSettled, context = {} } = {}) {
  const delivery = Promise.resolve()
    .then(execute)
    .then(async (results) => {
      try { await onSettled?.(results); }
      catch (error) { log('error', 'reconciliation_failed', { context: context?.kind || 'system', error: error?.name || 'error' }); }
      return results;
    })
    .catch(async (error) => {
      const results = { delivery: { ok: false, retryable: true, error: 'delivery_failed' } };
      log('error', 'queue_failed', { context: context?.kind || 'system', error: error?.name || 'error' });
      try { await onSettled?.(results); }
      catch (reconciliationError) { log('error', 'reconciliation_failed', { context: context?.kind || 'system', error: reconciliationError?.name || 'error' }); }
      return results;
    });
  return { accepted: true, delivery };
}

export function queueSystemEmailBundle(messages = [], options = {}) {
  return queueEmailDelivery(() => sendSystemEmailBundle(messages), options);
}

/**
 * Send a workspace invitation to the member and a separate confirmation to the
 * inviting administrator. The confirmation never contains the invitation URL
 * or token, so forwarding an admin receipt cannot grant workspace access.
 */
export async function sendTeamInvitationEmails({ memberEmail, adminEmail, vars = {} } = {}) {
  const { member } = await sendSystemEmailBundle([{ key: 'member', templateId: 'team_invite', to: memberEmail, vars }]);
  const admin = adminEmail
    ? (await sendSystemEmailBundle([{ key: 'admin', templateId: 'team_invite_admin_confirmation', to: adminEmail, vars: {
      ...vars,
      inviteeEmail: memberEmail,
      deliveryState: member.ok ? (member.deliveryStatus || 'accepted') : 'failed',
    } }])).admin
    : { ok: false, skipped: true, error: 'no_admin_email' };
  return { member, admin };
}

/**
 * Send the same template to many recipients, throttled to respect Gmail's
 * send quota. Sequential with a per-message delay (not parallel) — keeps us
 * well under rate limits and avoids burst spam-flagging. Never throws.
 *
 * Stops early if the sender connection is unconfigured (no point looping).
 *
 * @param {Array<{email:string}|string>} recipients
 * @param {object} opts
 * @param {string} opts.templateId
 * @param {(r:any)=>Record<string,any>} [opts.varsFor]  per-recipient template vars
 * @param {number} [opts.perMessageDelayMs=700]
 * @param {string} [opts.from]
 * @param {string} [opts.connectionId]
 * @returns {Promise<{total:number,sent:number,failed:number,skipped:number,errors:string[]}>}
 */
export async function sendSystemEmailBatch(recipients = [], opts = {}) {
  const { templateId, varsFor, perMessageDelayMs = 700, from, connectionId } = opts;
  const result = { total: recipients.length, sent: 0, failed: 0, skipped: 0, errors: [] };
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const to = typeof r === 'string' ? r : r?.email;
    if (!to) { result.skipped += 1; continue; }
    const vars = varsFor ? varsFor(r) : {};
    // eslint-disable-next-line no-await-in-loop
    const res = await sendSystemEmail({ templateId, to, vars, from, connectionId });
    if (res.ok) {
      result.sent += 1;
    } else if (res.skipped) {
      result.skipped += 1;
      if (res.error === 'no_email_provider') {
        result.errors.push('no_email_provider — aborting batch');
        break;
      }
    } else {
      result.failed += 1;
      if (result.errors.length < 10) result.errors.push(`${to}: ${res.error}`);
    }
    if (perMessageDelayMs && i < recipients.length - 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, perMessageDelayMs));
    }
  }
  return result;
}

export default {
  sendSystemEmail,
  sendRenderedSystemEmail,
  sendSystemEmailBatch,
  sendSystemEmailBundle,
  queueEmailDelivery,
  queueSystemEmailBundle,
  sendTeamInvitationEmails,
  configureSystemEmailNotificationSink,
  renderTemplate,
};
