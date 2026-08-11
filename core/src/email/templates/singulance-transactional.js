/**
 * Email-client-safe Singulance transactional shell.
 *
 * The composition mirrors the HIVEMIND login surface: a quiet off-white
 * field, electric-blue signal, Space Grotesk-compatible type, and monospace
 * system labels. It remains email-client-safe: no script, image, or remote
 * font dependency is required for the message to work.
 */
export function renderSingulanceTransactionalEmail({ preheader = '', innerHtml = '', year }) {
  const hiddenPreheader = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px">${preheader}</div>`
    : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:#f8fafc;font-family:'Space Grotesk',Arial,Helvetica,sans-serif;color:#0a0a0a">${hiddenPreheader}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc"><tr><td style="padding:28px 12px 40px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e3e0db;border-radius:8px">` +
    `<tr><td style="height:5px;background:#117dff;font-size:1px;line-height:1px">&nbsp;</td></tr>` +
    `<tr><td style="padding:42px 52px 16px"><div style="font-size:11px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;letter-spacing:3px;color:#117dff">HIVEMIND / SYSTEM MESSAGE</div>` +
    `<div style="margin-top:16px;font-size:29px;line-height:32px;font-weight:700;letter-spacing:-0.4px;color:#0a0a0a">HIVEMIND</div><div style="margin-top:5px;font-size:11px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:2px;color:#8a8a8a">SOVEREIGN MEMORY ENGINE</div></td></tr>` +
    `<tr><td style="padding:30px 52px 42px">${innerHtml}</td></tr>` +
    `<tr><td style="padding:18px 52px 24px;border-top:1px solid #e3e0db;font-size:11px;line-height:18px;color:#8a8a8a;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.4px">` +
    `HIVEMIND &middot; MEMORY RUNNING INSIDE EVERYTHING &middot; &copy; ${year} Singulance Labs.` +
    `</td></tr></table></td></tr></table></body></html>`;
}
