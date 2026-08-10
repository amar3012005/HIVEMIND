/**
 * Email-safe rendering of the HIVEMIND Cartesia product hero.
 *
 * The source composition lives in frontend/Da-vinci/.../cartesia/HivemindProduct.jsx.
 * This renderer deliberately uses tables and inline styles so the same visual
 * hierarchy survives Gmail, Apple Mail, Outlook, and Cloudflare previews.
 */

function hiddenPreheader(preheader) {
  return preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px">${preheader}</div>`
    : '';
}

export function renderHivemindWelcomeEmail({ preheader = '', name = '', appUrl = '', year = '' }) {
  const greeting = name ? `WELCOME, ${name}` : 'WELCOME TO HIVEMIND';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light only">
  <title>Welcome to HIVEMIND</title>
  <style>
    @media only screen and (max-width:620px) {
      .hm-shell { width: 100% !important; max-width: 100% !important; }
      .hm-frame { padding: 10px 8px 14px !important; }
      .hm-hero { padding: 18px 14px 16px !important; }
      .hm-pill { font-size: 7px !important; letter-spacing: 1.2px !important; padding: 5px 9px !important; }
      .hm-title { font-size: 33px !important; line-height: 31px !important; letter-spacing: -1.8px !important; }
      .hm-subtitle { font-size: 12px !important; line-height: 18px !important; padding: 0 6px !important; }
      .hm-button { padding: 13px 14px !important; font-size: 11px !important; letter-spacing: 1.6px !important; }
      .hm-button-mark { width: 27px !important; height: 27px !important; font-size: 14px !important; }
      .hm-browser-wrap { padding: 0 10px !important; }
      .hm-browser-head { padding: 7px 9px !important; }
      .hm-browser-title { font-size: 7px !important; letter-spacing: 1px !important; }
      .hm-tab { font-size: 8px !important; padding: 6px 5px !important; }
      .hm-demo { padding: 11px !important; }
      .hm-query { padding: 10px !important; font-size: 9px !important; line-height: 14px !important; }
      .hm-demo-foot { padding: 7px 9px !important; }
      .hm-region { font-size: 7px !important; padding: 5px 7px !important; }
      .hm-live { font-size: 7px !important; padding: 6px 9px !important; }
      .hm-stats { padding: 15px 18px 17px !important; }
      .hm-stat-value { font-size: 20px !important; line-height: 22px !important; }
      .hm-stat-label { font-size: 7px !important; letter-spacing: 1.5px !important; }
      .hm-footer { font-size: 7px !important; line-height: 12px !important; letter-spacing: 1px !important; padding: 11px 12px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f1f3f4;color:#0a0a0a;font-family:'Space Grotesk','Helvetica Neue',Arial,sans-serif">
${hiddenPreheader(preheader)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#f1f3f4">
  <tr><td class="hm-frame" align="center" style="padding:28px 12px 36px">
    <table class="hm-shell" role="presentation" width="760" cellpadding="0" cellspacing="0" style="width:760px;max-width:760px;background-color:#fbfbf8;background-image:radial-gradient(rgba(17,125,255,0.14) 1px,transparent 1px);background-size:14px 14px;border:1px solid #e7e4dd;border-radius:10px;overflow:hidden">
      <tr><td class="hm-hero" align="center" style="padding:34px 34px 24px">
        <div class="hm-pill" style="display:inline-block;padding:7px 13px;border:1px solid #e7e4dd;border-radius:999px;background:#ffffff;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9px;line-height:13px;letter-spacing:1.8px;color:#6b6b6b;text-transform:uppercase"><span style="color:#117dff">●</span>&nbsp;&nbsp;SOVEREIGN MEMORY ENGINE · EU</div>
        <div style="margin-top:15px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:8px;line-height:12px;font-weight:700;letter-spacing:2px;color:#117dff;text-transform:uppercase">${greeting}</div>
        <h1 class="hm-title" style="margin:12px auto 0;max-width:680px;font-family:'Space Grotesk','Helvetica Neue',Arial,sans-serif;font-size:59px;line-height:55px;font-weight:700;letter-spacing:-3.4px;color:#0a0a0a">Run your institution<br><span style="color:#117dff">as an AI company</span></h1>
        <p class="hm-subtitle" style="margin:17px auto 0;max-width:590px;font-size:17px;line-height:26px;font-weight:400;color:#575757">The AI workforce that runs inside your organization&#39;s memory.</p>
        <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;margin-top:22px">
          <tr><td>
            <a class="hm-button" href="${appUrl}" style="display:block;padding:18px 22px;background:#117dff;border-radius:7px;color:#ffffff;text-decoration:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;line-height:20px;font-weight:700;letter-spacing:2.2px;text-transform:uppercase">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                <td width="42"><span class="hm-button-mark" style="display:inline-block;width:31px;height:31px;border-radius:5px;background:#ffffff;color:#117dff;font-family:Arial,sans-serif;font-size:17px;line-height:31px;text-align:center">H</span></td>
                <td style="color:#ffffff">GET STARTED</td>
                <td width="28" align="right" style="color:#ffffff;font-size:24px;font-family:Arial,sans-serif">→</td>
              </tr></table>
            </a>
          </td></tr>
        </table>
      </td></tr>
      <tr><td class="hm-browser-wrap" style="padding:0 42px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e7e4dd;border-radius:9px;box-shadow:0 24px 48px rgba(20,20,20,0.12);overflow:hidden">
          <tr><td class="hm-browser-head" style="padding:9px 13px;border-bottom:1px solid #efece5">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="font-size:13px;line-height:13px;color:#ff5f57">●</td><td style="padding-left:5px;font-size:13px;line-height:13px;color:#febc2e">●</td><td style="padding-left:5px;font-size:13px;line-height:13px;color:#28c840">●</td>
              <td class="hm-browser-title" style="padding-left:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9px;line-height:13px;letter-spacing:1.3px;color:#b5b0a4">hivemind — recall · live</td>
            </tr></table>
          </td></tr>
          <tr><td style="background:#faf9f4;border-bottom:1px solid #efece5;padding:5px 12px">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td class="hm-tab" style="padding:6px 10px;background:#ffffff;border:1px solid #e3e0db;border-radius:5px;font-size:10px;line-height:13px;font-weight:600;color:#117dff">Memories</td>
              <td class="hm-tab" style="padding:6px 10px;font-size:10px;line-height:13px;color:#6b6b6b">Knowledge Base</td>
              <td class="hm-tab" style="padding:6px 10px;font-size:10px;line-height:13px;color:#6b6b6b">Web Intel</td>
            </tr></table>
          </td></tr>
          <tr><td class="hm-demo" style="padding:18px">
            <div class="hm-query" style="padding:14px 16px;border:1px solid #e3e0db;border-radius:8px;background:#faf9f4;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:20px;color:#0a0a0a"><span style="color:#117dff">&gt;</span>&nbsp; &quot;What was the deployment fix from last Tuesday?&quot;</div>
          </td></tr>
          <tr><td class="hm-demo-foot" style="padding:9px 13px;border-top:1px solid #efece5;background:#faf9f4">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td><span class="hm-region" style="display:inline-block;padding:6px 9px;border:1px solid #e3e0db;border-radius:6px;background:#ffffff;font-size:9px;line-height:12px;color:#6b6b6b">🇪🇺&nbsp; EU Sovereign⌄</span></td>
              <td align="right"><span class="hm-live" style="display:inline-block;padding:7px 13px;border-radius:999px;background:#117dff;color:#ffffff;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9px;line-height:12px;font-weight:700;letter-spacing:1px">▶&nbsp; TRY LIVE</span></td>
            </tr></table>
          </td></tr>
        </table>
      </td></tr>
      <tr><td class="hm-stats" align="center" style="padding:26px 80px 28px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="33.33%" align="center"><div class="hm-stat-value" style="font-size:26px;line-height:29px;font-weight:700;color:#0a0a0a">&lt;50ms</div><div class="hm-stat-label" style="margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:8px;line-height:12px;letter-spacing:2px;color:#a39e92">RECALL</div></td>
          <td width="33.33%" align="center"><div class="hm-stat-value" style="font-size:26px;line-height:29px;font-weight:700;color:#0a0a0a">100%</div><div class="hm-stat-label" style="margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:8px;line-height:12px;letter-spacing:2px;color:#a39e92">YOURS</div></td>
          <td width="33.33%" align="center"><div class="hm-stat-value" style="font-size:26px;line-height:29px;font-weight:700;color:#0a0a0a">∞</div><div class="hm-stat-label" style="margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:8px;line-height:12px;letter-spacing:2px;color:#a39e92">RETENTION</div></td>
        </tr></table>
      </td></tr>
      <tr><td class="hm-footer" align="center" style="padding:14px 18px;border-top:1px solid #e7e4dd;background:rgba(251,251,248,0.92);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:8px;line-height:13px;letter-spacing:1.4px;color:#a39e92">PERSISTENT MEMORY &nbsp;·&nbsp; EU SOVEREIGN &nbsp;·&nbsp; © ${year} SINGULANCE LABS</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
