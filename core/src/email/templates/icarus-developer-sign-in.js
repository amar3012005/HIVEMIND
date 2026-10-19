function escape(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Authentication content only. The server-owned outbox selects this template;
// browser-controlled branding or template IDs are never accepted.
export function renderIcarusDeveloperSignIn({ otp, fragmentUrl }) {
  if (!/^\d{6}$/.test(String(otp))) throw new Error('Invalid sign-in code');
  const link = new URL(fragmentUrl);
  if (!['https:', 'http:'].includes(link.protocol) || link.pathname !== '/hivemind/login') throw new Error('Invalid sign-in link');
  const text = `Your ICARUS developer sign-in code is ${otp}. It expires in 10 minutes and can be used once.\n\nContinue securely: ${fragmentUrl}\n\nConfirm in the browser to finish, then return to your terminal. No purchase or company workspace is required. Local ICARUS memory works without signing in.\n\nIf you did not request this code, ignore this email.\nICARUS by SINGULANCE`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f7f8fa;color:#111827;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#fff;border:1px solid #e5e7eb;border-radius:12px"><tr><td style="padding:36px"><p style="margin:0 0 24px;font-size:12px;letter-spacing:2px;color:#117dff">ICARUS / SINGULANCE DEVELOPERS</p><h1 style="font-size:28px;line-height:34px;margin:0 0 16px">Sign in to your developer account</h1><p style="font-size:16px;line-height:25px;color:#525252">Use this one-time code to continue in your browser.</p><p style="font-size:36px;font-weight:700;letter-spacing:8px;margin:28px 0">${escape(otp)}</p><p style="font-size:14px;line-height:22px;color:#525252">Expires in 10 minutes. Never share this code.</p><p style="margin:28px 0"><a href="${escape(fragmentUrl)}" style="display:inline-block;background:#117dff;color:#fff;padding:14px 20px;border-radius:6px;text-decoration:none;font-weight:700">Continue to ICARUS</a></p><p style="font-size:14px;line-height:23px;color:#525252">Confirm in the browser, then return to your terminal. No purchase or company workspace is required. Your local memory works without signing in.</p><p style="font-size:12px;line-height:20px;color:#737373">Opening this link alone does not sign you in. If you did not request it, ignore this email.</p></td></tr></table></td></tr></table></body></html>`;
  return { subject: 'Your ICARUS developer sign-in code', text, html };
}
