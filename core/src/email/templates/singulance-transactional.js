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
import { CARTESIA, emailBrandLockup } from './cartesia-lifecycle.js';

export function renderSingulanceTransactionalEmail({ preheader = '', innerHtml = '', year }) {
  const hiddenPreheader = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px">${preheader}</div>`
    : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><style>@media only screen and (max-width:620px){.sl-frame{padding:0!important}.sl-shell{width:100%!important;max-width:100%!important;border-left:0!important;border-right:0!important}.sl-head{padding:20px 22px 14px!important}.sl-body{padding:14px 22px 32px!important}.sl-footer{padding:16px 22px!important;font-size:9px!important}}</style></head>` +
    `<body style="margin:0;padding:0;background:#f1f2ef;font-family:${CARTESIA.sans};color:${CARTESIA.ink}">${hiddenPreheader}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f2ef"><tr><td class="sl-frame" style="padding:28px 12px 40px">` +
    `<table class="sl-shell" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid ${CARTESIA.line}">` +
    `<tr><td class="sl-head" style="padding:24px 34px 16px">` +
    emailBrandLockup({ compact: true }) +
    `<div style="margin-top:22px;font-size:11px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;letter-spacing:3px;color:#117dff">SYSTEM MESSAGE</div>` +
    `</td></tr>` +
    `<tr><td class="sl-body" style="padding:14px 52px 42px">${innerHtml}</td></tr>` +
    `<tr><td class="sl-footer" style="padding:18px 52px 24px;border-top:1px solid #e3e0db;font-size:11px;line-height:18px;color:#8a8a8a;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.4px">` +
    `SINGULANCE &middot; HIVEMIND &middot; MEMORY RUNNING INSIDE EVERYTHING &middot; &copy; ${year} SINGULANCE.` +
    `</td></tr></table></td></tr></table></body></html>`;
}
