/**
 * Email-safe rendering of the complete HIVEMIND Cartesia product story.
 * Source of truth: frontend/Da-vinci/.../cartesia/HivemindProduct.jsx.
 */

const BLUE = '#117dff';
const PAPER = '#fbfbf8';
const BORDER = '#e7e4dd';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

function preheader(value) {
  return value
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px">${value}</div>`
    : '';
}

function chrome(title, body, dark = false) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${dark ? '#0d0f14' : '#ffffff'};border:1px solid ${BORDER};border-radius:8px;overflow:hidden;box-shadow:0 22px 44px rgba(20,20,20,.10)">
    <tr><td style="padding:8px 12px;border-bottom:1px solid ${BORDER};background:#ffffff"><span style="color:#ff5f57">●</span>&nbsp;<span style="color:#febc2e">●</span>&nbsp;<span style="color:#28c840">●</span><span style="margin-left:12px;font:8px/12px ${MONO};letter-spacing:1.2px;color:#b5b0a4">${title}</span></td></tr>
    <tr><td>${body}</td></tr>
  </table>`;
}

function bullets(items) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:17px">${items.map((item) => `<tr><td width="20" valign="top" style="padding:3px 0;color:${BLUE};font-size:13px">✓</td><td style="padding:3px 0;font-size:12px;line-height:18px;color:#3d3b36">${item}</td></tr>`).join('')}</table>`;
}

function feature({ number, eyebrow, title, body, points, card, flip = false }) {
  const copy = `<td class="hm-col hm-copy" width="46%" valign="middle" style="padding:32px 24px 32px 30px">
    <div style="font:700 8px/12px ${MONO};letter-spacing:2.4px;text-transform:uppercase;color:${BLUE}">〉 ${eyebrow} <span style="color:#c9c4b8">· ${number}</span></div>
    <h2 class="hm-feature-title" style="margin:13px 0 0;font-size:30px;line-height:30px;letter-spacing:-1.2px;color:#0a0a0a">${title}</h2>
    <p style="margin:15px 0 0;font-size:12px;line-height:19px;color:#6b6b6b">${body}</p>${bullets(points)}
  </td>`;
  const visual = `<td class="hm-col hm-visual" width="54%" valign="middle" style="padding:28px 30px 28px 18px">${card}</td>`;
  return `<tr><td style="border-top:1px solid ${BORDER}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${flip ? visual + copy : copy + visual}</tr></table></td></tr>`;
}

function recallCard() {
  const rows = [
    ['DECISION', 'Q3 pricing locked at €49/seat — board sign-off Jun 12', BLUE],
    ['EVIDENCE', 'thread: “pricing v4 final” · slack #revenue · 14 msgs', BLUE],
    ['CONTRADICTION RESOLVED', 'supersedes €59 draft from May 28', '#0fa36b'],
  ];
  return chrome('hivemind — recall', `<div style="padding:16px"><div style="padding:10px 12px;border:1px solid ${BORDER};border-radius:6px;font-size:10px;color:#0a0a0a">⌕ &nbsp; what did we decide about the Q3 pricing? <span style="float:right;color:${BLUE};font:8px ${MONO}">41ms</span></div>${rows.map(([tag, text, color]) => `<div style="margin-top:8px;padding:9px 10px;border-radius:6px;background:#f7f5f0;font-size:10px;line-height:15px;color:#3d3b36"><span style="display:inline-block;margin-right:7px;padding:2px 4px;background:${color};border-radius:2px;color:white;font:700 7px/10px ${MONO};letter-spacing:.7px">${tag}</span>${text}</div>`).join('')}</div>`);
}

function connectorCard() {
  const names = ['Gmail', 'Slack', 'Notion', 'GitHub', 'Drive', 'Calendar', 'Salesforce', 'HubSpot', 'Linear'];
  return chrome('hivemind — connectors', `<table role="presentation" width="100%" cellpadding="5" cellspacing="0" style="padding:10px">${[0, 3, 6].map((start) => `<tr>${names.slice(start, start + 3).map((name) => `<td width="33.33%"><div style="padding:10px 3px;border:1px solid #efece5;border-radius:6px;text-align:center"><div style="font-size:14px;color:${BLUE}">◆</div><div style="margin-top:4px;font-size:9px;color:#3d3b36">${name}</div><div style="margin-top:3px;font:7px ${MONO};letter-spacing:.7px;color:#0fa36b">● SYNCED</div></div></td>`).join('')}</tr>`).join('')}</table>`);
}

function graphCard() {
  return chrome('hivemind — memory graph', `<div style="padding:24px 16px;text-align:center"><div style="height:145px;position:relative;font-size:30px;line-height:145px;color:${BLUE}">○────●────○<br><span style="display:block;margin-top:-114px">╲ &nbsp;│&nbsp; ╱</span><span style="display:block;margin-top:-114px">○───○───○</span></div><span style="display:inline-block;padding:5px 8px;border:1px solid ${BORDER};border-radius:4px;font:7px ${MONO};letter-spacing:1px;color:#6b6b6b">TEMPORAL SLIDER · REWIND MEMORY ⏪</span></div>`);
}

function meetingCard() {
  const rows = [['ACTION', 'Elena → ship pricing page by Friday'], ['DECISION', 'Self-host tier launches with Q3 release'], ['OPEN', 'Legal review of DPA — owner unassigned']];
  return chrome('hivemind — ai meeting notes', `<div style="padding:16px"><div style="font:16px/20px ${MONO};letter-spacing:2px;color:${BLUE}">▂▅▃▇▂▆▃▅▂▇▃▆ <span style="font-size:7px;color:#b5b0a4">recording · 00:41:22</span></div>${rows.map(([tag, line]) => `<div style="margin-top:8px;padding:9px;border:1px solid #efece5;border-radius:6px;font-size:10px;color:#3d3b36"><span style="color:${BLUE}">✓</span>&nbsp; <span style="font:7px ${MONO};letter-spacing:1px;color:#9a958a">${tag}</span>&nbsp;&nbsp; ${line}</div>`).join('')}</div>`);
}

function agentsCard() {
  const rows = [['STRATEGIST', 'Positioning: lead with sovereignty — US clouds can’t follow us there.', false], ['SKEPTIC', 'Challenge: prove sub-50ms at 10M memories or drop the claim.', false], ['BUILDER', 'Drafted the one-pager → Google Doc created ✓', true]];
  return chrome('hivemind — hyper agents', `<div style="padding:16px">${rows.map(([who, line, active]) => `<div style="margin:${active ? '8px 0 0 12%' : '0 8% 8px 0'};padding:10px 12px;border-radius:8px;background:${active ? BLUE : '#f7f5f0'};color:${active ? '#fff' : '#3d3b36'}"><div style="font:7px ${MONO};letter-spacing:1.2px;opacity:.7">${who}</div><div style="margin-top:4px;font-size:10px;line-height:15px">${line}</div></div>`).join('')}</div>`);
}

function voiceCard() {
  return chrome('tara × hive — voice', `<div style="padding:25px 16px;text-align:center"><div style="font:22px ${MONO};letter-spacing:2px;color:${BLUE}">▂▅▃▇▂▆▃▅▂▇▃▆▂▅▃</div><p style="margin:18px 0 0;font-size:10px;line-height:16px;font-style:italic;color:#3d3b36">“Your last call with Meridian flagged churn risk — want the summary before you dial?”</p><p style="margin:11px 0 0;font:7px ${MONO};letter-spacing:1.4px;color:#9a958a">LIVE STT → GROUNDED RECALL → TTS · SELF-HOSTED</p></div>`);
}

function mcpCard() {
  return chrome('terminal — mcp install', `<div style="padding:18px;background:#0d0f14;font:9px/18px ${MONO};color:#9ca3af"><span style="color:#6b7280"># wire HIVEMIND into Claude, Cursor, VS Code</span><br><span style="color:#0fa36b">$</span> <span style="color:#e5e7eb">curl -fsSL hivemind.sh/mcp | bash</span><br>✓ detected: Claude Code · Cursor<br>✓ 22 tools live — memory · web · code · time-travel<br><span style="color:${BLUE}">→ your editor now remembers everything</span></div>`, true);
}

function websiteHero(appUrl) {
  return `<tr><td class="hm-site-hero" align="center" style="padding:34px 34px 25px;background-color:${PAPER};background-image:radial-gradient(rgba(17,125,255,.14) 1px,transparent 1px);background-size:14px 14px">
    <div style="display:inline-block;padding:6px 12px;border:1px solid ${BORDER};border-radius:999px;background:#fff;font:8px/12px ${MONO};letter-spacing:1.5px;color:#6b6b6b"><span style="color:${BLUE}">●</span>&nbsp; SOVEREIGN MEMORY ENGINE · EU</div>
    <h1 class="hm-site-title" style="margin:15px 0 0;font-size:54px;line-height:50px;letter-spacing:-3px;color:#0a0a0a">Run your institution<br><span style="color:${BLUE}">as an AI company</span></h1>
    <p style="margin:15px 0 0;font-size:15px;line-height:23px;color:#575757">The AI workforce that runs inside your organization&#39;s memory.</p>
    <a href="${appUrl}" style="display:block;max-width:580px;margin:21px auto 0;padding:16px 20px;border-radius:7px;background:${BLUE};color:#fff;text-decoration:none;text-align:left;font:700 12px/18px ${MONO};letter-spacing:2px">H&nbsp;&nbsp;&nbsp; GET STARTED <span style="float:right;font-size:20px">→</span></a>
    <div style="margin-top:20px">${chrome('hivemind — recall · live', `<div style="background:#faf9f4;border-bottom:1px solid ${BORDER};padding:7px 11px;text-align:left;font-size:8px;color:#6b6b6b"><span style="padding:4px 7px;border:1px solid ${BORDER};border-radius:4px;background:#fff;color:${BLUE}">Memories</span>&nbsp;&nbsp; Knowledge Base &nbsp;&nbsp; Web Intel</div><div style="padding:15px;background:#fff"><div style="padding:12px;border:1px solid ${BORDER};border-radius:7px;background:#faf9f4;text-align:left;font:10px/16px ${MONO}"><span style="color:${BLUE}">&gt;</span> &quot;What was the deployment fix from last Tuesday?&quot;</div></div><div style="padding:8px 11px;border-top:1px solid ${BORDER};background:#faf9f4;text-align:left;font-size:8px;color:#6b6b6b">🇪🇺 EU Sovereign <span style="float:right;padding:5px 9px;border-radius:999px;background:${BLUE};color:white;font:7px ${MONO}">▶ TRY LIVE</span></div>`)}</div>
    <table role="presentation" width="70%" cellpadding="0" cellspacing="0" style="margin-top:21px"><tr>${[['&lt;50ms', 'RECALL'], ['100%', 'YOURS'], ['∞', 'RETENTION']].map(([value, label]) => `<td width="33.33%" align="center"><div style="font-size:22px;font-weight:700">${value}</div><div style="margin-top:3px;font:7px ${MONO};letter-spacing:1.6px;color:#a39e92">${label}</div></td>`).join('')}</tr></table>
  </td></tr>`;
}

function accountWelcome(name, appUrl, year) {
  return `<tr><td style="height:5px;background:${BLUE};font-size:1px">&nbsp;</td></tr><tr><td class="hm-welcome" style="padding:42px 52px 38px;background:#ffffff">
    <div style="font:700 9px/14px ${MONO};letter-spacing:2.5px;color:${BLUE}">HIVEMIND / SYSTEM MESSAGE</div>
    <div style="margin-top:17px;font-size:27px;line-height:31px;font-weight:700">HIVEMIND</div><div style="margin-top:5px;font:9px/14px ${MONO};letter-spacing:2px;color:#8a8a8a">SOVEREIGN MEMORY ENGINE</div>
    <div style="margin-top:42px;font:700 8px/12px ${MONO};letter-spacing:2px;color:${BLUE}">ACCOUNT ACTIVATED</div>
    <h1 class="hm-welcome-title" style="margin:20px 0 0;font-size:29px;line-height:35px;letter-spacing:-.4px">Welcome to HIVEMIND, ${name}</h1>
    <p style="margin:22px 0 0;max-width:560px;font-size:15px;line-height:27px;color:#525252">Your company AI Operating System is ready. HIVEMIND gives your AI workforce approved context inside your company brain, so it can coordinate work while your organization retains control.</p>
    <a href="${appUrl}" style="display:inline-block;margin-top:27px;padding:13px 22px;border-radius:6px;background:${BLUE};color:#fff;text-decoration:none;font-size:13px;font-weight:700">OPEN HIVEMIND</a>
    <p style="margin:27px 0 0;font-size:11px;color:#7b7b7b">The HIVEMIND team</p>
  </td></tr><tr><td style="padding:17px 52px 20px;border-top:1px solid ${BORDER};background:#fff;font:8px/13px ${MONO};letter-spacing:.6px;color:#8a8a8a">HIVEMIND · MEMORY RUNNING INSIDE EVERYTHING · © ${year} SINGULANCE LABS.</td></tr>`;
}

function contextRecall(appUrl) {
  return `<tr><td style="padding:36px 30px;border-top:1px solid ${BORDER};background:#faf9f4"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="hm-col" width="55%" valign="top"><h2 class="hm-feature-title" style="margin:0;font-size:32px;line-height:32px">Context-savvy accuracy<br><span style="color:#a3a3a3">for the real-world</span></h2><a href="${appUrl}" style="display:inline-block;margin-top:18px;padding:10px 16px;border-radius:4px;background:${BLUE};color:#fff;text-decoration:none;font:700 9px ${MONO};letter-spacing:1px">TRY FOR FREE</a></td><td class="hm-col" width="45%" align="right" valign="top"><span style="display:inline-block;padding:8px 11px;border:1px solid ${BORDER};border-radius:7px;background:#fff;color:#525252">←</span>&nbsp;<span style="display:inline-block;padding:8px 11px;border:1px solid ${BORDER};border-radius:7px;background:#fff;color:#525252">→</span></td></tr></table><div style="margin-top:35px;font:9px ${MONO};color:#a3a3a3">[02]</div><div style="margin-top:22px;font:8px ${MONO};letter-spacing:1.5px;color:#a3a3a3">──────── &nbsp; ACCURATELY RETRIEVED</div><div class="hm-context-query" style="margin-top:14px;font-size:27px;line-height:32px;font-weight:300"><span style="color:${BLUE}">“What was the deployment fix</span> <span style="color:#d4d0ca">from last Tuesday?”</span></div><div style="margin-top:12px;text-align:right;font:8px ${MONO};letter-spacing:1.2px;color:#a3a3a3">3 RELEVANT MEMORIES FOUND ─────</div><h3 style="margin:30px 0 0;font-size:15px">Context-Aware Recall</h3><p style="margin:8px 0 0;max-width:470px;font-size:11px;line-height:18px;color:#525252">Retrieves contextually relevant memories based on your current task, not just keyword matches.</p></td></tr>`;
}

function sovereignty() {
  const badges = ['GDPR native', 'Frankfurt', 'BYOK / self-host', '&lt;50ms recall'];
  return `<tr><td align="center" style="padding:38px 28px;border-top:1px solid ${BORDER};background-color:${PAPER};background-image:linear-gradient(rgba(17,125,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(17,125,255,.04) 1px,transparent 1px);background-size:30px 30px"><div style="font:700 8px ${MONO};letter-spacing:2.8px;color:${BLUE}">〉 SOVEREIGNTY · 08</div><h2 class="hm-feature-title" style="margin:17px 0 0;font-size:35px;line-height:37px">Memory stays inside your walls.</h2><p style="margin:16px auto 0;max-width:470px;font-size:12px;line-height:19px;color:#5f5c55">Every deployment moves the engine from public cloud story to sovereign, private memory infrastructure.</p><table role="presentation" width="90%" cellpadding="5" cellspacing="0" style="margin-top:18px"><tr>${badges.map((badge) => `<td class="hm-badge" width="25%"><div style="padding:13px 4px;border:1px solid #e4ded2;border-radius:7px;background:#fff;color:${BLUE};font-size:13px">◇<div style="margin-top:7px;font-size:9px;font-weight:700;color:#272521">${badge}</div></div></td>`).join('')}</tr></table></td></tr>`;
}

function security() {
  return `<tr><td style="padding:34px 30px;border-top:1px solid ${BORDER};background:${PAPER}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="hm-col" width="50%" valign="middle" style="padding-right:22px"><div style="font:700 8px ${MONO};letter-spacing:2px;color:${BLUE}">〉 POST-QUANTUM · 09</div><h2 class="hm-feature-title" style="margin:14px 0 0;font-size:32px;line-height:31px">Encryption that outlives<br>the quantum threat.</h2><p style="margin:15px 0 0;font-size:12px;line-height:19px;color:#5f5c55">HIVEMIND ships NIST-standardized post-quantum cryptography today, so your memory stays sealed for decades.</p>${bullets(['ML-KEM-768 key encapsulation', 'ML-DSA-65 signatures', 'Hybrid X25519 + PQ', 'AES-256-GCM at rest'])}</td><td class="hm-col" width="50%" valign="middle">${chrome('HIVEMIND · KEY VAULT', `<div style="padding:35px 15px;text-align:center;background-image:linear-gradient(rgba(17,125,255,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(17,125,255,.12) 1px,transparent 1px);background-size:32px 32px"><div style="display:inline-block;padding:25px;border:2px solid #9fc7ff;border-radius:12px;background:#f5f9ff;font-size:28px">🔒</div><div style="margin-top:14px;font:8px ${MONO};letter-spacing:2px;color:${BLUE}">ML-KEM SEALED</div></div>`)}</td></tr></table></td></tr>`;
}

function finalCta(appUrl) {
  return `<tr><td align="center" style="padding:42px 28px;background-color:${PAPER};background-image:radial-gradient(rgba(17,125,255,.14) 1px,transparent 1px);background-size:14px 14px;border-top:1px solid ${BORDER}"><h2 class="hm-feature-title" style="margin:0;font-size:40px;line-height:40px">Stop starting<br>from zero</h2><p style="margin:15px auto 0;max-width:390px;font-size:12px;line-height:19px;color:#6b6b6b">Connect your first app in two minutes. Your organization starts compounding today.</p><a href="${appUrl}" style="display:inline-block;margin-top:22px;padding:13px 24px;border-radius:999px;background:${BLUE};color:#fff;text-decoration:none;font-size:11px;font-weight:700">GET HIVEMIND&nbsp; →</a></td></tr>`;
}

export function renderHivemindWelcomeEmail({ preheader: pre = '', name = '', appUrl = '', year = '' }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>Welcome to HIVEMIND</title><style>
    @media only screen and (max-width:620px){.hm-frame{padding:8px 6px!important}.hm-shell{width:100%!important;max-width:100%!important}.hm-welcome{padding:25px 22px 24px!important}.hm-welcome-title{font-size:24px!important;line-height:29px!important}.hm-site-hero{padding:27px 13px 22px!important}.hm-site-title{font-size:36px!important;line-height:34px!important;letter-spacing:-2px!important}.hm-col{display:block!important;width:auto!important;padding:23px 20px!important}.hm-copy{padding-bottom:8px!important}.hm-visual{padding-top:8px!important;padding-bottom:25px!important}.hm-feature-title{font-size:27px!important;line-height:28px!important}.hm-context-query{font-size:21px!important;line-height:26px!important}.hm-badge{display:inline-block!important;width:48%!important}.hm-footer{padding:12px!important;font-size:7px!important}}
  </style></head><body style="margin:0;padding:0;background:#f1f3f4;color:#0a0a0a;font-family:'Space Grotesk','Helvetica Neue',Arial,sans-serif">${preheader(pre)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f4"><tr><td class="hm-frame" align="center" style="padding:28px 12px 40px"><table class="hm-shell" role="presentation" width="760" cellpadding="0" cellspacing="0" style="width:760px;max-width:760px;background:#fff;border:1px solid ${BORDER};border-radius:8px;overflow:hidden">
    ${accountWelcome(name, appUrl, year)}
    <tr><td style="height:34px;background:#f1f3f4;border-top:1px solid ${BORDER};border-bottom:1px solid ${BORDER}">&nbsp;</td></tr>
    ${websiteHero(appUrl)}
    ${feature({ number: '01', eyebrow: 'MEMORY ENGINE', title: 'A memory that<br>organizes itself', body: 'Every fact, decision and document becomes durable memory with semantic recall — searchable by meaning, not keywords. Knowledge updates, merges, and contradicts itself into truth.', points: ['Updates · Extends · Derives · Contradicts — typed relationships', 'Contradiction detection with evidence trail', 'Dream synthesis: new insights while you sleep'], card: recallCard() })}
    ${feature({ number: '02', eyebrow: 'CONNECTORS', title: 'Connect once.<br>Remember forever.', body: '40+ integrations turn the tools your team already lives in into a continuously-updating knowledge base. OAuth once — Gmail, Slack, Notion, GitHub, Salesforce and more sync on cadence, filtered to signal.', points: ['Auto-sync cadence: 15m → daily, per connector', 'Deep filters — no firehose, only signal', 'Personal / Team / Org-wide scoping'], card: connectorCard(), flip: true })}
    ${contextRecall(appUrl)}${security()}
    ${feature({ number: '03', eyebrow: 'MEMORY GRAPH', title: 'See your mind.<br>Rewind it.', body: 'A living, navigable atlas of facts, decisions and people — clustered by topic, connected by meaning. Rewind history and watch your organization’s memory form.', points: ['3D force-graph · 2D canvas · organic Moss view', 'Temporal slider — rewind history, play it back', 'Click any node → relationships, evidence, importance'], card: graphCard() })}
    ${feature({ number: '04', eyebrow: 'AI MEETING NOTES', title: 'Meetings become<br>permanent knowledge', body: 'Record, transcribe, diarize. Decisions, action items and open questions are auto-extracted, attributed to who said what, and filed into memory — searchable forever.', points: ['Multi-speaker diarization — who said what', 'Actions · decisions · questions, auto-extracted', 'Preview & approve before it enters memory'], card: meetingCard(), flip: true })}
    ${feature({ number: '05', eyebrow: 'HYPER AGENTS', title: 'Digital employees<br>that actually act', body: 'Spin up a room, give it a goal. Role-based agents debate, decide, and produce real output: a Google Doc, a sheet, a sent email. Grounded in your memory.', points: ['9+ formats: debate, council, swarm, standup…', 'Agents act on Gmail, Docs, GitHub, Slack', 'Every room distills into permanent memory'], card: agentsCard() })}
    ${feature({ number: '06', eyebrow: 'TARA × HIVE', title: 'A voice that<br>knows your business', body: 'Real-time voice AI that listens, recalls from your HIVEMIND, and speaks — with post-call sentiment, churn-risk and hot-lead intelligence. Self-hosted, 30+ languages.', points: ['Live STT → grounded reasoning → TTS', 'Skill personas for sales, support, scheduling', 'Post-call analytics: sentiment, resolution, risk'], card: voiceCard(), flip: true })}
    ${feature({ number: '07', eyebrow: 'MCP SERVER', title: 'Your editor,<br>with total recall', body: 'One command wires HIVEMIND into Claude, Cursor and VS Code. 22 tools — save, recall, traverse, time-travel. Your AI coding tools stop forgetting what you built.', points: ['Bi-temporal time-travel', 'Decision logging with rationale + alternatives', 'Code version chains with auto-dedup'], card: mcpCard() })}
    ${sovereignty()}${finalCta(appUrl)}
    <tr><td class="hm-footer" align="center" style="padding:16px;border-top:1px solid ${BORDER};font:8px/13px ${MONO};letter-spacing:1px;color:#8a8a8a">HIVEMIND · MEMORY RUNNING INSIDE EVERYTHING · © ${year} SINGULANCE LABS.</td></tr>
  </table></td></tr></table></body></html>`;
}
