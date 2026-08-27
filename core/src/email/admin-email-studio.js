const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENDER_LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/i;

export const ADMIN_EMAIL_SENDER_DOMAINS = Object.freeze([
  'admin.singulancelabs.com',
  'runtime.singulancelabs.com',
  'founder.singulancelabs.com',
]);

// The Admin surface sends only these low-risk, server-owned messages. Secure
// enterprise invitations remain on their dedicated lifecycle so an activation
// link and its one-time code can never be hand-authored in the browser.
export const ADMIN_EMAIL_TEMPLATES = Object.freeze({
  welcome_signup: 'Welcome to HIVEMIND',
  welcome_login: 'Welcome back to HIVEMIND',
});

function boundedText(value, label, maxLength, { required = false } = {}) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > maxLength) throw new Error(`${label} is too long`);
  return text;
}

function recipientsFrom(input = {}) {
  const values = Array.isArray(input.recipients)
    ? input.recipients
    : String(input.recipients || input.to || '').split(/[\s,;]+/);
  const recipients = [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
  if (!recipients.length) throw new Error('At least one recipient is required');
  if (recipients.length > 200) throw new Error('A single send is limited to 200 recipients');
  if (recipients.some((email) => !EMAIL_ADDRESS.test(email))) throw new Error('One or more recipient emails are invalid');
  return recipients;
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function renderAdminComposerMessage(message) {
  const text = message.body;
  if (!message.visual) {
    return {
      subject: message.subject,
      text,
      html: `<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,sans-serif;white-space:pre-wrap;color:#111">${escapeHtml(text)}</body></html>`,
    };
  }
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => `<p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#525252">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('');
  return {
    subject: message.subject,
    text,
    html: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#faf9f4;font-family:Inter,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:36px 16px"><table role="presentation" width="620" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;background:#fff;border:1px solid #e3e0db"><tr><td style="padding:24px 30px;border-bottom:1px solid #e3e0db"><div style="font-size:18px;font-weight:800;letter-spacing:.12em;color:#0a0a0a">SINGULANCE</div><div style="margin-top:5px;font:10px monospace;letter-spacing:.22em;color:#a3a3a3">HIVEMIND · OPERATING SYSTEM</div></td></tr><tr><td style="padding:34px 30px"><div style="margin-bottom:18px;font:10px monospace;letter-spacing:.18em;color:#117dff">SYSTEM MESSAGE</div>${paragraphs}</td></tr><tr><td style="padding:18px 30px;border-top:1px solid #e3e0db;font:10px monospace;letter-spacing:.12em;color:#a3a3a3">SINGULANCE · SOVEREIGN AI OPERATING SYSTEM</td></tr></table></td></tr></table></body></html>`,
  };
}

/**
 * Normalize the only inputs an operator may supply to a manual transaction.
 * The sender, template markup and destination app URL remain server-owned.
 */
export function normalizeAdminEmailMessage(input = {}, { appUrl } = {}) {
  const templateId = boundedText(input.template_id || 'custom', 'Template', 64, { required: true });
  const custom = templateId === 'custom' || input.subject || input.body;
  const recipients = recipientsFrom(input);
  const senderDomain = boundedText(input.sender_domain || 'admin.singulancelabs.com', 'Sender domain', 120).toLowerCase();
  if (!ADMIN_EMAIL_SENDER_DOMAINS.includes(senderDomain)) throw new Error('Sender domain is unavailable');
  const senderLocal = boundedText(input.sender_local || 'welcome', 'Sender prefix', 64).toLowerCase();
  if (!SENDER_LOCAL_PART.test(senderLocal)) throw new Error('Sender prefix is invalid');
  const fromName = boundedText(input.from_name || 'Singulance', 'Sender name', 120);
  const fromAddress = `${senderLocal}@${senderDomain}`;
  const from = fromName ? `${fromName} <${fromAddress}>` : fromAddress;

  if (custom) {
    const subject = boundedText(input.subject, 'Subject', 180, { required: true });
    const body = String(input.body || '').trim();
    if (!body) throw new Error('Message body is required');
    if (body.length > 100000) throw new Error('Message body is too long');
    return { templateId: 'custom', recipients, to: recipients[0], from, fromAddress, subject, body, visual: input.visual !== false };
  }
  if (!Object.hasOwn(ADMIN_EMAIL_TEMPLATES, templateId)) throw new Error('Template is unavailable');
  const to = recipients[0];
  const name = boundedText(input.name, 'Recipient name', 120) || to.split('@')[0];
  return {
    templateId,
    recipients,
    to,
    from,
    fromAddress,
    visual: input.visual !== false,
    vars: { name, email: to, appUrl },
  };
}
