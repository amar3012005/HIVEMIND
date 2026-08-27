const BLUE = '#117dff';
const INK = '#090909';
const MUTED = '#686868';
const LINE = '#e8e5de';
const PAPER = '#fcfcfa';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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

/**
 * Converts the persisted onboarding result into a compact, deterministic report.
 * No model call is made here: every displayed field comes from the completed
 * company-onboarding payload or a stable derived count.
 */
export function buildDayZeroOnboardingReport(company = {}, { appUrl, logoUrl } = {}) {
  const profile = company.profile && typeof company.profile === 'object' ? company.profile : {};
  const name = clean(company.company || profile.company_name || 'Your company', 110);
  const website = safeUrl(company.website || profile.website || '');
  const research = Array.isArray(company.research) ? company.research : [];
  const tasks = Array.isArray(company.tasks) ? company.tasks : [];
  const team = Array.isArray(company.team) ? company.team : [];
  const documents = unique(Array.isArray(company.documents) ? company.documents : [], 8);
  const sourcePages = Array.isArray(company.source_pages) ? company.source_pages : [];
  const socialProfiles = Array.isArray(profile.social_profiles) ? profile.social_profiles : [];
  const contactDetails = profile.contact_details && typeof profile.contact_details === 'object' ? profile.contact_details : {};
  const sourceUrls = unique([website, ...sourcePages.map((item) => item?.url), ...research.map((item) => item?.url || item?.source_url || item?.link)].filter(Boolean), 40);
  const facts = unique([
    profile.what_it_does,
    profile.tagline,
    profile.positioning,
    profile.offer,
    profile.icp,
    company.mission,
  ], 6);
  const confirmations = unique([
    ...(Array.isArray(profile.unknowns) ? profile.unknowns : []),
    ...(Array.isArray(profile.open_questions) ? profile.open_questions : []),
    ...(Array.isArray(profile.evidence_gaps) ? profile.evidence_gaps : []),
  ], 3);
  const firstMoves = tasks.slice(0, 4).map((task) => ({
    title: clean(task?.title, 120),
    deliverable: clean(task?.deliverable || task?.detail, 180),
    room: clean(task?.room_name || task?.room_tag || task?.tag, 48),
  })).filter((task) => task.title);
  const reportUrl = safeUrl(appUrl) || 'https://next.singulancelabs.com/hivemind/app/employees/mycompany';
  return {
    version: 'day-0-v1',
    companyName: name,
    website,
    websiteHost: hostname(website),
    location: clean(company.company_location || profile.location, 100),
    mission: clean(company.mission || profile.mission, 440),
    positioning: clean(profile.positioning || profile.what_it_does || profile.tagline, 440),
    tagline: clean(profile.tagline, 220),
    whatItDoes: clean(profile.what_it_does, 440),
    icp: clean(profile.icp, 440),
    profileRows: [
      ['Company location', clean(company.company_location || profile.location, 100)],
      ['ICP', clean(profile.icp, 440)],
      ['Positioning', clean(profile.positioning, 440)],
      ['Mission', clean(company.mission || profile.mission, 440)],
    ].filter(([, value]) => value),
    contacts: unique([
      ...(Array.isArray(contactDetails.emails) ? contactDetails.emails : []),
      ...(Array.isArray(contactDetails.phones) ? contactDetails.phones : []),
      ...socialProfiles.map((item) => item?.url),
    ], 8),
    facts,
    confirmations,
    firstMoves,
    team: team.slice(0, 6).map((member) => ({ name: clean(member?.name, 72), role: clean(member?.role, 72) })).filter((member) => member.name),
    documents,
    sourceUrls,
    sourceCount: sourceUrls.length,
    taskCount: tasks.length,
    teamCount: team.length,
    documentCount: documents.length,
    onboardedAt: clean(company.onboarded_at, 40),
    reportUrl,
    logoUrl: safeUrl(logoUrl || process.env.SINGULANCE_EMAIL_LOGO_URL || ''),
  };
}

function browserBar(label) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:8px 8px 0 0;background:#fff"><tr><td style="padding:10px 14px;border-bottom:1px solid ${LINE}"><span style="color:#ff6b5f;font-size:12px">●</span>&nbsp;<span style="color:#f4bc4f;font-size:12px">●</span>&nbsp;<span style="color:#52c66d;font-size:12px">●</span><span style="margin-left:14px;font:700 8px/12px ${MONO};letter-spacing:1.6px;color:#959595">${escapeHtml(label)}</span></td></tr>`;
}

function sectionLabel(text, index) {
  return `<div style="font:700 9px/14px ${MONO};letter-spacing:2.3px;color:${BLUE}">›&nbsp; ${escapeHtml(text)} &nbsp;·&nbsp; ${String(index).padStart(2, '0')}</div>`;
}

function bulletLines(items, { empty = '', mono = false } = {}) {
  if (!items.length) return empty ? `<p style="margin:16px 0 0;color:${MUTED};font-size:13px;line-height:21px">${escapeHtml(empty)}</p>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px">${items.map((item) => `<tr><td valign="top" style="width:18px;padding:0 0 9px;color:${BLUE};font-size:14px">✓</td><td style="padding:0 0 9px;color:${INK};font:${mono ? `600 10px/18px ${MONO}` : '14px/22px Arial,Helvetica,sans-serif'}">${escapeHtml(item)}</td></tr>`).join('')}</table>`;
}

function reportBody(report) {
  const overview = report.facts.slice(0, 3);
  const sourceCards = report.sourceUrls.slice(0, 4).map((url, index) => `<tr><td style="padding:${index ? '12px 0 0' : '0'}"><a href="${escapeHtml(url)}" style="color:${INK};text-decoration:none"><span style="font:700 9px/14px ${MONO};letter-spacing:1.2px;color:${BLUE}">SOURCE ${String(index + 1).padStart(2, '0')}</span><br><span style="font-size:13px;line-height:20px">${escapeHtml(hostname(url))}</span></a></td></tr>`).join('');
  const moves = report.firstMoves.map((move) => `<tr><td style="padding:0 0 14px"><div style="font:700 9px/14px ${MONO};letter-spacing:1.5px;color:${BLUE}">${escapeHtml(move.room || 'FIRST MOVE')}</div><div style="margin-top:4px;font-size:15px;line-height:21px;font-weight:700;color:${INK}">${escapeHtml(move.title)}</div><div style="margin-top:4px;font-size:12px;line-height:18px;color:${MUTED}">${escapeHtml(move.deliverable)}</div></td></tr>`).join('');
  const people = report.team.map((member) => `${member.name}${member.role ? ` — ${member.role}` : ''}`);
  const profileRows = report.profileRows.map(([label, value]) => `<tr><td style="padding:0 0 12px"><div style="font:700 8px/12px ${MONO};letter-spacing:1.3px;color:#989898">${escapeHtml(label.toUpperCase())}</div><div style="margin-top:4px;font-size:12px;line-height:19px;color:${INK}">${escapeHtml(value)}</div></td></tr>`).join('');
  return `
  <tr><td style="padding:40px 44px 36px;background:${PAPER}">
    ${sectionLabel('DAY-0 ONBOARDING REPORT', 1)}
    <h1 style="margin:17px 0 0;font:700 36px/39px Arial,Helvetica,sans-serif;letter-spacing:-1.5px;color:${INK}">Your company is<br>now alive.</h1>
    <p style="margin:18px 0 0;max-width:490px;font-size:15px;line-height:25px;color:${MUTED}">HIVEMIND has created the first working model of <strong style="color:${INK}">${escapeHtml(report.companyName)}</strong> from your public company context. This report is a deterministic record of what entered your workspace on Day-0.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:27px;border-top:1px solid ${LINE};border-bottom:1px solid ${LINE}"><tr>
      <td style="width:33%;padding:16px 6px 16px 0"><div style="font:700 8px/12px ${MONO};letter-spacing:1.3px;color:#989898">MARKET RESEARCH</div><div style="margin-top:5px;font-size:22px;line-height:25px;font-weight:700">${report.sourceCount}</div></td>
      <td style="width:33%;padding:16px 6px;border-left:1px solid ${LINE};padding-left:16px"><div style="font:700 8px/12px ${MONO};letter-spacing:1.3px;color:#989898">FIRST MOVES</div><div style="margin-top:5px;font-size:22px;line-height:25px;font-weight:700">${report.taskCount}</div></td>
      <td style="width:33%;padding:16px 0 16px 16px;border-left:1px solid ${LINE}"><div style="font:700 8px/12px ${MONO};letter-spacing:1.3px;color:#989898">MEMORY DOCUMENTS</div><div style="margin-top:5px;font-size:22px;line-height:25px;font-weight:700">${report.documentCount}</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:40px 44px;border-top:1px solid ${LINE};background:#fff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td valign="top" width="52%" style="padding-right:26px">
    ${sectionLabel('COMPANY SIGNAL', 2)}
    <h2 style="margin:15px 0 0;font:700 25px/28px Arial,Helvetica,sans-serif;letter-spacing:-.8px;color:${INK}">The first shape of<br>${escapeHtml(report.companyName)}.</h2>
    ${report.tagline ? `<p style="margin:15px 0 0;font-size:14px;line-height:23px;color:${MUTED}">${escapeHtml(report.tagline)}</p>` : ''}
    ${report.whatItDoes ? `<p style="margin:12px 0 0;font-size:14px;line-height:23px;color:${MUTED}">${escapeHtml(report.whatItDoes)}</p>` : ''}
    ${bulletLines(overview, { empty: 'The company record is ready for your review.' })}
  </td><td valign="top" width="48%">
    ${browserBar(report.websiteHost || 'company source')}<tr><td style="padding:20px 18px 18px;background:#fbfbf9;border:1px solid ${LINE};border-top:0;border-radius:0 0 8px 8px"><div style="font:700 8px/12px ${MONO};letter-spacing:1.6px;color:#989898">FIRST-PARTY CONTEXT</div><div style="margin-top:11px;font-size:17px;line-height:20px;font-weight:700;color:${INK}">${escapeHtml(report.websiteHost || report.companyName)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px">${sourceCards || '<tr><td style="font-size:12px;color:#777">Company profile saved</td></tr>'}</table></td></tr></table>
  </td></tr></table></td></tr>
  <tr><td style="padding:40px 44px;background:${PAPER};border-top:1px solid ${LINE}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td valign="top" width="46%" style="padding-right:26px">
    ${browserBar('hivemind — company record')}<tr><td style="padding:18px;background:#fff;border:1px solid ${LINE};border-top:0;border-radius:0 0 8px 8px">${profileRows || '<div style="font-size:12px;color:#777">Company record saved</div>'}</td></tr></table>
  </td><td valign="top" width="54%">
    ${sectionLabel('YOUR FIRST WEEK', 3)}
    <h2 style="margin:15px 0 0;font:700 25px/28px Arial,Helvetica,sans-serif;letter-spacing:-.8px;color:${INK}">A company that<br>starts with context.</h2>
    <p style="margin:15px 0 0;font-size:14px;line-height:23px;color:${MUTED}">Your initial work is ready to review, refine, or send into a room. The next useful action is always visible inside Your Company.</p>
    <a href="${escapeHtml(report.reportUrl)}" style="display:inline-block;margin-top:19px;padding:13px 18px;border-radius:5px;background:${BLUE};font:700 11px/14px Arial,Helvetica,sans-serif;letter-spacing:.7px;color:#fff;text-decoration:none">OPEN YOUR COMPANY&nbsp; →</a>
  </td></tr></table></td></tr>
  <tr><td style="padding:40px 44px;background:#fff;border-top:1px solid ${LINE}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td valign="top" width="50%" style="padding-right:24px">
    ${sectionLabel('READY FOR YOUR REVIEW', 4)}
    <h2 style="margin:15px 0 0;font:700 24px/28px Arial,Helvetica,sans-serif;letter-spacing:-.8px;color:${INK}">Make the model<br>more yours.</h2>
    ${bulletLines(report.confirmations, { empty: 'Confirm your company positioning, audience, and priorities. Every correction improves the company model.' })}
  </td><td valign="top" width="50%" style="border-left:1px solid ${LINE};padding-left:24px">
    <div style="font:700 8px/12px ${MONO};letter-spacing:1.4px;color:#989898">THE TEAM THAT IS READY</div>
    <div style="margin-top:12px;font-size:20px;line-height:24px;font-weight:700;color:${INK}">${report.teamCount || 0} people / agents</div>
    ${bulletLines(people, { empty: 'Your company workspace is ready for its first teammate.', mono: true })}
  </td></tr></table></td></tr>
  <tr><td style="padding:24px 44px 28px;background:${PAPER};border-top:1px solid ${LINE}"><div style="font:700 8px/13px ${MONO};letter-spacing:1.4px;color:#989898">DAY-0 REPORT · ${escapeHtml(report.onboardedAt || 'ONBOARDING COMPLETE')} · GENERATED FROM YOUR COMPANY ONBOARDING RECORD</div></td></tr>`;
}

function shell({ report, body, title, print = false }) {
  // The login mark is deliberately inline: it stays sharp in the PDF and
  // avoids tying a durable onboarding record to a mutable public image URL.
  const mark = `<svg width="78" height="47" viewBox="-6 -6 112 112" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Singulance" style="display:block;width:48px;height:48px;overflow:visible"><ellipse cx="50" cy="50" rx="40" ry="13" transform="rotate(-18 50 50)" stroke="#0a0a0a" stroke-width="3.2" fill="none"/><circle cx="88.04" cy="37.64" r="4.4" fill="#0a0a0a"/><path d="M80,50 57.39,53.06 62.73,62.73 53.06,57.39 50,96 46.94,57.39 37.27,62.73 42.61,53.06 20,50 42.61,46.94 37.27,37.27 46.94,42.61 50,4 53.06,42.61 62.73,37.27 57.39,46.94 Z" fill="#22d3ee"/></svg>`;
  const styles = print ? `<style>@page{size:A4;margin:11mm}body{background:#fff!important}.frame{padding:0!important}.shell{box-shadow:none!important;border:0!important}.page-break{page-break-before:always}</style>` : `<style>@media only screen and (max-width:620px){.frame{padding:8px!important}.shell{width:100%!important}.content{padding-left:24px!important;padding-right:24px!important}.title{font-size:30px!important;line-height:33px!important}}</style>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${styles}</head><body style="margin:0;background:#f5f5f2;font-family:Arial,Helvetica,sans-serif;color:${INK}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f2"><tr><td class="frame" align="center" style="padding:32px 12px 42px"><table class="shell" role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:680px;max-width:680px;background:#fff;border:1px solid ${LINE};border-radius:9px;overflow:hidden"><tr><td style="padding:25px 44px 22px;border-bottom:1px solid ${LINE};background:#fff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="54" valign="middle">${mark}</td><td valign="middle" style="padding-left:11px"><div style="font-size:24px;line-height:25px;font-weight:800;letter-spacing:-1px;color:${INK}">SINGULANCE</div><div style="margin-top:6px;font:700 9px/13px ${MONO};letter-spacing:2.7px;color:#9a9a9a">HIVEMIND&nbsp; · &nbsp;MEMORY ENGINE</div></td><td align="right" valign="middle"><div style="font:700 8px/12px ${MONO};letter-spacing:1.7px;color:${BLUE}">DAY-0 / 01</div></td></tr></table></td></tr>${body}<tr><td style="padding:18px 44px;background:#fff;border-top:1px solid ${LINE};font:700 8px/13px ${MONO};letter-spacing:1px;color:#969696">SINGULANCE · YOUR COMPANY, IN MOTION · © ${new Date().getFullYear()} SINGULANCE LABS.</td></tr></table></td></tr></table></body></html>`;
}

export function renderDayZeroOnboardingEmail(input, options = {}) {
  const report = buildDayZeroOnboardingReport(input, options);
  return {
    report,
    subject: `Day-0: ${report.companyName} is now alive`,
    text: `Day-0 onboarding report for ${report.companyName}. We read ${report.sourceCount} source${report.sourceCount === 1 ? '' : 's'}, prepared ${report.taskCount} first moves, and saved ${report.documentCount} company documents. Open your company: ${report.reportUrl}`,
    html: shell({ report, title: `Day-0 - ${report.companyName}`, body: reportBody(report) }),
  };
}

export function renderDayZeroOnboardingReportHtml(input, options = {}) {
  const rendered = renderDayZeroOnboardingEmail(input, options);
  return { report: rendered.report, html: shell({ report: rendered.report, title: `Day-0 report - ${rendered.report.companyName}`, body: reportBody(rendered.report), print: true }) };
}
