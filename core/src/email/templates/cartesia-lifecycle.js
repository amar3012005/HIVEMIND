export const CARTESIA = Object.freeze({
  blue: '#117dff',
  ink: '#090909',
  body: '#525252',
  muted: '#8f8f8f',
  line: '#e3e0db',
  paper: '#faf9f4',
  white: '#ffffff',
  mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  sans: 'Arial,Helvetica,sans-serif',
});

export const LIFECYCLE_TEMPLATE_VERSION = 'singulance-lifecycle-v1';
export const DEFAULT_SINGULANCE_LOGO_URL = 'https://singulancelabs.com/images/singulance-orbit.png';
export const DEFAULT_LIFECYCLE_BRAND = Object.freeze({
  wordmark: 'SINGULANCE',
  subtitle: 'HIVEMIND · OPERATING SYSTEM',
  logoUrl: DEFAULT_SINGULANCE_LOGO_URL,
});

export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Shared subject convention for every company lifecycle episode. */
export function lifecycleSubject(companyName, day, episodeTitle) {
  const company = String(companyName || 'Your Company').trim();
  const dayLabel = Number.isFinite(Number(day)) ? `Day ${Number(day)}` : String(day || 'Day 0').trim();
  return `[Singulance x ${company}] ${dayLabel}: ${String(episodeTitle || '').trim()}`;
}

export const SINGULANCE_MARK = `<svg width="54" height="54" viewBox="-6 -6 112 112" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Singulance"><ellipse cx="50" cy="50" rx="40" ry="13" transform="rotate(-18 50 50)" stroke="#0a0a0a" stroke-width="3.2"/><circle cx="88.04" cy="37.64" r="4.4" fill="#0a0a0a"/><path d="M80 50 57.39 53.06 62.73 62.73 53.06 57.39 50 96 46.94 57.39 37.27 62.73 42.61 53.06 20 50 42.61 46.94 37.27 37.27 46.94 42.61 50 4 53.06 42.61 62.73 37.27 57.39 46.94Z" fill="#22d3ee"/></svg>`;

export function brandLockup({ compact = false, surface = 'deck', logoUrl, subtitle = DEFAULT_LIFECYCLE_BRAND.subtitle } = {}) {
  if (surface === 'email') {
    const size = compact ? 42 : 54;
    const resolvedLogoUrl = escapeHtml(logoUrl || DEFAULT_LIFECYCLE_BRAND.logoUrl);
    return `<table role="presentation" cellpadding="0" cellspacing="0" class="brand-lockup"><tr><td width="${size + 12}" valign="middle"><img src="${resolvedLogoUrl}" width="${size}" height="${size}" alt="Singulance" style="display:block;width:${size}px;height:${size}px;object-fit:contain;border:0"></td><td valign="middle"><div class="brand-word">${DEFAULT_LIFECYCLE_BRAND.wordmark}</div><div class="brand-sub">${escapeHtml(subtitle).replace(' · ', ' <span>·</span> ')}</div></td></tr></table>`;
  }
  const mark = compact ? SINGULANCE_MARK.replace('width="54" height="54"', 'width="42" height="42"') : SINGULANCE_MARK;
  return `<div class="brand-lockup">${mark}<div><div class="brand-word">${DEFAULT_LIFECYCLE_BRAND.wordmark}</div><div class="brand-sub">${escapeHtml(subtitle).replace(' · ', ' <span>·</span> ')}</div></div></div>`;
}

export function browserChrome(label, content, extraClass = '') {
  return `<div class="browser ${extraClass}"><div class="browser-top"><span class="traffic red"></span><span class="traffic amber"></span><span class="traffic green"></span><span class="browser-label">${escapeHtml(label)}</span></div><div class="browser-body">${content}</div></div>`;
}

/** Reusable responsive shell for every SINGULANCE lifecycle email. */
export function lifecycleEmailShell({ title, preheader, body, logoUrl, brandSubtitle = DEFAULT_LIFECYCLE_BRAND.subtitle }) {
  const t = CARTESIA;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f1f2ef;color:${t.ink};font-family:${t.sans};overflow-wrap:anywhere}table{border-collapse:collapse}.preheader{display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0}.frame{padding:28px 12px}.shell{width:680px;max-width:680px;table-layout:fixed;background:${t.white};border:1px solid ${t.line}}.head{padding:24px 34px;border-bottom:1px solid ${t.line}}.brand-lockup{border-collapse:collapse}.brand-word{font-size:24px;line-height:25px;font-weight:800;letter-spacing:-1px}.brand-sub{margin-top:5px;font:700 8px/12px ${t.mono};letter-spacing:2px;color:#999}.brand-sub span{color:${t.blue}}.section{padding:36px 40px;border-bottom:1px solid ${t.line}}.eyebrow{font:700 8px/13px ${t.mono};letter-spacing:2.1px;color:${t.blue};text-transform:uppercase}.h1{margin:15px 0 0;font-size:36px;line-height:38px;letter-spacing:-1.7px}.h2{margin:12px 0 0;font-size:24px;line-height:27px;letter-spacing:-.8px}.copy{margin:14px 0 0;color:${t.body};font-size:14px;line-height:22px}.stats{table-layout:fixed;margin-top:22px;border-top:1px solid ${t.line};border-bottom:1px solid ${t.line}}.stat{padding:14px 12px 14px 0}.stat+.stat{border-left:1px solid ${t.line};padding-left:14px}.stat-label{font:700 7px/11px ${t.mono};letter-spacing:1.2px;color:#999}.stat-value{margin-top:4px;font-size:20px;font-weight:800}.founder-note{margin-top:22px;padding:18px 20px;border-left:3px solid ${t.blue};background:#fff}.founder-quote{font-size:14px;line-height:21px;font-weight:700;color:${t.ink}}.founder-signature{margin-top:12px;font:700 8px/12px ${t.mono};letter-spacing:1.4px;color:${t.blue}}.person{padding:10px 0;border-bottom:1px solid #eeeae4}.person:last-child{border-bottom:0}.avatar{width:42px;height:42px;border-radius:50%;overflow:hidden;background:#fff4f8;border:1px solid #f6c5dc}.avatar img{display:block;width:42px;height:42px}.person-name{font-size:14px;font-weight:700}.person-role{margin-top:2px;font:700 9px/13px ${t.mono};letter-spacing:1px;color:#ec4899}.action{display:inline-block;margin-top:18px;padding:12px 18px;background:${t.blue};color:#fff!important;text-decoration:none;font-size:12px;font-weight:700}.footer{padding:18px 34px;font:700 7px/12px ${t.mono};letter-spacing:1.1px;color:#999}
  @media only screen and (max-width:620px){.frame{padding:0!important}.shell{width:100%!important;max-width:100%!important;border-left:0!important;border-right:0!important}.head{padding:18px 20px!important}.section{padding:28px 22px!important}.brand-word{font-size:20px!important}.brand-sub{font-size:7px!important;letter-spacing:1.5px!important}.h1{font-size:31px!important;line-height:33px!important}.h2{font-size:22px!important;line-height:25px!important}.stack,.stack tbody,.stack tr,.stack td{display:block!important;width:100%!important;max-width:100%!important}.stack td+td{padding:20px 0 0!important;border-left:0!important}.stat{display:table-cell!important;width:33%!important;padding-top:12px!important}.stat+.stat{padding-left:10px!important}.stat-label{font-size:6px!important;letter-spacing:.7px!important}.person-summary{display:none!important}.footer{padding:16px 22px!important}}
  </style></head><body><div class="preheader">${escapeHtml(preheader)}</div><table role="presentation" width="100%"><tr><td class="frame" align="center"><table role="presentation" class="shell" width="680"><tr><td class="head">${brandLockup({ compact: true, surface: 'email', logoUrl, subtitle: brandSubtitle })}</td></tr>${body}<tr><td class="footer">SINGULANCE · YOUR COMPANY, IN MOTION · © ${new Date().getFullYear()} SINGULANCE LABS</td></tr></table></td></tr></table></body></html>`;
}

/** Reusable 16:9 print shell for every SINGULANCE lifecycle report deck. */
export function lifecycleDeckShell({ title, pages }) {
  const t = CARTESIA;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
  @page{size:13.333in 7.5in;margin:0}*{box-sizing:border-box}body{margin:0;background:${t.paper};color:${t.ink};font-family:${t.sans}}.deck-page{position:relative;width:13.333in;height:7.5in;overflow:hidden;background:${t.paper};page-break-after:always}.deck-page:last-child{page-break-after:auto}.deck-head{height:.82in;padding:.19in .46in;border-bottom:1px solid ${t.line};display:flex;align-items:center;justify-content:space-between}.brand-lockup{display:flex;align-items:center;gap:.12in}.brand-lockup svg{width:.44in;height:.44in}.brand-word{font-size:18px;line-height:19px;font-weight:800;letter-spacing:-.7px}.brand-sub{margin-top:3px;font:700 7px/10px ${t.mono};letter-spacing:1.5px;color:#999}.brand-sub span{color:${t.blue}}.folio{font:700 8px/11px ${t.mono};letter-spacing:1.5px;color:${t.blue}}.deck-body{height:6.18in;padding:.42in .46in}.split{display:grid;grid-template-columns:1fr 1fr;gap:.42in;align-items:center;height:100%}.split.reverse>.copy-panel{order:2}.split.reverse>.visual-panel{order:1}.eyebrow{font:700 8px/13px ${t.mono};letter-spacing:2px;color:${t.blue};text-transform:uppercase}.display{margin:.16in 0 0;font-size:46px;line-height:46px;letter-spacing:-2.2px;max-width:5.35in}.lede{margin:.18in 0 0;max-width:5.35in;font-size:16px;line-height:24px;color:${t.body}}.rule{border-top:1px solid ${t.line};margin:.24in 0}.facts{display:grid;gap:.1in;margin-top:.22in}.fact{font-size:13px;line-height:18px;color:${t.ink};padding-left:.2in;position:relative}.fact:before{content:'✓';position:absolute;left:0;color:${t.blue}}.browser{background:#fff;border:1px solid ${t.line};box-shadow:0 20px 42px rgba(10,10,10,.08)}.browser-top{height:.42in;border-bottom:1px solid ${t.line};padding:.12in .15in;display:flex;align-items:center}.traffic{width:7px;height:7px;border-radius:50%;margin-right:5px}.red{background:#ff6b5f}.amber{background:#f4bc4f}.green{background:#52c66d}.browser-label{margin-left:8px;font:700 7px/11px ${t.mono};letter-spacing:1.3px;color:#999}.browser-body{padding:.25in}.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid ${t.line};border-bottom:1px solid ${t.line};margin-top:.28in}.stat{padding:.15in}.stat+.stat{border-left:1px solid ${t.line}}.stat-label{font:700 7px/10px ${t.mono};letter-spacing:1.3px;color:#999}.stat-value{margin-top:5px;font-size:26px;font-weight:800}.roster{display:grid;gap:.08in}.person{display:grid;grid-template-columns:.66in 1.5in 1fr;gap:.15in;align-items:center;padding:.11in 0;border-bottom:1px solid #eeeae4}.person:last-child{border-bottom:0}.person-avatar{width:.62in;height:.62in;border-radius:50%;overflow:hidden;background:#fff4f8;border:2px solid #f6c5dc}.person-avatar svg{display:block;width:100%;height:100%}.person-name{font-size:16px;font-weight:800}.person-role{margin-top:3px;font:700 8px/12px ${t.mono};letter-spacing:1px;color:#d63384}.person-one-line{font-size:11px;line-height:15px;color:${t.body};max-width:2.4in}.card-list{display:grid;gap:.1in}.card{padding:.15in .17in;border:1px solid ${t.line};background:#fff}.card-kicker{font:700 7px/10px ${t.mono};letter-spacing:1.2px;color:${t.blue}}.card-title{margin-top:4px;font-size:13px;line-height:17px;font-weight:700}.card-copy{margin-top:4px;font-size:10px;line-height:15px;color:${t.body}}.big-word{position:absolute;left:-.1in;right:-.1in;bottom:.1in;white-space:nowrap;font-size:62px;line-height:64px;font-weight:800;letter-spacing:-3px;color:transparent;-webkit-text-stroke:1px #d9d6cf}.stripe{height:.3in;border-top:1px solid ${t.line};border-bottom:1px solid ${t.line};background:repeating-linear-gradient(90deg,transparent 0,transparent 2px,rgba(0,0,0,.035) 2px,rgba(0,0,0,.035) 3px)}
  </style></head><body>${pages.join('')}</body></html>`;
}

export function deckPage({ index, label, body, footerWord = '' }) {
  return `<section class="deck-page"><header class="deck-head">${brandLockup({ compact: true })}<div class="folio">DAY-0 / ${String(index).padStart(2, '0')}</div></header><div class="deck-body">${body}</div>${footerWord ? `<div class="big-word">${escapeHtml(footerWord)}</div>` : ''}</section>`;
}
