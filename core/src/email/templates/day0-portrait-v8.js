// Day-0 editorial portrait report. The email remains owned by
// day0-company-onboarding.js; this renderer changes only the PDF attachment.
// It follows the flowing Day-1 research-report grammar so the complete
// onboarding record reads as one report rather than a slide deck.
import { CARTESIA, escapeHtml, brandLockup, REPORT_MONO } from './cartesia-lifecycle.js';

function hostname(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return String(value || '').slice(0, 80); }
}

function section(title, chapter, content) {
  return `<section class="report-section"><div class="section-head"><div class="eyebrow">${escapeHtml(title)} · ${escapeHtml(chapter)}</div></div>${content}</section>`;
}

function rows(items, { numbered = false } = {}) {
  return `<div class="rows">${items.filter(Boolean).map((item, index) => `<div class="row${numbered ? ' numbered' : ''}">${numbered ? `<div class="row-number">${String(index + 1).padStart(2, '0')}</div>` : ''}<div class="row-body">${item}</div></div>`).join('')}</div>`;
}

function textRow(label, value, extra = '') {
  if (!value) return '';
  return `<div class="row-label">${escapeHtml(label)}</div><div class="row-title">${escapeHtml(value)}</div>${extra}`;
}

function characterStrip(team = []) {
  if (!team.length) return '';
  return `<div class="character-strip">${team.slice(0, 8).map((member) => `<div class="character"><div class="character-avatar" style="background:${member.background};border-color:${member.color}">${member.avatarSvg}</div><div class="character-name">${escapeHtml(member.name)}</div><div class="character-role" style="color:${member.color}">${escapeHtml(member.role)}</div></div>`).join('')}</div>`;
}

export function renderDayZeroPortraitV8(report, { screenshotDataUri = '' } = {}) {
  const screenshot = screenshotDataUri
    ? `<div class="browser"><div class="browser-bar"><i class="red"></i><i class="amber"></i><i class="green"></i><span>${escapeHtml(report.websiteHost || report.website || 'company website')}</span></div><img src="${screenshotDataUri}" alt="${escapeHtml(report.companyName)} homepage"></div>`
    : `<div class="browser browser-empty"><div class="browser-bar"><i class="red"></i><i class="amber"></i><i class="green"></i><span>${escapeHtml(report.websiteHost || report.website || 'company website')}</span></div><div>Website preview was unavailable when this report was generated.</div></div>`;
  const companyRows = report.profileRows.map(([label, value]) => textRow(label, value));
  const facts = report.facts.map((fact) => `<div class="fact">${escapeHtml(fact)}</div>`);
  const research = report.researchItems.length
    ? report.researchItems.map((item) => textRow('ONBOARDING RESEARCH', item.title || hostname(item.url), `${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}${item.url ? `<a href="${escapeHtml(item.url)}">${escapeHtml(hostname(item.url))}</a>` : ''}`))
    : report.sourceUrls.map((url) => textRow('FIRST-PARTY SOURCE', hostname(url), `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`));
  const moves = report.firstMoves.map((move) => textRow(move.room || 'FIRST MOVE', move.title, `<p>${escapeHtml(move.deliverable || move.detail || '')}</p>`));
  const documents = report.documents.map((name) => textRow('MEMORY DOCUMENT', name));
  const sources = report.sourceUrls.map((url) => textRow('SOURCE', hostname(url), `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`));
  const confirmations = report.confirmations.map((item) => `<div class="confirmation">${escapeHtml(item)}</div>`);

  const printCss = `<style id="day0-print-pagination">
  @page{size:A4 portrait;margin:24mm 15mm 18mm}
  body{background:#fff}p{orphans:3;widows:3}.page{padding:0;background:#fff}
  .head{position:fixed;z-index:10;top:-19mm;left:0;right:0;height:14mm;padding:0 0 3mm;background:#fff}
  .foot{position:fixed;z-index:10;left:0;right:0;bottom:-13mm;height:9mm;margin:0;padding-top:2.5mm;background:#fff}
  .intro{padding-top:3mm}.report-section{break-inside:auto;page-break-inside:auto}
  .section-head{break-after:avoid;page-break-after:avoid}.section-head+h2,h2+.lede{break-before:avoid;page-break-before:avoid}
  .row,.fact,.confirmation,.mission,.character-strip,.browser,.stats,.cta{break-inside:avoid;page-break-inside:avoid}
  </style>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Day 0 - ${escapeHtml(report.companyName)}</title><style>
  @page{size:A4 portrait;margin:0}*{box-sizing:border-box}body{margin:0;background:${CARTESIA.paper};color:${CARTESIA.ink};font-family:Arial,"Noto Sans","Segoe UI Symbol",sans-serif;overflow-wrap:anywhere}.page{padding:12mm 15mm 14mm;background:linear-gradient(180deg,#f4f8ff 0,#fff 34mm,#fff 100%)}.head{display:flex;align-items:center;justify-content:space-between;padding-bottom:5mm;border-bottom:1px solid ${CARTESIA.line}}.brand-lockup{display:flex;align-items:center;gap:3mm}.brand-lockup svg{width:10mm;height:10mm}.brand-word{font-size:18px;font-weight:800;letter-spacing:-.6px}.brand-sub{margin-top:2px;font:700 6px/9px ${REPORT_MONO};letter-spacing:1.3px;color:#999}.brand-sub span{color:${CARTESIA.blue}}.folio{font:700 7px/10px ${REPORT_MONO};letter-spacing:1.5px;color:${CARTESIA.blue}}.intro{padding:8mm 0 7mm;border-bottom:1px solid ${CARTESIA.line}}.eyebrow,.row-label{font:700 7px/11px ${REPORT_MONO};letter-spacing:1.6px;color:${CARTESIA.blue};text-transform:uppercase}h1{margin:3mm 0 0;max-width:170mm;font-size:31px;line-height:1.04;letter-spacing:-1.2px}h2{margin:2mm 0 0;font-size:23px;line-height:1.12;letter-spacing:-.6px}.lede{max-width:170mm;margin:4mm 0 0;color:${CARTESIA.body};font-size:11px;line-height:17px}.stats{display:grid;grid-template-columns:repeat(4,1fr);margin-top:5mm;border:1px solid ${CARTESIA.line};break-inside:avoid}.stat{padding:4mm}.stat+.stat{border-left:1px solid ${CARTESIA.line}}.stat b{display:block;font-size:23px}.stat span{font:700 6px/9px ${REPORT_MONO};letter-spacing:1px;color:#888}.browser{margin-top:6mm;background:#fff;border:1px solid ${CARTESIA.line};box-shadow:0 5mm 12mm rgba(10,10,10,.08);break-inside:avoid}.browser-bar{height:9mm;padding:3mm 4mm;border-bottom:1px solid ${CARTESIA.line};display:flex;align-items:center;gap:1.5mm}.browser-bar i{width:4px;height:4px;border-radius:50%}.browser-bar .red{background:#ff6b5f}.browser-bar .amber{background:#f4bc4f}.browser-bar .green{background:#52c66d}.browser-bar span{margin-left:2mm;font:700 5px/8px ${REPORT_MONO};letter-spacing:1px;color:#999}.browser img{display:block;width:100%;max-height:86mm;object-fit:cover;object-position:top}.browser-empty>div:last-child{padding:18mm;text-align:center;color:${CARTESIA.muted};font:700 7px/11px ${REPORT_MONO}}.character-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:5mm;margin-top:6mm;break-inside:avoid}.character{text-align:center}.character-avatar{width:15mm;height:15mm;margin:0 auto 1.5mm;border-radius:50%;overflow:hidden;border:1px solid}.character-avatar svg{display:block;width:100%;height:100%}.character-name{font-size:8px;line-height:10px;font-weight:800}.character-role{margin-top:1px;font-size:6px;line-height:8px}.report-section{padding-top:7mm}.section-head{padding-bottom:3mm;border-bottom:1px solid ${CARTESIA.line};break-after:avoid}.rows{display:grid}.row{padding:4mm 0;border-bottom:1px solid ${CARTESIA.line};break-inside:avoid}.row.numbered{display:grid;grid-template-columns:12mm 1fr;gap:3mm}.row-number{font:700 9px/13px ${REPORT_MONO};color:${CARTESIA.blue}}.row-title{margin-top:1mm;font-size:13px;line-height:18px;font-weight:800}.row p{margin:1.5mm 0 0;color:${CARTESIA.body};font-size:9px;line-height:14px}.row a{display:block;margin-top:1.5mm;color:${CARTESIA.blue};font-size:8px;line-height:11px;text-decoration:none;word-break:break-all}.facts{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin-top:4mm}.fact,.confirmation{padding:4mm;border:1px solid ${CARTESIA.line};background:#fff;font-size:9px;line-height:14px;break-inside:avoid}.mission{margin-top:4mm;padding:6mm;background:#101010;color:#fff;break-inside:avoid}.mission q{font-size:15px;line-height:21px;font-weight:700}.mission div{margin-top:3mm;font:700 6px/9px ${REPORT_MONO};letter-spacing:1.1px;color:#83b6ed}.confirmations{display:grid;gap:2mm;margin-top:4mm}.confirmation{border-left:2px solid ${CARTESIA.blue};background:#f4f8ff}.contacts{margin-top:4mm}.chip{display:inline-block;margin:0 2mm 2mm 0;padding:2mm 3mm;border:1px solid ${CARTESIA.line};font-size:8px}.cta{margin-top:8mm;padding:6mm;background:${CARTESIA.blue};color:#fff;break-inside:avoid}.cta h2{margin:0}.cta p{margin:2mm 0 0;font-size:10px;line-height:15px}.cta a{display:inline-block;margin-top:4mm;color:#fff;font:700 8px/11px ${REPORT_MONO};letter-spacing:1px;text-decoration:none}.foot{margin-top:8mm;padding-top:3mm;border-top:1px solid ${CARTESIA.line};display:flex;justify-content:space-between;font:700 6px/9px ${REPORT_MONO};letter-spacing:1.1px;color:#999;break-inside:avoid}.foot a{color:${CARTESIA.blue};text-decoration:none}
  </style></head><body><main class="page"><header class="head">${brandLockup({ compact: true })}<div class="folio">DAY-0 / AWAKENING</div></header><section class="intro"><div class="eyebrow">HIVEMIND · COMPANY AWAKENING COMPLETE</div><h1>${escapeHtml(report.companyName)} has awakened.</h1><p class="lede">Prepared from the complete onboarding record. This report preserves the company context, research, sources, people, memory, and first moves now available inside HIVEMIND.</p><div class="stats"><div class="stat"><b>${report.sourceCount}</b><span>SOURCES READ</span></div><div class="stat"><b>${report.documentCount}</b><span>MEMORY FILES</span></div><div class="stat"><b>${report.taskCount}</b><span>FIRST MOVES</span></div><div class="stat"><b>${report.teamCount}</b><span>HYPERAGENTS</span></div></div>${screenshot}</section>
  ${section('COMPANY RECORD','01', `<h2>The first working model of ${escapeHtml(report.companyName)}.</h2><p class="lede">${escapeHtml(report.whatItDoes || report.positioning || report.tagline || 'Your company context is ready for review.')}</p>${rows(companyRows)}${facts.length ? `<div class="facts">${facts.join('')}</div>` : ''}`)}
  ${section('MARKET & AUDIENCE','02', `<h2>Who you serve and where you compete.</h2><p class="lede">${escapeHtml(report.icp || 'HIVEMIND prepared an initial audience hypothesis for founder validation.')}</p>${rows(research, { numbered: true })}`)}
  ${section('MISSION & POSITIONING','03', `<h2>Your reason to exist, made operational.</h2><div class="mission"><q>${escapeHtml(report.mission || report.positioning || 'Your mission is ready for founder review.')}</q><div>${escapeHtml(report.companyName.toUpperCase())} · MISSION</div></div>${rows([textRow('POSITIONING', report.positioning || report.whatItDoes), textRow('OFFER', report.offer), textRow('TAGLINE', report.tagline)])}${report.contacts.length ? `<div class="contacts">${report.contacts.map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join('')}</div>` : ''}`)}
  ${section('HIVEMIND · HYPERAGENTS','04', `<h2>${report.teamCount} digital employees now know your company.</h2><p class="lede">Each HyperAgent has a distinct operating responsibility grounded in the company record created during onboarding.</p>${characterStrip(report.team)}${rows(report.team.map((member) => textRow(member.role, member.name, `<p>${escapeHtml(member.oneLiner)}</p>`)))}`)}
  ${section('FIRST COMPANY MOVES','05', `<h2>Work waiting to become real.</h2><p class="lede">These are the initial tasks HIVEMIND prepared from the onboarding record.</p>${rows(moves, { numbered: true })}`)}
  ${section('COMPANY MEMORY','06', `<h2>What HIVEMIND filed for recall.</h2><p class="lede">These retained documents can ground future rooms, decisions, and agent actions.</p>${rows(documents, { numbered: true })}`)}
  ${section('SOURCE & EVIDENCE LEDGER','07', `<h2>Every company claim starts with a retained source.</h2>${rows(sources, { numbered: true })}`)}
  ${report.confirmations.length ? section('HUMAN CONFIRMATION','08', `<h2>The model knows where it still needs you.</h2><div class="confirmations">${confirmations.join('')}</div>`) : ''}
  <section class="cta"><div class="eyebrow" style="color:#d7eaff">YOUR COMPANY IS READY</div><h2>Continue inside HIVEMIND.</h2><p>Review the company model, inspect the retained evidence, meet your HyperAgents, and begin the first move.</p><a href="${escapeHtml(report.reportUrl)}">OPEN YOUR COMPANY →</a></section><footer class="foot"><span>SINGULANCE · HIVEMIND OPERATING SYSTEM</span><span>DAY 0 · COMPANY AWAKENING</span></footer></main></body></html>`;
  return html.replace('</head>', `${printCss}</head>`);
}
