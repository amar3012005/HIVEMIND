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
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><style>
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table,td{mso-table-lspace:0;mso-table-rspace:0}table{border-collapse:collapse!important}img{border:0;height:auto;line-height:100%;outline:none;text-decoration:none}.sl-body img{max-width:100%!important;height:auto!important}
    @media only screen and (max-width:620px){.sl-frame{padding:0!important}.sl-shell{width:100%!important;max-width:100%!important;border-left:0!important;border-right:0!important}.sl-head{padding:20px 22px!important}.sl-body{padding:28px 22px 34px!important}.sl-body h1{font-size:26px!important;line-height:32px!important}.sl-body a{max-width:100%;box-sizing:border-box}.sl-footer{padding:17px 22px 20px!important;font-size:9px!important;line-height:15px!important}.sl-system{margin-top:18px!important;font-size:9px!important;letter-spacing:2.2px!important}}
  </style></head>` +
    `<body style="margin:0;padding:0;background:#f1f2ef;font-family:${CARTESIA.sans};color:${CARTESIA.ink}">${hiddenPreheader}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f2ef"><tr><td class="sl-frame" style="padding:28px 12px 40px">` +
    `<table class="sl-shell" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid ${CARTESIA.line}">` +
    `<tr><td style="height:4px;background:#117dff;font-size:1px;line-height:1px">&nbsp;</td></tr>` +
    `<tr><td class="sl-head" style="padding:24px 34px 22px">` +
    emailBrandLockup({ compact: true }) +
    `<div class="sl-system" style="margin-top:22px;font-size:10px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;letter-spacing:2.8px;color:#117dff">HIVEMIND / SYSTEM MESSAGE</div>` +
    `</td></tr>` +
    `<tr><td class="sl-body" style="padding:34px 52px 44px;border-top:1px solid #e3e0db">${innerHtml}</td></tr>` +
    `<tr><td class="sl-footer" style="padding:19px 52px 23px;border-top:1px solid #e3e0db;background:#fbfbf8;font-size:10px;line-height:17px;color:#8a8a8a;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.55px">` +
    `SINGULANCE &middot; HIVEMIND &middot; OPERATING SYSTEM<br><span style="color:#aaaaaa">YOUR COMPANY, IN MOTION &middot; &copy; ${year} SINGULANCE LABS.</span>` +
    `</td></tr></table></td></tr></table></body></html>`;
}
