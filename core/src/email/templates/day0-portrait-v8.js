// Day-0 v8 portrait report — editorial "operating intelligence" design.
// SINGULANCE branding for every tenant; company identity is data only.
// Uses the v2 report shell (Space Grotesk + IBM Plex Mono) and embeds the
// real website screenshot captured during onboarding.
import { CARTESIA, escapeHtml, reportPage, reportShell, REPORT_DISPLAY, REPORT_MONO } from './cartesia-lifecycle.js';

function hostname(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return String(value || '').slice(0, 80); }
}

function shotBar(url) {
  return `<div class="rshot-bar"><span class="rshot-dot" style="background:#ff6b5f"></span><span class="rshot-dot" style="background:#f4bc4f"></span><span class="rshot-dot" style="background:#52c66d"></span><span class="rshot-url">${escapeHtml(url || 'company website')}</span></div>`;
}

function stats(report) {
  return `<div class="rstats"><div class="rstat"><b>${report.sourceCount}</b><span>Sources read</span></div><div class="rstat"><b>${report.taskCount}</b><span>First moves</span></div><div class="rstat"><b>${report.teamCount}</b><span>HyperAgents</span></div></div>`;
}

function factList(items) {
  return items.filter(Boolean).map((item) => `<div class="rfact">${escapeHtml(item)}</div>`).join('');
}

function cards(items, renderer) {
  return `<div class="rgrid2">${items.map((item, index) => `<div class="rcard">${renderer(item, index)}</div>`).join('')}</div>`;
}

function itemsList(entries) {
  return entries.map((entry, index) => `<div class="ritem"><div class="rnum">${String(index + 1).padStart(2, '0')}</div><div><div class="rcard-kicker">${escapeHtml((entry.kicker || 'ITEM').toUpperCase())}</div><div class="rcard-title">${escapeHtml(entry.title)}</div>${entry.copy ? `<div class="rcard-copy">${escapeHtml(entry.copy)}</div>` : ''}${entry.url ? `<div class="rcard-copy" style="color:${CARTESIA.blue}">${escapeHtml(hostname(entry.url))}</div>` : ''}</div></div>`).join('');
}

export function renderDayZeroPortraitV8(report, { screenshotDataUri = '', orgId = '' } = {}) {
  const coverShot = screenshotDataUri
    ? `<div class="rshot">${shotBar(report.websiteHost)}<img src="${screenshotDataUri}" alt="${escapeHtml(report.websiteHost || report.companyName)} homepage"></div>`
    : `<div class="rshot">${shotBar(report.websiteHost)}<div style="padding:14mm;text-align:center;font:600 8px/12px ${REPORT_MONO};color:${CARTESIA.muted}">Website preview captured during onboarding</div></div>`;

  const research = (report.researchItems.length ? report.researchItems : report.sourceUrls.slice(0, 6).map((url) => ({ title: hostname(url), summary: url, url })));
  const moves = report.firstMoves.map((move) => ({ kicker: move.room || 'FIRST MOVE', title: move.title, copy: move.deliverable || move.detail }));
  const documents = report.documents.map((doc) => ({ kicker: 'MEMORY DOCUMENT', title: doc }));
  const profile = report.profileRows.map(([label, value]) => ({ kicker: label, title: '', copy: value }));

  const pages = [
    // ── Cover: gradient band, display title, mission lede, real screenshot, stats
    reportPage({
      pageNumber: 1, totalPages: 6, footerWord: 'THE RISE OF AWAKENING',
      body: `<div class="rcover-band"></div>
        <div class="reyebrow">DAY 0 · THE RISE OF AWAKENING</div>
        <h1 class="rh1">${escapeHtml(report.companyName)}<br>has awakened.</h1>
        <p class="rlede">HIVEMIND read ${report.sourceCount} sources across ${escapeHtml(report.websiteHost || 'your website')}, shaped the first operating model of <strong>${escapeHtml(report.companyName)}</strong>, and prepared the people and first moves now waiting inside your workspace.</p>
        <div style="margin-top:6mm">${coverShot}</div>
        <div style="margin-top:6mm">${stats(report)}</div>
        <div style="margin-top:6mm" class="rquote"><q>Welcome to the world of SINGULANCE. Congratulations on being among the first to onboard your company with us. Here's to the future — and a new way of running your company.</q><div class="rquote-by">AMAR SAI GADDE · FOUNDER &amp; CEO</div></div>`,
    }),
    // ── Company record
    reportPage({
      pageNumber: 2, totalPages: 6, footerWord: 'COMPANY RECORD',
      body: `<div class="reyebrow">COMPANY RECORD · 02</div>
        <h2 class="rh2">The first shape of ${escapeHtml(report.companyName)}.</h2>
        <p class="rlede">${escapeHtml(report.whatItDoes || report.positioning || report.tagline || 'Your company record is ready for review.')}</p>
        <div class="rrule"></div>
        ${profile.length ? itemsList(profile.map((row) => ({ kicker: row.kicker, title: '', copy: row.copy }))) : ''}
        ${report.facts.length ? `<div class="rrule"></div><div class="reyebrow" style="color:${CARTESIA.muted}">VERIFIED SIGNALS</div>${factList(report.facts.slice(0, 5))}` : ''}`,
    }),
    // ── Market & audience
    reportPage({
      pageNumber: 3, totalPages: 6, footerWord: 'WHO YOU SERVE',
      body: `<div class="reyebrow">MARKET &amp; AUDIENCE · 03</div>
        <h2 class="rh2">A company with a clear customer.</h2>
        <p class="rlede">${escapeHtml(report.icp || 'HIVEMIND prepared an initial audience hypothesis for you to validate.')}</p>
        <div class="rrule"></div>
        ${report.location ? factList([`Company location: ${report.location}`, report.offer ? `Offer: ${report.offer}` : '', report.tagline ? `Tagline: ${report.tagline}` : '']) : ''}
        <div class="rrule"></div>
        <div class="reyebrow" style="color:${CARTESIA.muted}">MARKET RESEARCH</div>
        ${itemsList(research.slice(0, 6).map((item) => ({ kicker: 'MARKET RESEARCH', title: item.title || hostname(item.url), copy: item.summary, url: item.url })))}`,
    }),
    // ── Mission & positioning
    reportPage({
      pageNumber: 4, totalPages: 6, footerWord: 'WHY YOU EXIST',
      body: `<div class="reyebrow">MISSION &amp; POSITIONING · 04</div>
        <h2 class="rh2">Your reason to exist, made operational.</h2>
        <div class="rrule"></div>
        <div class="rquote"><q>${escapeHtml(report.mission || report.positioning || 'Your mission is ready for your judgement.')}</q><div class="rquote-by">${escapeHtml(report.companyName.toUpperCase())} · MISSION</div></div>
        <div style="margin-top:5mm" class="rrule"></div>
        <div class="reyebrow" style="color:${CARTESIA.muted}">POSITIONING</div>
        <p class="rlede">${escapeHtml(report.positioning || report.whatItDoes || '—')}</p>
        ${report.contacts.length ? `<div class="rrule"></div><div class="reyebrow" style="color:${CARTESIA.muted}">OFFICIAL CONTACT POINTS</div><div style="margin-top:2mm">${report.contacts.slice(0, 6).map((c) => `<span class="rchip">${escapeHtml(c)}</span> `).join('')}</div>` : ''}`,
    }),
    // ── The team
    reportPage({
      pageNumber: 5, totalPages: 6, footerWord: 'AGENTS THAT ACT',
      body: `<div class="reyebrow">HIVEMIND · HYPERAGENTS · 05</div>
        <h2 class="rh2">We recruited ${report.teamCount} AI HyperAgent${report.teamCount === 1 ? '' : 's'} to run ${escapeHtml(report.companyName)}.</h2>
        <p class="rlede">Each operates with a distinct role and clear operating responsibility — grounded in the company record filed during onboarding.</p>
        <div class="rrule"></div>
        <div style="display:grid;gap:3mm">${report.team.map((member) => `<div class="ragent"><div class="ragent-avatar" style="background:${member.background};border-color:${member.color}">${member.avatarSvg}</div><div><div class="ragent-name">${escapeHtml(member.name)}</div><div class="ragent-role" style="color:${member.color}">${escapeHtml(member.role.toUpperCase())}</div></div><div class="ragent-copy">${escapeHtml(member.oneLiner)}</div></div>`).join('')}</div>`,
    }),
    // ── First moves + memory
    reportPage({
      pageNumber: 6, totalPages: 6, footerWord: 'FIRST MOVES',
      body: `<div class="reyebrow">FIRST COMPANY MOVES · 06</div>
        <h2 class="rh2">Work waiting to become real.</h2>
        <p class="rlede">HIVEMIND converted the company model into concrete first moves. Review, refine, and send the right one into a room.</p>
        <div class="rrule"></div>
        ${itemsList(moves.slice(0, 6))}
        ${documents.length ? `<div class="rrule"></div><div class="reyebrow" style="color:${CARTESIA.muted}">MEMORY FILED FOR RECALL</div>${itemsList(documents.slice(0, 4))}` : ''}
        ${report.sourceUrls.length ? `<div class="rrule"></div><div class="reyebrow" style="color:${CARTESIA.muted}">SOURCES READ (${report.sourceCount})</div><div style="margin-top:2mm">${report.sourceUrls.slice(0, 8).map((url) => `<span class="rchip">${escapeHtml(hostname(url))}</span> `).join('')}</div>` : ''}`,
    }),
  ];

  return reportShell({ title: `Day 0 - ${report.companyName}`, pages, reportLabel: 'DAY 0 · AWAKENING REPORT' });
}
