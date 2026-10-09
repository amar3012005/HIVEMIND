/** Shared transactional transport for legacy invitations and meeting notices.
 * Uses the canonical Cloudflare-first system sender and preserves safe receipts.
 * Provider credentials and fallback policy remain owned by email-service.js.
 */
import { sendRenderedSystemEmail } from '../email/email-service.js';

export function escapeEmailHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export async function sendEmail({ to, subject, html, text, from }) {
  if (!to || !subject || (!html && !text)) return { ok: false, reason: 'invalid_args' };
  const result = await sendRenderedSystemEmail({
    to, from, templateId: 'legacy_transactional_notice',
    rendered: { subject, html: html || `<p>${escapeEmailHtml(text)}</p>`, text: text || '' },
  });
  return { ...result, ...(result.messageId ? { id: result.messageId } : {}),
    ...(!result.ok && result.error ? { reason: result.error } : {}) };
}

/**
 * Build the HTML body for an org-invite email.
 *
 * @param {object} opts
 * @param {string} opts.orgName    Display name of the org doing the invite.
 * @param {string} opts.inviteUrl  Full https://… join URL.
 * @param {string} opts.inviterEmail (optional) admin who sent it.
 * @param {string[]} opts.projectNames (optional) pre-assigned project labels.
 * @param {string[]} opts.teamNames    (optional) pre-assigned team labels.
 * @param {string} opts.role           'member' | 'admin'
 * @param {Date}   opts.expiresAt
 */
export function buildInviteEmail({ orgName, inviteUrl, inviterEmail, projectNames = [], teamNames = [], role = 'member', expiresAt, resend = false }) {
  const expires = expiresAt ? new Date(expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'soon';
  const scopeLine = [
    projectNames.length ? `Projects: <strong>${projectNames.map(escapeEmailHtml).join(', ')}</strong>` : null,
    teamNames.length ? `Teams: <strong>${teamNames.map(escapeEmailHtml).join(', ')}</strong>` : null,
  ].filter(Boolean).join('<br/>');

  const subject = resend
    ? `Reminder: your ${orgName} HIVEMIND invitation`
    : `You're invited to ${orgName} on HIVEMIND`;
  const text = `${inviterEmail || 'Your team'} invited you to join ${orgName} on HIVEMIND as ${role}.\n\nAccept here: ${inviteUrl}\n\nLink expires ${expires}.`;
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#faf9f4;font-family:'Space Grotesk','Helvetica Neue',Arial,sans-serif;color:#0a0a0a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf9f4;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e3e0db;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:32px 36px 16px;">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#a3a3a3;font-family:'JetBrains Mono',monospace;">HIVEMIND · ${escapeEmailHtml(orgName)}</div>
          <h1 style="margin:8px 0 16px;font-size:22px;font-weight:600;color:#0a0a0a;">You're invited to join <span style="color:#117dff;">${escapeEmailHtml(orgName)}</span></h1>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#525252;">
            ${inviterEmail ? `<strong>${escapeEmailHtml(inviterEmail)}</strong>` : 'A workspace admin'} invited you to join <strong>${escapeEmailHtml(orgName)}</strong> on HIVEMIND
            as a <strong>${escapeEmailHtml(role)}</strong>. HIVEMIND is your team's persistent second brain — it captures, connects,
            and recalls every fact, decision, and document across your tools.
          </p>
          ${scopeLine ? `<div style="margin:0 0 16px;padding:12px 14px;background:#faf9f4;border:1px solid #ece8de;border-radius:10px;font-size:12px;color:#525252;line-height:1.6;">${scopeLine}</div>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
            <tr><td bgcolor="#117dff" style="border-radius:8px;">
              <a href="${escapeEmailHtml(inviteUrl)}" style="display:inline-block;padding:13px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;font-family:'Space Grotesk',sans-serif;">
                Accept invitation →
              </a>
            </td></tr>
          </table>
          <p style="margin:0 0 8px;font-size:11px;line-height:1.6;color:#a3a3a3;font-family:'JetBrains Mono',monospace;">
            Or paste this link into your browser:<br/>
            <span style="color:#525252;word-break:break-all;">${escapeEmailHtml(inviteUrl)}</span>
          </p>
          <p style="margin:16px 0 0;font-size:11px;color:#a3a3a3;font-family:'JetBrains Mono',monospace;">
            Expires ${escapeEmailHtml(expires)}. If you weren't expecting this, ignore the email.
          </p>
        </td></tr>
        <tr><td style="padding:16px 36px;border-top:1px solid #ece8de;background:#faf9f4;">
          <div style="font-size:10px;color:#a3a3a3;font-family:'JetBrains Mono',monospace;letter-spacing:0.08em;text-transform:uppercase;">HIVEMIND · singulancelabs.com</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}
