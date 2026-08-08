/**
 * Email-client-safe Singulance transactional shell.
 *
 * The composition follows the clear, high-contrast access-code email pattern:
 * a thin signal bar, an unmistakable wordmark, one primary decision, and no
 * client-side CSS, scripts, remote fonts, or image dependencies.
 */
export function renderSingulanceTransactionalEmail({ preheader = '', innerHtml = '', year }) {
  const hiddenPreheader = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px">${preheader}</div>`
    : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#050505">${hiddenPreheader}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4"><tr><td style="padding:18px 12px 34px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#ffffff">` +
    `<tr><td style="height:20px;background:#f6821f;font-size:1px;line-height:1px">&nbsp;</td></tr>` +
    `<tr><td style="padding:48px 56px 18px"><div style="font-size:34px;line-height:1;font-weight:800;letter-spacing:7px;color:#080808">SINGULANCE</div>` +
    `<div style="margin-top:12px;width:48px;height:4px;background:#f6821f;font-size:1px;line-height:1px">&nbsp;</div></td></tr>` +
    `<tr><td style="padding:34px 56px 44px">${innerHtml}</td></tr>` +
    `<tr><td style="padding:22px 56px 30px;border-top:1px solid #ececec;font-size:12px;line-height:18px;color:#737373">` +
    `This is a transactional message from Singulance. &copy; ${year} Singulance Labs.` +
    `</td></tr></table></td></tr></table></body></html>`;
}

