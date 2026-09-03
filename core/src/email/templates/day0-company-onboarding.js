import { humationAvatarPublicUrl, humationLaneVisual, renderHumationAvatarSvg, resolveHumationLane } from '../humation-avatar.js';
import { CARTESIA, brandLockup, browserChrome, deckPage, escapeHtml, lifecycleEmailShell, lifecycleSubject } from './cartesia-lifecycle.js';

// Delivery version is deliberately part of the generated artefact contract.
// A newer renderer can therefore be reissued once without treating a browser
// refresh as permission to resend a lifecycle message.
export const DAY_ZERO_REPORT_VERSION = 'day-0-v6';

function clean(value, limit = 360) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function hostname(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return clean(value, 80); }
}

function unique(values, limit) {
  return [...new Set(values.map((value) => clean(value)).filter(Boolean))].slice(0, limit);
}

function firstSentence(value, limit = 180) {
  const normalized = clean(value, limit * 2);
  if (!normalized) return '';
  const match = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  return clean(match?.[1] || normalized, limit);
}

const ROLE_ONE_LINERS = Object.freeze({
  Strategist: 'Turns company context into priorities, plans, and clear operating decisions.',
  Builder: 'Transforms approved plans into concrete assets, workflows, and deliverables.',
  Skeptic: 'Challenges assumptions, checks risk, and makes every recommendation defensible.',
  Researcher: 'Finds the evidence, market signals, and source context your company needs.',
  Communicator: 'Translates company intelligence into precise messages people can act on.',
});

/** One deterministic view-model shared by email and report-deck renderers. */
export function buildDayZeroOnboardingReport(company = {}, { appUrl, logoUrl, publicApiUrl, embedEmailAvatars = false } = {}) {
  const profile = company.profile && typeof company.profile === 'object' ? company.profile : {};
  const name = clean(company.company || profile.company_name || 'Your company', 110);
  const website = safeUrl(company.website || profile.website || '');
  const research = Array.isArray(company.research) ? company.research : [];
  const tasks = Array.isArray(company.tasks) ? company.tasks : [];
  const team = Array.isArray(company.team) ? company.team : [];
  const documents = unique(Array.isArray(company.documents) ? company.documents : [], 12);
  const sourcePages = Array.isArray(company.source_pages) ? company.source_pages : [];
  const socialProfiles = Array.isArray(profile.social_profiles) ? profile.social_profiles : [];
  const contactDetails = profile.contact_details && typeof profile.contact_details === 'object' ? profile.contact_details : {};
  const sourceUrls = unique([website, ...sourcePages.map((item) => item?.url), ...research.map((item) => item?.url || item?.source_url || item?.link)].filter(Boolean), 40);
  const facts = unique([profile.what_it_does, profile.tagline, profile.positioning, profile.offer, profile.icp, company.mission], 8);
  const confirmations = unique([
    ...(Array.isArray(profile.unknowns) ? profile.unknowns : []),
    ...(Array.isArray(profile.open_questions) ? profile.open_questions : []),
    ...(Array.isArray(profile.evidence_gaps) ? profile.evidence_gaps : []),
  ], 6);
  const firstMoves = tasks.slice(0, 8).map((task) => ({
    title: clean(task?.title, 120),
    detail: clean(task?.detail || task?.description, 210),
    deliverable: clean(task?.deliverable || task?.output, 160),
    room: clean(task?.room_name || task?.room_tag || task?.tag, 48),
    status: clean(task?.status, 24),
  })).filter((task) => task.title);
  const researchItems = research.slice(0, 8).map((item) => ({
    title: clean(item?.title || item?.name || hostname(item?.url || item?.source_url || item?.link), 120),
    summary: clean(item?.summary || item?.snippet || item?.description, 210),
    url: safeUrl(item?.url || item?.source_url || item?.link),
  })).filter((item) => item.title || item.url);
  const reportUrl = safeUrl(appUrl) || 'https://next.singulancelabs.com/hivemind/app/employees/mycompany';
  const members = team.slice(0, 8).map((member) => {
    const roleTitle = clean(member?.jobTitle || member?.title || member?.roleArchetype || member?.role || 'Company Specialist', 96);
    const lane = resolveHumationLane(member?.lane || member?.archetype || roleTitle);
    const normalized = {
      id: clean(member?.id || member?.slug || member?.name, 160),
      slug: clean(member?.slug, 120),
      name: clean(member?.name, 72),
      role: roleTitle,
      lane,
      roleArchetype: lane,
    };
    const avatarSvg = renderHumationAvatarSvg(normalized, { size: 72 });
    const visual = humationLaneVisual(lane);
    return {
      ...normalized,
      ...visual,
      oneLiner: clean(member?.oneLiner || member?.focus || member?.summary || firstSentence(member?.persona) || ROLE_ONE_LINERS[lane], 180),
      // Email must use the canonical generated portrait. Persisted avatar URLs
      // can point at legacy monochrome assets; the report deck still keeps the
      // vector inline, while mail fetches the same colorized public renderer.
      avatarUrl: embedEmailAvatars ? `data:image/svg+xml;base64,${Buffer.from(avatarSvg).toString('base64')}` : humationAvatarPublicUrl(normalized, publicApiUrl),
      avatarSvg,
    };
  }).filter((member) => member.name);
  const leadAgent = members.find((member) => member.lane === 'Communicator')
    || members.find((member) => member.lane === 'Strategist')
    || members[0]
    || null;

  return {
    version: DAY_ZERO_REPORT_VERSION,
    companyName: name,
    website,
    websiteHost: hostname(website),
    location: clean(company.company_location || profile.location, 100),
    mission: clean(company.mission || profile.mission, 520),
    positioning: clean(profile.positioning || profile.what_it_does || profile.tagline, 520),
    tagline: clean(profile.tagline, 220),
    whatItDoes: clean(profile.what_it_does, 520),
    offer: clean(profile.offer, 360),
    icp: clean(profile.icp, 520),
    profileRows: [
      ['Company location', clean(company.company_location || profile.location, 100)],
      ['Ideal customer', clean(profile.icp, 440)],
      ['Positioning', clean(profile.positioning, 440)],
      ['Mission', clean(company.mission || profile.mission, 440)],
    ].filter(([, value]) => value),
    contacts: unique([
      ...(Array.isArray(contactDetails.emails) ? contactDetails.emails : []),
      ...(Array.isArray(contactDetails.phones) ? contactDetails.phones : []),
      ...socialProfiles.map((item) => item?.url),
    ], 10),
    facts,
    confirmations,
    firstMoves,
    researchItems,
    team: members,
    leadAgent,
    documents,
    sourceUrls,
    sourceCount: sourceUrls.length,
    taskCount: tasks.length,
    teamCount: members.length,
    documentCount: documents.length,
    onboardedAt: clean(company.onboarded_at, 40),
    reportUrl,
    logoUrl: safeUrl(logoUrl || process.env.SINGULANCE_EMAIL_LOGO_URL || ''),
  };
}

function emailStats(report) {
  return `<table role="presentation" width="100%" class="stats"><tr>${[
    ['Sources read', report.sourceCount], ['First moves', report.taskCount], ['HyperAgents', report.teamCount],
  ].map(([label, value]) => `<td class="stat"><div class="stat-label">${escapeHtml(label.toUpperCase())}</div><div class="stat-value">${value}</div></td>`).join('')}</tr></table>`;
}

function founderWelcome() {
  return `<div class="founder-note"><div class="founder-quote">“Welcome to the world of SINGULANCE. Congratulations on being among the first to onboard your company with us. Here’s to the future—and a new way of running your company.”</div><div class="founder-signature">AMAR SAI GADDE · FOUNDER &amp; CEO</div></div>`;
}

function emailRoster(report) {
  const rows = report.team.slice(0, 4).map((member) => `<tr><td class="person"><table role="presentation" width="100%"><tr><td width="52"><div class="avatar" style="background:${member.background};border-color:${member.color}"><img src="${escapeHtml(member.avatarUrl)}" width="42" height="42" alt="${escapeHtml(member.name)}"></div></td><td><div class="person-name">${escapeHtml(member.name)}</div><div class="person-role" style="color:${member.color}">${escapeHtml(member.role.toUpperCase())}</div></td><td class="person-summary" align="right" style="max-width:230px;color:${CARTESIA.body};font-size:11px;line-height:16px">${escapeHtml(member.oneLiner)}</td></tr></table></td></tr>`).join('');
  return rows || `<tr><td style="padding:12px 0;color:${CARTESIA.body};font-size:13px">Your workspace is ready for its first HyperAgent.</td></tr>`;
}

function emailBody(report) {
  const summary = report.whatItDoes || report.positioning || report.tagline || 'Your company model is ready for review.';
  const moves = report.firstMoves.slice(0, 3).map((move) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${CARTESIA.line}"><div style="font:700 8px/12px ${CARTESIA.mono};letter-spacing:1.2px;color:${CARTESIA.blue}">${escapeHtml((move.room || 'FIRST MOVE').toUpperCase())}</div><div style="margin-top:4px;font-size:14px;line-height:19px;font-weight:700">${escapeHtml(move.title)}</div></td></tr>`).join('');
  return `
  <tr><td class="section" style="background:${CARTESIA.paper}"><div class="eyebrow">DAY 0 · THE RISE OF AWAKENING</div><h1 class="h1">${escapeHtml(report.companyName)}<br>has awakened.</h1><p class="copy">${report.leadAgent ? `<strong style="color:${CARTESIA.ink}">${escapeHtml(report.leadAgent.name)} here.</strong> ` : ''}HIVEMIND read your public company context, shaped an operating model, and prepared the people and first moves now waiting inside your workspace.</p>${emailStats(report)}${founderWelcome()}</td></tr>
  <tr><td class="section"><table role="presentation" width="100%" class="stack"><tr><td width="52%" valign="top" style="padding-right:24px"><div class="eyebrow">COMPANY SIGNAL · 02</div><h2 class="h2">${escapeHtml(report.tagline || report.companyName)}</h2><p class="copy">${escapeHtml(summary)}</p></td><td width="48%" valign="top" style="padding-left:24px;border-left:1px solid ${CARTESIA.line}"><div style="font:700 8px/12px ${CARTESIA.mono};letter-spacing:1.2px;color:#999">FIRST-PARTY CONTEXT</div><div style="margin-top:10px;font-size:16px;font-weight:700;color:${CARTESIA.blue}">${escapeHtml(report.websiteHost || report.companyName)}</div>${report.location ? `<div style="margin-top:9px;color:${CARTESIA.body};font-size:12px">${escapeHtml(report.location)}</div>` : ''}${report.icp ? `<div style="margin-top:13px;color:${CARTESIA.body};font-size:12px;line-height:18px"><strong style="color:${CARTESIA.ink}">Built for:</strong> ${escapeHtml(report.icp)}</div>` : ''}</td></tr></table></td></tr>
  <tr><td class="section" style="background:${CARTESIA.paper}"><div class="eyebrow">HIVEMIND - HYPERAGENTS · 03</div><h2 class="h2">We have recruited ${report.teamCount} AI HyperAgent${report.teamCount === 1 ? '' : 's'} to run ${escapeHtml(report.companyName)}.</h2><table role="presentation" width="100%" style="margin-top:15px">${emailRoster(report)}</table></td></tr>
  <tr><td class="section"><table role="presentation" width="100%" class="stack"><tr><td width="52%" valign="top" style="padding-right:24px"><div class="eyebrow">FIRST MOVES · 04</div><table role="presentation" width="100%" style="margin-top:10px">${moves || '<tr><td style="font-size:13px;color:#666">Your first company actions are ready.</td></tr>'}</table></td><td width="48%" valign="top" style="padding-left:24px"><h2 class="h2" style="margin-top:0">Your company is waiting.</h2><p class="copy">Review what HIVEMIND learned, correct anything that needs your judgement, and open the first task that matters.</p><a class="action" href="${escapeHtml(report.reportUrl)}">ENTER YOUR WORKSPACE →</a>${report.leadAgent ? `<div style="margin-top:16px;font:700 8px/12px ${CARTESIA.mono};letter-spacing:1.2px;color:#999">${escapeHtml(report.leadAgent.name.toUpperCase())} · ${escapeHtml(report.leadAgent.role.toUpperCase())}</div>` : ''}</td></tr></table></td></tr>`;
}

function deckStats(report) {
  return `<div class="stat-grid"><div class="stat"><div class="stat-label">SOURCES READ</div><div class="stat-value">${report.sourceCount}</div></div><div class="stat"><div class="stat-label">FIRST MOVES</div><div class="stat-value">${report.taskCount}</div></div><div class="stat"><div class="stat-label">HYPERAGENTS</div><div class="stat-value">${report.teamCount}</div></div></div>`;
}

function factList(items) {
  return `<div class="facts">${items.filter(Boolean).map((item) => `<div class="fact">${escapeHtml(item)}</div>`).join('')}</div>`;
}

function cards(items, renderer) {
  return `<div class="card-list">${items.map((item, index) => `<div class="card">${renderer(item, index)}</div>`).join('')}</div>`;
}

function rosterWindow(report) {
  const roster = `<div class="roster">${report.team.map((member) => `<div class="person"><div class="person-avatar" style="background:${member.background};border-color:${member.color}">${member.avatarSvg}</div><div><div class="person-name">${escapeHtml(member.name)}</div><div class="person-role" style="color:${member.color}">${escapeHtml(member.role.toUpperCase())}</div></div><div class="person-one-line">${escapeHtml(member.oneLiner)}</div></div>`).join('') || '<div class="card-copy">Your first HyperAgent can be recruited from the workspace.</div>'}</div>`;
  return browserChrome('hivemind - hyperagents', roster);
}

function reportPages(report) {
  const companyBrowser = browserChrome(report.websiteHost || 'company source', `<div class="eyebrow">FIRST-PARTY CONTEXT</div><div style="margin-top:.13in;font-size:21px;font-weight:800;color:${CARTESIA.blue}">${escapeHtml(report.websiteHost || report.companyName)}</div>${factList([report.location, report.contacts[0], report.website])}`);
  const profileBrowser = browserChrome('hivemind - company record', cards(report.profileRows, ([label, value]) => `<div class="card-kicker">${escapeHtml(label.toUpperCase())}</div><div class="card-copy">${escapeHtml(value)}</div>`));
  const sourceCards = cards(report.sourceUrls.slice(0, 8), (url, index) => `<div class="card-kicker">SOURCE ${String(index + 1).padStart(2, '0')}</div><div class="card-title">${escapeHtml(hostname(url))}</div>`);
  const moveCards = cards(report.firstMoves.slice(0, 6), (move) => `<div class="card-kicker">${escapeHtml((move.room || 'FIRST MOVE').toUpperCase())}</div><div class="card-title">${escapeHtml(move.title)}</div><div class="card-copy">${escapeHtml(move.deliverable || move.detail)}</div>`);
  const documentCards = cards(report.documents.slice(0, 8), (document, index) => `<div class="card-kicker">MEMORY DOCUMENT ${String(index + 1).padStart(2, '0')}</div><div class="card-title">${escapeHtml(document)}</div>`);
  const researchFallback = report.sourceUrls.slice(0, 6).map((url) => ({ title: hostname(url), summary: url }));
  const researchCards = cards((report.researchItems.length ? report.researchItems : researchFallback).slice(0, 6), (item) => `<div class="card-kicker">MARKET RESEARCH</div><div class="card-title">${escapeHtml(item.title)}</div><div class="card-copy">${escapeHtml(item.summary || hostname(item.url))}</div>`);
  const confirmations = report.confirmations.length ? report.confirmations : ['Confirm positioning and message fit.', 'Review the ideal customer profile.', 'Prioritize the first company task.'];
  const confirmationCards = cards(confirmations.slice(0, 6), (item, index) => `<div class="card-kicker">HUMAN JUDGEMENT ${String(index + 1).padStart(2, '0')}</div><div class="card-title">${escapeHtml(item)}</div>`);
  const positioningWindow = browserChrome('hivemind - positioning', `<div class="eyebrow">POSITIONING</div><div style="margin-top:.15in;font-size:16px;line-height:22px;font-weight:700">${escapeHtml(report.positioning || report.whatItDoes || report.companyName)}</div><div class="rule"></div><div class="eyebrow">MISSION</div><div style="margin-top:.12in;font-size:11px;line-height:17px;color:${CARTESIA.body}">${escapeHtml(report.mission || 'Ready for founder review.')}</div>`);

  return [
    deckPage({ index: 1, footerWord: 'THE RISE OF AWAKENING', body: `<div class="split"><div class="copy-panel"><div class="eyebrow">DAY 0 · THE RISE OF AWAKENING</div><h1 class="display">${escapeHtml(report.companyName)}<br>has awakened.</h1><p class="lede">HIVEMIND created the first working model of <strong>${escapeHtml(report.companyName)}</strong> from the company context discovered during onboarding.</p>${deckStats(report)}</div><div class="visual-panel">${companyBrowser}</div></div>` }),
    deckPage({ index: 2, footerWord: 'COMPANY SIGNAL', body: `<div class="split reverse"><div class="copy-panel"><div class="eyebrow">COMPANY SIGNAL · 02</div><h1 class="display">The first shape of<br>${escapeHtml(report.companyName)}.</h1><p class="lede">${escapeHtml(report.whatItDoes || report.positioning || report.tagline || 'Your company record is ready for review.')}</p>${factList(report.facts.slice(0, 3))}</div><div class="visual-panel">${profileBrowser}</div></div>` }),
    deckPage({ index: 3, footerWord: 'WHO YOU SERVE', body: `<div class="split"><div class="copy-panel"><div class="eyebrow">MARKET & AUDIENCE · 03</div><h1 class="display">A company with<br>a clear customer.</h1><p class="lede">${escapeHtml(report.icp || 'HIVEMIND prepared an initial audience hypothesis for you to validate.')}</p>${factList([report.offer, report.location, report.tagline])}</div><div class="visual-panel">${browserChrome('hivemind - market signal', researchCards)}</div></div>` }),
    deckPage({ index: 4, footerWord: 'WHY YOU EXIST', body: `<div class="split reverse"><div class="copy-panel"><div class="eyebrow">MISSION & POSITIONING · 04</div><h1 class="display">Your reason to exist,<br>made operational.</h1><p class="lede">${escapeHtml(report.mission || report.positioning || 'Your mission is ready for your judgement.')}</p>${factList([report.positioning, report.tagline])}</div><div class="visual-panel">${positioningWindow}</div></div>` }),
    deckPage({ index: 5, footerWord: 'AGENTS THAT ACT', body: `<div class="split"><div class="copy-panel"><div class="eyebrow">HIVEMIND - HYPERAGENTS · 05</div><h1 class="display">We have recruited ${report.teamCount}<br>AI HyperAgent${report.teamCount === 1 ? '' : 's'}.</h1><p class="lede">They are ready to run ${escapeHtml(report.companyName)} with distinct roles and clear operating responsibilities.</p>${factList(report.team.slice(0, 3).map((member) => `${member.name}: ${member.oneLiner}`))}</div><div class="visual-panel">${rosterWindow(report)}</div></div>` }),
    deckPage({ index: 6, footerWord: 'FIRST MOVES', body: `<div class="split reverse"><div class="copy-panel"><div class="eyebrow">FIRST COMPANY MOVES · 06</div><h1 class="display">Work waiting<br>to become real.</h1><p class="lede">HIVEMIND converted the company model into concrete first moves. Review, refine, and send the right one into a room.</p></div><div class="visual-panel">${browserChrome('hivemind - first moves', moveCards)}</div></div>` }),
    deckPage({ index: 7, footerWord: 'MEMORY FILED', body: `<div class="split"><div class="copy-panel"><div class="eyebrow">COMPANY MEMORY · 07</div><h1 class="display">What HIVEMIND<br>filed for recall.</h1><p class="lede">These durable company documents entered the workspace during onboarding and can ground future decisions and actions.</p>${deckStats(report)}</div><div class="visual-panel">${browserChrome('hivemind - company documents', documentCards)}</div></div>` }),
    deckPage({ index: 8, footerWord: 'EVIDENCE FIRST', body: `<div class="split reverse"><div class="copy-panel"><div class="eyebrow">SOURCE LANDSCAPE · 08</div><h1 class="display">Every claim starts<br>with a source.</h1><p class="lede">These are the public company sources HIVEMIND used to establish its first working context.</p></div><div class="visual-panel">${browserChrome('hivemind - source landscape', sourceCards)}</div></div>` }),
    deckPage({ index: 9, footerWord: 'YOUR JUDGEMENT', body: `<div class="split"><div class="copy-panel"><div class="eyebrow">HUMAN CONFIRMATION · 09</div><h1 class="display">The model knows<br>where it needs you.</h1><p class="lede">Confirm these points and every future recall and action becomes more precise.</p></div><div class="visual-panel">${browserChrome('hivemind - review queue', confirmationCards)}</div></div>` }),
    deckPage({ index: 10, footerWord: 'ENTER THE OPERATING SYSTEM', body: `<div class="split reverse"><div class="copy-panel"><div class="eyebrow">YOUR COMPANY · 10</div><h1 class="display">Your company is<br>waiting inside.</h1><p class="lede">Enter Your Company to review the model, meet your HyperAgents, and start the first move that matters.</p><div style="margin-top:.28in;display:inline-block;padding:.13in .2in;background:${CARTESIA.blue};color:#fff;font-size:10px;font-weight:700">ENTER YOUR WORKSPACE →</div></div><div class="visual-panel">${companyBrowser}<div class="stripe" style="margin-top:.22in"></div></div></div>` }),
  ];
}

export function renderDayZeroOnboardingEmail(input, options = {}) {
  const report = buildDayZeroOnboardingReport(input, options);
  return {
    report,
    subject: lifecycleSubject(report.companyName, 0, `The Rise Of Awakening for ${report.companyName}`),
    text: `${report.companyName} has awakened. We read ${report.sourceCount} sources, prepared ${report.taskCount} first moves, and recruited ${report.teamCount} AI HyperAgents to run ${report.companyName}. Open your company: ${report.reportUrl}`,
    html: lifecycleEmailShell({
      title: `Day 0 - The Rise Of Awakening for ${report.companyName}`,
      preheader: `${report.companyName} has awakened inside HIVEMIND.`,
      body: emailBody(report),
      logoUrl: report.logoUrl,
    }),
  };
}

function portraitDayZeroReport(report) {
  const roster = report.team.map((member) => `<div class="agent"><div class="agent-avatar" style="background:${member.background};border-color:${member.color}">${member.avatarSvg}</div><div><div class="agent-name">${escapeHtml(member.name)}</div><div class="agent-role" style="color:${member.color}">${escapeHtml(member.role.toUpperCase())}</div><div class="agent-copy">${escapeHtml(member.oneLiner)}</div></div></div>`).join('');
  const moves = report.firstMoves.map((move, index) => `<div class="item"><div class="number">${String(index + 1).padStart(2, '0')}</div><div><div class="kicker">${escapeHtml((move.room || 'FIRST MOVE').toUpperCase())}</div><div class="item-title">${escapeHtml(move.title)}</div>${move.deliverable || move.detail ? `<div class="item-copy">${escapeHtml(move.deliverable || move.detail)}</div>` : ''}</div></div>`).join('');
  const sources = report.sourceUrls.map((url, index) => `<div class="source"><span>${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(hostname(url))}</strong><br><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></div></div>`).join('');
  const confirmations = (report.confirmations.length ? report.confirmations : ['Confirm positioning and message fit.', 'Review the ideal customer profile.', 'Prioritize the first company task.']).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const profile = report.profileRows.map(([label, value]) => `<div class="profile-row"><div class="kicker">${escapeHtml(label.toUpperCase())}</div><div>${escapeHtml(value)}</div></div>`).join('');
  const research = (report.researchItems.length ? report.researchItems : report.sourceUrls.slice(0, 6).map((url) => ({ title: hostname(url), summary: url, url }))).map((item, index) => `<div class="item"><div class="number">${String(index + 1).padStart(2, '0')}</div><div><div class="kicker">MARKET RESEARCH</div><div class="item-title">${escapeHtml(item.title || hostname(item.url))}</div>${item.summary ? `<div class="item-copy">${escapeHtml(item.summary)}</div>` : ''}${item.url ? `<a class="micro-link" href="${escapeHtml(item.url)}">${escapeHtml(hostname(item.url))}</a>` : ''}</div></div>`).join('');
  const documents = report.documents.map((document, index) => `<div class="item"><div class="number">${String(index + 1).padStart(2, '0')}</div><div><div class="kicker">MEMORY DOCUMENT</div><div class="item-title">${escapeHtml(document)}</div></div></div>`).join('');
  const facts = report.facts.map((fact) => `<div class="fact">${escapeHtml(fact)}</div>`).join('');
  const contacts = report.contacts.map((contact) => `<div class="contact">${escapeHtml(contact)}</div>`).join('');
  const portraitPaginationCss = '.hero + .section{break-before:page;page-break-before:always}';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Day 0 - ${escapeHtml(report.companyName)}</title><style>${portraitPaginationCss}
  @page{size:A4 portrait;margin:0}*{box-sizing:border-box}body{margin:0;background:${CARTESIA.paper};color:${CARTESIA.ink};font-family:Arial,"Noto Sans","Segoe UI Symbol",sans-serif;overflow-wrap:anywhere}.page{padding:12mm 15mm 8mm;background:linear-gradient(180deg,#f4f8ff 0,#fff 31mm,#fff 100%)}.head{display:flex;align-items:center;justify-content:space-between;padding-bottom:5mm;border-bottom:1px solid ${CARTESIA.line}}.brand-lockup{display:flex;align-items:center;gap:3mm}.brand-lockup svg{width:10mm;height:10mm}.brand-word{font-size:18px;font-weight:800;letter-spacing:-.6px}.brand-sub{margin-top:2px;font:700 6px/9px ${CARTESIA.mono};letter-spacing:1.3px;color:#999}.brand-sub span{color:${CARTESIA.blue}}.folio{font:700 7px/10px ${CARTESIA.mono};letter-spacing:1.5px;color:${CARTESIA.blue}}.hero{padding:9mm 0 7mm;border-bottom:1px solid ${CARTESIA.line};break-inside:avoid}.eyebrow,.kicker{font:700 7px/11px ${CARTESIA.mono};letter-spacing:1.5px;color:${CARTESIA.blue};text-transform:uppercase}h1{margin:3mm 0 0;font-size:31px;line-height:1.03;letter-spacing:-1.25px}.lede{max-width:168mm;margin:4mm 0 0;color:${CARTESIA.body};font-size:11px;line-height:17px}.stats{display:grid;grid-template-columns:repeat(4,1fr);margin-top:6mm;border:1px solid ${CARTESIA.line}}.stat{padding:4mm}.stat+.stat{border-left:1px solid ${CARTESIA.line}}.stat b{display:block;font-size:24px}.stat span{font:700 6px/9px ${CARTESIA.mono};letter-spacing:1px;color:#888}.founder{margin-top:5mm;padding:5mm;background:#101010;color:#fff;break-inside:avoid}.founder q{font-size:13px;line-height:19px;font-weight:700}.founder div{margin-top:3mm;font:700 6px/9px ${CARTESIA.mono};letter-spacing:1.1px;color:#83b6ed}.section{padding-top:7mm}.section-head{margin-bottom:4mm;break-after:avoid}.section h2{margin:2mm 0 0;font-size:22px;line-height:1.1;letter-spacing:-.6px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:4mm}.card,.agent,.item,.source,.profile-row,.fact,.contact{break-inside:avoid;page-break-inside:avoid}.card{border:1px solid ${CARTESIA.line};padding:5mm;background:#fff}.card h3{margin:2mm 0;font-size:15px;line-height:19px}.card p,.profile-row,.item-copy,.agent-copy,.fact,.contact{margin:0;color:${CARTESIA.body};font-size:9px;line-height:14px}.profile{display:grid;gap:3mm}.profile-row{padding-bottom:3mm;border-bottom:1px solid ${CARTESIA.line}}.profile-row>div:last-child{margin-top:1mm;color:${CARTESIA.ink}}.fact,.contact{padding:3mm;border-top:1px solid ${CARTESIA.line};color:${CARTESIA.ink}}.agents{display:grid;grid-template-columns:1fr 1fr;gap:3mm}.agent{display:grid;grid-template-columns:15mm 1fr;gap:3mm;padding:4mm;border:1px solid ${CARTESIA.line};background:#fff}.agent-avatar{width:14mm;height:14mm;border:1px solid;border-radius:50%;overflow:hidden}.agent-avatar svg{display:block;width:100%;height:100%}.agent-name{font-size:11px;font-weight:800}.agent-role{margin-top:1px;font:700 6px/9px ${CARTESIA.mono};letter-spacing:.8px}.agent-copy{margin-top:2mm}.items{display:grid;gap:3mm}.item{display:grid;grid-template-columns:10mm 1fr;gap:3mm;padding:4mm;border:1px solid ${CARTESIA.line}}.number{font:700 10px/14px ${CARTESIA.mono};color:${CARTESIA.blue}}.item-title{margin-top:1mm;font-size:12px;line-height:16px;font-weight:800}.item-copy{margin-top:1mm}.micro-link{display:block;margin-top:1mm;color:${CARTESIA.blue};font-size:8px;text-decoration:none}.review{padding:5mm;background:#f4f8ff;border-left:2px solid ${CARTESIA.blue};break-inside:avoid}.review ul{margin:3mm 0 0;padding-left:5mm;font-size:9px;line-height:14px}.sources{display:grid}.source{display:grid;grid-template-columns:10mm 1fr;gap:2mm;padding:3mm 0;border-top:1px solid ${CARTESIA.line};font-size:8px;line-height:12px}.source>span{font:700 7px/11px ${CARTESIA.mono};color:${CARTESIA.blue}}.source a{color:${CARTESIA.body};text-decoration:none;word-break:break-all}.page-break{break-before:page;page-break-before:always}.cta{margin-top:7mm;padding:6mm;background:${CARTESIA.blue};color:#fff;break-inside:avoid}.cta h2{margin:0;font-size:22px}.cta p{margin:2mm 0 0;font-size:10px;line-height:15px}.cta a{display:inline-block;margin-top:4mm;color:#fff;font:700 8px/11px ${CARTESIA.mono};letter-spacing:1px;text-decoration:none}.foot{margin-top:3mm;padding-top:2mm;border-top:1px solid ${CARTESIA.line};display:flex;justify-content:space-between;font:700 6px/9px ${CARTESIA.mono};letter-spacing:1.1px;color:#999;break-inside:avoid}.foot a{color:${CARTESIA.blue};text-decoration:none}
  </style></head><body><main class="page"><header class="head">${brandLockup({ compact: true })}<div class="folio">DAY-0 / AWAKENING</div></header><section class="hero"><div class="eyebrow">DAY 0 · THE RISE OF AWAKENING</div><h1>${escapeHtml(report.companyName)}<br>has awakened.</h1><p class="lede">HIVEMIND created the first working model of <strong>${escapeHtml(report.companyName)}</strong> from the company context discovered during onboarding.</p><div class="stats"><div class="stat"><b>${report.sourceCount}</b><span>SOURCES READ</span></div><div class="stat"><b>${report.taskCount}</b><span>FIRST MOVES</span></div><div class="stat"><b>${report.teamCount}</b><span>HYPERAGENTS</span></div><div class="stat"><b>${report.documentCount}</b><span>MEMORY FILES</span></div></div><div class="founder"><q>Welcome to the world of SINGULANCE. Congratulations on being among the first to onboard your company with us. Here’s to the future—and a new way of running your company.</q><div>AMAR SAI GADDE · FOUNDER &amp; CEO</div></div></section><section class="section"><div class="section-head"><div class="eyebrow">COMPANY SIGNAL · 02</div><h2>The first shape of ${escapeHtml(report.companyName)}.</h2></div><div class="grid"><div class="card"><div class="kicker">WHAT YOU DO</div><h3>${escapeHtml(report.tagline || report.companyName)}</h3><p>${escapeHtml(report.whatItDoes || report.positioning || 'Your company model is ready for review.')}</p></div><div class="card"><div class="kicker">FIRST-PARTY CONTEXT</div><h3>${escapeHtml(report.websiteHost || report.companyName)}</h3><p>${escapeHtml(report.location || report.website || 'Company source retained during onboarding.')}</p></div></div>${profile ? `<div class="profile" style="margin-top:4mm">${profile}</div>` : ''}${facts ? `<div style="margin-top:4mm"><div class="kicker">DISCOVERED FACTS</div>${facts}</div>` : ''}${contacts ? `<div style="margin-top:4mm"><div class="kicker">CONTACT LANDSCAPE</div>${contacts}</div>` : ''}</section><section class="section page-break"><div class="section-head"><div class="eyebrow">MARKET &amp; AUDIENCE · 03</div><h2>A company with a clear customer.</h2><p class="lede">${escapeHtml(report.icp || 'HIVEMIND prepared an initial audience hypothesis for you to validate.')}</p></div><div class="grid"><div class="card"><div class="kicker">OFFER</div><h3>${escapeHtml(report.offer || report.tagline || report.companyName)}</h3><p>${escapeHtml(report.location || 'Market context is ready for founder review.')}</p></div><div class="card"><div class="kicker">POSITIONING SIGNAL</div><h3>${escapeHtml(report.tagline || report.companyName)}</h3><p>${escapeHtml(report.positioning || report.whatItDoes || '')}</p></div></div><div class="items" style="margin-top:4mm">${research}</div></section><section class="section"><div class="section-head"><div class="eyebrow">MISSION &amp; POSITIONING · 04</div><h2>Your reason to exist, made operational.</h2></div><div class="grid"><div class="card"><div class="kicker">MISSION</div><h3>${escapeHtml(report.mission || 'Ready for founder review.')}</h3></div><div class="card"><div class="kicker">POSITIONING</div><h3>${escapeHtml(report.positioning || report.whatItDoes || report.companyName)}</h3><p>${escapeHtml(report.tagline || '')}</p></div></div></section><section class="section page-break"><div class="section-head"><div class="eyebrow">HIVEMIND - HYPERAGENTS · 05</div><h2>We recruited ${report.teamCount} AI HyperAgent${report.teamCount === 1 ? '' : 's'}.</h2><p class="lede">They are ready to run ${escapeHtml(report.companyName)} with distinct roles and clear operating responsibilities.</p></div><div class="agents">${roster || '<div class="card">Your first HyperAgent can be recruited from the workspace.</div>'}</div></section><section class="section"><div class="section-head"><div class="eyebrow">FIRST COMPANY MOVES · 06</div><h2>Work waiting to become real.</h2><p class="lede">HIVEMIND converted the company model into concrete first moves. Review, refine, and send the right one into a room.</p></div><div class="items">${moves || '<div class="card">Your first company actions are ready.</div>'}</div></section><section class="section page-break"><div class="section-head"><div class="eyebrow">COMPANY MEMORY · 07</div><h2>What HIVEMIND filed for recall.</h2><p class="lede">These durable company documents entered the workspace during onboarding and can ground future decisions and actions.</p></div><div class="items">${documents || '<div class="card">No company document name was retained.</div>'}</div></section><section class="section"><div class="section-head"><div class="eyebrow">SOURCE LANDSCAPE · 08</div><h2>Every claim starts with a source.</h2><p class="lede">These are the public company sources HIVEMIND used to establish its first working context.</p></div><div class="sources">${sources || '<div class="card">No public source URL was retained.</div>'}</div></section><section class="section page-break"><div class="section-head"><div class="eyebrow">HUMAN CONFIRMATION · 09</div><h2>The model knows where it needs you.</h2><p class="lede">Confirm these points and every future recall and action becomes more precise.</p></div><div class="review"><div class="kicker">CONFIRM NEXT</div><ul>${confirmations}</ul></div></section><section class="cta"><div class="eyebrow" style="color:#d7eaff">YOUR COMPANY · 10</div><h2>Your company is waiting inside.</h2><p>Enter Your Company to review the model, meet your HyperAgents, and start the first move that matters.</p><a href="${escapeHtml(report.reportUrl)}">ENTER YOUR WORKSPACE →</a></section><footer class="foot"><span>SINGULANCE · YOUR COMPANY, IN MOTION</span><a href="${escapeHtml(report.reportUrl)}">OPEN YOUR COMPANY →</a></footer></main></body></html>`;
}

function cartesiaPortraitDayZeroReport(report) {
  const pages = reportPages(report).join('')
    .replaceAll('deck-page', 'portrait-page')
    .replaceAll('deck-head', 'portrait-head')
    .replaceAll('deck-body', 'portrait-body');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Day 0 - ${escapeHtml(report.companyName)}</title><style>
  @page{size:A4 portrait;margin:0}*{box-sizing:border-box}body{margin:0;background:${CARTESIA.paper};color:${CARTESIA.ink};font-family:${CARTESIA.sans}}.portrait-page{position:relative;width:210mm;height:297mm;overflow:hidden;background:${CARTESIA.paper};page-break-after:always}.portrait-page:last-child{page-break-after:auto}.portrait-head{height:19mm;padding:4mm 10mm;border-top:3mm solid #111;border-bottom:1px solid ${CARTESIA.line};display:flex;align-items:center;justify-content:space-between}.brand-lockup{display:flex;align-items:center;gap:2mm}.brand-lockup svg{width:8mm;height:8mm}.brand-word{font-size:12px;line-height:13px;font-weight:800;letter-spacing:-.4px}.brand-sub{margin-top:1px;font:700 4px/6px ${CARTESIA.mono};letter-spacing:1px;color:#999}.brand-sub span{color:${CARTESIA.blue}}.folio{font:700 5px/8px ${CARTESIA.mono};letter-spacing:1.2px;color:${CARTESIA.blue}}.portrait-body{height:278mm;padding:14mm 11mm 25mm}.split{display:grid;grid-template-rows:auto 1fr;gap:10mm;height:100%;align-content:start}.split.reverse>.copy-panel{order:1}.split.reverse>.visual-panel{order:2}.copy-panel{min-height:72mm;display:flex;flex-direction:column;justify-content:center}.visual-panel{align-self:start}.eyebrow{font:700 6px/10px ${CARTESIA.mono};letter-spacing:1.7px;color:${CARTESIA.blue};text-transform:uppercase}.display{margin:4mm 0 0;font-size:32px;line-height:31px;letter-spacing:-1.5px;max-width:175mm}.lede{margin:5mm 0 0;max-width:172mm;font-size:11px;line-height:17px;color:${CARTESIA.body}}.rule{border-top:1px solid ${CARTESIA.line};margin:5mm 0}.facts{display:grid;gap:2mm;margin-top:5mm}.fact{font-size:9px;line-height:13px;color:${CARTESIA.ink};padding-left:5mm;position:relative}.fact:before{content:'✓';position:absolute;left:0;color:${CARTESIA.blue}}.browser{background:#fff;border:1px solid ${CARTESIA.line};box-shadow:0 8mm 16mm rgba(10,10,10,.08);break-inside:avoid}.browser-top{height:10mm;border-bottom:1px solid ${CARTESIA.line};padding:3mm 4mm;display:flex;align-items:center}.traffic{width:5px;height:5px;border-radius:50%;margin-right:4px}.red{background:#ff6b5f}.amber{background:#f4bc4f}.green{background:#52c66d}.browser-label{margin-left:5px;font:700 5px/8px ${CARTESIA.mono};letter-spacing:1px;color:#999}.browser-body{padding:6mm}.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid ${CARTESIA.line};border-bottom:1px solid ${CARTESIA.line};margin-top:6mm}.stat{padding:4mm}.stat+.stat{border-left:1px solid ${CARTESIA.line}}.stat-label{font:700 5px/8px ${CARTESIA.mono};letter-spacing:1px;color:#999}.stat-value{margin-top:2mm;font-size:20px;font-weight:800}.roster{display:grid;grid-template-columns:1fr 1fr;gap:2mm 5mm}.person{display:grid;grid-template-columns:15mm 32mm 1fr;gap:3mm;align-items:center;padding:3mm 0;border-bottom:1px solid #eeeae4;break-inside:avoid}.person-avatar{width:14mm;height:14mm;border-radius:50%;overflow:hidden;background:#fff4f8;border:1px solid #f6c5dc}.person-avatar svg{display:block;width:100%;height:100%}.person-name{font-size:10px;font-weight:800}.person-role{margin-top:1px;font:700 5px/8px ${CARTESIA.mono};letter-spacing:.7px}.person-one-line{font-size:7px;line-height:10px;color:${CARTESIA.body}}.card-list{display:grid;grid-template-columns:1fr 1fr;gap:3mm}.card{padding:4mm;border:1px solid ${CARTESIA.line};background:#fff;break-inside:avoid}.card-kicker{font:700 5px/8px ${CARTESIA.mono};letter-spacing:1px;color:${CARTESIA.blue}}.card-title{margin-top:2mm;font-size:9px;line-height:12px;font-weight:700}.card-copy{margin-top:1mm;font-size:7px;line-height:10px;color:${CARTESIA.body}}.big-word{position:absolute;left:-2mm;right:-2mm;bottom:5mm;white-space:nowrap;font-size:34px;line-height:36px;font-weight:800;letter-spacing:-1.7px;color:transparent;-webkit-text-stroke:.5px #d9d6cf}.stripe{height:7mm;border-top:1px solid ${CARTESIA.line};border-bottom:1px solid ${CARTESIA.line};background:repeating-linear-gradient(90deg,transparent 0,transparent 2px,rgba(0,0,0,.035) 2px,rgba(0,0,0,.035) 3px)}
  .portrait-head>.brand-lockup{visibility:hidden}.global-brand{position:fixed;z-index:5;top:7mm;left:10mm}
  </style></head><body><div class="global-brand">${brandLockup({ compact: true })}</div>${pages}</body></html>`;
}

export function renderDayZeroOnboardingReportHtml(input, options = {}) {
  const report = buildDayZeroOnboardingReport(input, options);
  return { report, html: cartesiaPortraitDayZeroReport(report) };
}
