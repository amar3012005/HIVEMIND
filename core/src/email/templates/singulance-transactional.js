/**
 * Email-client-safe Singulance transactional shell.
 *
 * The composition mirrors the HIVEMIND login surface exactly (see
 * frontend/Da-vinci/src/components/hivemind/app/auth/LoginPage.jsx, the
 * "Logo" block ~line 425): the real SingulanceMark raster mark, the
 * "SINGULANCE" wordmark, and the "HIVEMIND · MEMORY ENGINE" mono subtitle,
 * on a quiet off-white field with the one electric-blue signal color. Every
 * template in templates.json that sets "layout": "singulance_transactional"
 * gets this exact header — that is the single source of the brand for
 * outbound mail, so a new template never has to redraw it.
 *
 * Email-client-safe: no script or remote font dependency. The one image
 * (the logo) is the same asset already served in production at
 * https://singulancelabs.com/images/singulance-orbit.png, with a text
 * fallback via `alt` for clients that block images by default.
 */
const LOGO_URL = 'https://singulancelabs.com/images/singulance-orbit.png';

export function renderSingulanceTransactionalEmail({ preheader = '', innerHtml = '', year }) {
  const hiddenPreheader = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px">${preheader}</div>`
    : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:#f8fafc;font-family:'Space Grotesk',Arial,Helvetica,sans-serif;color:#0a0a0a">${hiddenPreheader}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc"><tr><td style="padding:28px 12px 40px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e3e0db;border-radius:8px">` +
    `<tr><td style="height:5px;background:#117dff;font-size:1px;line-height:1px">&nbsp;</td></tr>` +
    `<tr><td style="padding:36px 52px 16px">` +
    `<table role="presentation" cellpadding="0" cellspacing="0"><tr>` +
    `<td style="padding-right:14px;vertical-align:middle"><img src="${LOGO_URL}" width="40" height="40" alt="Singulance" style="display:block;width:40px;height:40px;object-fit:contain"></td>` +
    `<td style="vertical-align:middle">` +
    `<div style="font-size:19px;line-height:22px;font-weight:700;letter-spacing:-0.2px;font-family:'Space Grotesk',Arial,sans-serif;color:#0a0a0a">SINGULANCE</div>` +
    `<div style="margin-top:2px;font-size:10px;line-height:14px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:2px;color:#a3a3a3">HIVEMIND &middot; MEMORY ENGINE</div>` +
    `</td></tr></table>` +
    `<div style="margin-top:22px;font-size:11px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;letter-spacing:3px;color:#117dff">SYSTEM MESSAGE</div>` +
    `</td></tr>` +
    `<tr><td style="padding:14px 52px 42px">${innerHtml}</td></tr>` +
    `<tr><td style="padding:18px 52px 24px;border-top:1px solid #e3e0db;font-size:11px;line-height:18px;color:#8a8a8a;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.4px">` +
    `SINGULANCE &middot; HIVEMIND &middot; MEMORY RUNNING INSIDE EVERYTHING &middot; &copy; ${year} SINGULANCE.` +
    `</td></tr></table></td></tr></table></body></html>`;
}
