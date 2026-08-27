import { humationAvatarPublicUrl, renderHumationAvatarSvg, resolveHumationLane } from '../humation-avatar.js';
import { CARTESIA, browserChrome, deckPage, escapeHtml, lifecycleDeckShell, lifecycleEmailShell, lifecycleSubject } from './cartesia-lifecycle.js';

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
    return {
      ...normalized,
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
    version: 'day-0-v2',
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
  const rows = report.team.slice(0, 4).map((member) => `<tr><td class="person"><table role="presentation" width="100%"><tr><td width="52"><div class="avatar"><img src="${escapeHtml(member.avatarUrl)}" width="42" height="42" alt="${escapeHtml(member.name)}"></div></td><td><div class="person-name">${escapeHtml(member.name)}</div><div class="person-role">${escapeHtml(member.role.toUpperCase())}</div></td><td class="person-summary" align="right" style="max-width:230px;color:${CARTESIA.body};font-size:11px;line-height:16px">${escapeHtml(member.oneLiner)}</td></tr></table></td></tr>`).join('');
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
  const roster = `<div class="roster">${report.team.map((member) => `<div class="person"><div class="person-avatar">${member.avatarSvg}</div><div><div class="person-name">${escapeHtml(member.name)}</div><div class="person-role">${escapeHtml(member.role.toUpperCase())}</div></div><div class="person-one-line">${escapeHtml(member.oneLiner)}</div></div>`).join('') || '<div class="card-copy">Your first HyperAgent can be recruited from the workspace.</div>'}</div>`;
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

export function renderDayZeroOnboardingReportHtml(input, options = {}) {
  const report = buildDayZeroOnboardingReport(input, options);
  return { report, html: lifecycleDeckShell({ title: `Day-0 report - ${report.companyName}`, pages: reportPages(report) }) };
}
