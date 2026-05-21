/**
 * Minimal transactional-email sender for HIVEMIND.
 *
 * Provider precedence:
 *   1. Resend (RESEND_API_KEY) — recommended, single HTTP call
 *   2. SMTP   (SMTP_HOST + SMTP_USER + SMTP_PASS) — fallback
 *   3. No-op   — when neither configured (returns ok=false, reason='disabled')
 *
 * Templates kept inline so we don't grow an asset pipeline.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM    = process.env.EMAIL_FROM || 'HIVEMIND <noreply@hivemind.davinciai.eu>';
const SMTP_HOST      = process.env.SMTP_HOST || '';
const SMTP_PORT      = Number(process.env.SMTP_PORT || 587);
const SMTP_USER      = process.env.SMTP_USER || '';
const SMTP_PASS      = process.env.SMTP_PASS || '';

/**
 * Send an email. Returns { ok, provider, id?, reason?, error? }.
 * Never throws — failures are reported via the return value so the caller
 * (invite creation, etc.) doesn't fail the parent transaction.
 */
export async function sendEmail({ to, subject, html, text, from }) {
  if (!to || !subject || (!html && !text)) {
    return { ok: false, reason: 'invalid_args' };
  }
  const fromAddr = from || RESEND_FROM;

  if (RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddr,
          to: Array.isArray(to) ? to : [to],
          subject,
          html: html || undefined,
          text: text || undefined,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await r.text();
      if (!r.ok) return { ok: false, provider: 'resend', error: `${r.status}: ${body.slice(0, 200)}` };
      let id = null;
      try { id = JSON.parse(body)?.id || null; } catch { /* */ }
      return { ok: true, provider: 'resend', id };
    } catch (err) {
      return { ok: false, provider: 'resend', error: err.message };
    }
  }

  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    try {
      const nodemailer = await import('nodemailer').catch(() => null);
      if (!nodemailer) {
        return { ok: false, provider: 'smtp', error: 'nodemailer not installed' };
      }
      const transporter = nodemailer.default.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      });
      const info = await transporter.sendMail({
        from: fromAddr,
        to,
        subject,
        html,
        text,
      });
      return { ok: true, provider: 'smtp', id: info.messageId };
    } catch (err) {
      return { ok: false, provider: 'smtp', error: err.message };
    }
  }

  return { ok: false, reason: 'disabled' };
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
    projectNames.length ? `Projects: <strong>${projectNames.join(', ')}</strong>` : null,
    teamNames.length ? `Teams: <strong>${teamNames.join(', ')}</strong>` : null,
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
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#a3a3a3;font-family:'JetBrains Mono',monospace;">HIVEMIND · ${orgName}</div>
          <h1 style="margin:8px 0 16px;font-size:22px;font-weight:600;color:#0a0a0a;">You're invited to join <span style="color:#117dff;">${orgName}</span></h1>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#525252;">
            ${inviterEmail ? `<strong>${inviterEmail}</strong>` : 'A workspace admin'} invited you to join <strong>${orgName}</strong> on HIVEMIND
            as a <strong>${role}</strong>. HIVEMIND is your team's persistent second brain — it captures, connects,
            and recalls every fact, decision, and document across your tools.
          </p>
          ${scopeLine ? `<div style="margin:0 0 16px;padding:12px 14px;background:#faf9f4;border:1px solid #ece8de;border-radius:10px;font-size:12px;color:#525252;line-height:1.6;">${scopeLine}</div>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
            <tr><td bgcolor="#117dff" style="border-radius:8px;">
              <a href="${inviteUrl}" style="display:inline-block;padding:13px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;font-family:'Space Grotesk',sans-serif;">
                Accept invitation →
              </a>
            </td></tr>
          </table>
          <p style="margin:0 0 8px;font-size:11px;line-height:1.6;color:#a3a3a3;font-family:'JetBrains Mono',monospace;">
            Or paste this link into your browser:<br/>
            <span style="color:#525252;word-break:break-all;">${inviteUrl}</span>
          </p>
          <p style="margin:16px 0 0;font-size:11px;color:#a3a3a3;font-family:'JetBrains Mono',monospace;">
            Expires ${expires}. If you weren't expecting this, ignore the email.
          </p>
        </td></tr>
        <tr><td style="padding:16px 36px;border-top:1px solid #ece8de;background:#faf9f4;">
          <div style="font-size:10px;color:#a3a3a3;font-family:'JetBrains Mono',monospace;letter-spacing:0.08em;text-transform:uppercase;">HIVEMIND · davinciai.eu</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}
