import crypto from 'crypto';
import { CARTESIA, escapeHtml, lifecycleEmailShell, lifecycleRichContentStyles, lifecycleSubject, brandLockup } from '../email/templates/cartesia-lifecycle.js';
import { sendRenderedSystemEmail } from '../email/email-service.js';
import { renderDayZeroOnboardingPdf } from '../email/day0-company-report-pdf.js';
import { humationAvatarPublicUrl, humationLaneVisual, renderHumationAvatarSvg, resolveHumationLane } from '../email/humation-avatar.js';

export const DAY_ONE_VERSION = 'day-1-first-move-v2';
const SENDING_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_APP_URL = 'https://next.singulancelabs.com/hivemind/app/employees';
const DELIVERABLE_ROOM_STATUSES = new Set(['complete', 'blocked']);

export function isDayOneWorkflowEnabled() {
  return process.env.HIVEMIND_D1_WORKFLOW_ENABLED === 'true';
}

function requireDayOneWorkflowEnabled() {
  if (!isDayOneWorkflowEnabled()) throw new Error('day1_feature_disabled');
}

function clean(value, limit = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isAuthorizedDayOneRequest(req) {
  const configured = process.env.HIVEMIND_D1_WORKFLOW_SECRET || '';
  const auth = String(req?.headers?.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return safeEqual(token, configured);
}

export function isResearchTask(task) {
  const tags = [task?.room_tag, task?.roomTag, task?.tag, ...(Array.isArray(task?.tags) ? task.tags : [])]
    .map((value) => String(value || '').toLowerCase());
  return tags.some((value) => value === 'research' || value === 'room_research');
}

export function selectDayOneResearchTask(tasks = []) {
  const researchTasks = tasks.filter((task) => isResearchTask(task));
  // New website onboarding explicitly marks the research move intended for
  // Day 1. Do not let an unrelated generic research task steal that slot.
  const dayOneTasks = researchTasks.filter((task) => task?.day1_first_move === true);
  // Prefer a never-started research move, but a company may already have had
  // its Day-0 room dispatch the research task before the durable Day-1 clock
  // reaches it. In that case Day 1 must deliver that room's sealed evidence,
  // not fail or create a second complimentary research run.
  return dayOneTasks.find((task) => task?.status === 'todo')
    || dayOneTasks.find((task) => task?.room_id && ['active', 'done'].includes(String(task?.status || '').toLowerCase()))
    || researchTasks.find((task) => task?.status === 'todo')
    || researchTasks.find((task) => task?.room_id && ['active', 'done'].includes(String(task?.status || '').toLowerCase()))
    || null;
}

export function extractSealedRoomOutput(lines = []) {
  const events = Array.isArray(lines) ? lines : [];
  const finalReport = [...events].reverse().find((event) => event?.t === 'final_report');
  const direct = finalReport?.body || finalReport?.text || finalReport?.report || finalReport?.content;
  if (String(direct || '').trim()) return String(direct).trim();
  const synthesis = [...events].reverse().find((event) => event?.t === 'line'
    && ['lead', 'synthesis', 'final'].includes(String(event?.kind || '').toLowerCase())
    && String(event?.content || event?.text || '').trim());
  if (synthesis) return String(synthesis.content || synthesis.text).trim();
  return '';
}

function inlineMarkdown(value) {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  return text;
}

/** Render the room's README-style markdown without rewriting its content. */
export function renderRoomReadme(markdown = '') {
  const source = String(markdown || '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const html = [];
  let paragraph = [];
  let list = null;
  let code = false;
  let codeLines = [];
  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.type}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const tableCells = (line) => String(line).trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
  // Accept strict GFM dividers and the shorter dividers commonly emitted by
  // LLMs; the header/body shape is still required, so ordinary pipe prose is
  // not promoted into a table.
  const tableDivider = (line) => tableCells(line).every((cell) => /^:?-+:?$/.test(cell));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line)) {
      flushParagraph(); flushList();
      if (code) { html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`); codeLines = []; }
      code = !code;
      continue;
    }
    if (code) { codeLines.push(line); continue; }
    if (line.includes('|') && lines[index + 1]?.includes('|') && tableDivider(lines[index + 1])) {
      flushParagraph(); flushList();
      const headers = tableCells(line);
      const alignments = tableCells(lines[index + 1]).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      html.push(`<div class="table-scroll"><table class="data-table"><thead><tr>${headers.map((cell, cellIndex) => `<th style="text-align:${alignments[cellIndex] || 'left'}">${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td style="text-align:${alignments[cellIndex] || 'left'}">${inlineMarkdown(row[cellIndex] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flushParagraph(); flushList(); html.push('<hr>'); continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList();
      const level = Math.min(4, heading[1].length + 1);
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const type = ordered ? 'ol' : 'ul';
      if (list?.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push((ordered || unordered)[1]);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { flushParagraph(); flushList(); html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    paragraph.push(line);
  }
  if (codeLines.length) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  flushParagraph(); flushList();
  return html.join('\n');
}

function readmeStyles() {
  return `.readme{font:14px/1.65 ${CARTESIA.sans};color:${CARTESIA.ink};overflow-wrap:anywhere;word-break:normal}.readme h2{margin:26px 0 10px;font-size:24px;line-height:1.15;letter-spacing:-.6px}.readme h3{margin:22px 0 8px;font-size:18px}.readme h4{margin:18px 0 6px;font-size:15px}.readme p{margin:0 0 13px}.readme ul,.readme ol{margin:0 0 15px;padding-left:22px}.readme li{margin:5px 0}.readme blockquote{margin:16px 0;padding:10px 16px;border-left:3px solid ${CARTESIA.blue};background:#f5f8ff}.readme code{font-family:${CARTESIA.mono};font-size:.88em;background:#f2f4f7;padding:2px 4px;overflow-wrap:anywhere}.readme pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#09101f;color:#e8f2ff;padding:16px}.readme pre code{background:transparent;padding:0}.readme a{color:${CARTESIA.blue};overflow-wrap:anywhere}.readme hr{margin:22px 0;border:0;border-top:1px solid ${CARTESIA.line}}.data-table tr{break-inside:avoid;page-break-inside:avoid}`;
}

function workflowCharacters(characters = [], { email = false, publicApiUrl = '' } = {}) {
  return (Array.isArray(characters) ? characters : []).slice(0, 6).map((member) => {
    const character = { id: member?.id || member?.slug || member?.name, slug: member?.slug, name: clean(member?.name || 'HyperAgent', 72), role: clean(member?.jobTitle || member?.title || member?.role || member?.roleArchetype || 'Company Specialist', 96) };
    character.roleArchetype = resolveHumationLane(member?.lane || member?.archetype || character.role);
    const visual = humationLaneVisual(character.roleArchetype);
    return { ...character, ...visual, portrait: email ? `<img src="${escapeHtml(humationAvatarPublicUrl(character, publicApiUrl))}" width="54" height="54" alt="${escapeHtml(character.name)}">` : renderHumationAvatarSvg(character, { size: 72 }) };
  });
}

function characterStrip(characters, options = {}) {
  const people = workflowCharacters(characters, options);
  if (!people.length) return '';
  return `<table role="presentation" class="character-strip"><tr>${people.map((person) => `<td class="character"><div class="character-avatar" style="background:${person.background};border-color:${person.color}">${person.portrait}</div><div class="character-name">${escapeHtml(person.name)}</div><div class="character-role" style="color:${person.color}">${escapeHtml(person.role)}</div></td>`).join('')}</tr></table>`;
}

/** Reusable completion renderer for future lifecycle episodes. */
export function renderLifecycleCompletionEmail({ companyName, taskTitle, output, roomUrl, characters = [], dayLabel = 'DAY 1', episodeLabel = 'FIRST MOVE COMPLETE', headline = 'Your HyperAgents<br>worked while you slept.', publicApiUrl = '' }) {
  const body = `<tr><td class="section" style="background:${CARTESIA.paper}"><div class="eyebrow">${escapeHtml(dayLabel)} · ${escapeHtml(episodeLabel)}</div><h1 class="h1">${headline}</h1><p class="copy">The research room completed <strong style="color:${CARTESIA.ink}">${escapeHtml(taskTitle)}</strong> for ${escapeHtml(companyName)}. The report below is the room's sealed output, unchanged.</p>${characterStrip(characters, { email: true, publicApiUrl })}</td></tr><tr><td class="section"><div class="readme rich-content" dir="auto">${renderRoomReadme(output)}</div><a class="action" href="${escapeHtml(roomUrl)}">OPEN THE RESEARCH ROOM →</a></td></tr>`;
  const html = lifecycleEmailShell({
    title: `Day 1 - ${taskTitle}`,
    preheader: `Your HyperAgents completed research for ${companyName}.`,
    body,
  }).replace('</style>', `${readmeStyles()}</style>`);
  return {
    subject: lifecycleSubject(companyName, 1, `Your HyperAgents completed ${taskTitle}`),
    text: `Your HyperAgents worked while you slept.\n\n${taskTitle}\n\n${output}\n\nOpen the research room: ${roomUrl}`,
    html,
  };
}

export function renderDayOneEmail(input) { return renderLifecycleCompletionEmail(input); }

/** Day 2 keeps the Day-1 shell and Humation header, then uses the same compact
 * editorial system as the protected Brand-DNA report. Email clients cannot
 * safely carry a full screenshot mosaic, so the complete visual report stays
 * in its PDF attachment and room artifact. */
export function renderDayTwoBrandDnaEmail({ companyName, output, roomUrl, characters = [], publicApiUrl = '', artifact = {} } = {}) {
  const analysis = artifact?.analysis || {};
  const palette = analysis.palette || {};
  const typography = analysis.typography || {};
  const voice = analysis.voice || {};
  const imagery = analysis.imagery || {};
  const brief = artifact?.visual_generation_brief || {};
  const evidence = Array.isArray(artifact?.evidence) ? artifact.evidence.slice(0, 6) : [];
  const colors = [palette.primary, palette.secondary, palette.accent, palette.background, ...(Array.isArray(palette.accents) ? palette.accents : [])]
    .filter((value) => typeof value === 'string' && value).slice(0, 6);
  const swatches = colors.map((color) => `<td style="width:16.66%;padding:0 3px 0 0"><div style="height:34px;background:${escapeHtml(color)};border:1px solid #deddd8"></div><div style="font:700 8px/12px Arial,sans-serif;color:#64635f;margin-top:4px">${escapeHtml(color)}</div></td>`).join('');
  const evidenceRows = evidence.map((item, index) => `<tr><td style="width:26px;padding:7px 0;color:${CARTESIA.blue};font:700 9px/13px monospace">${String(index + 1).padStart(2, '0')}</td><td style="padding:7px 0;border-top:1px solid #deddd8"><strong style="font:700 12px/16px Arial,sans-serif">${escapeHtml(item?.page?.title || item?.page_url || 'Captured page')}</strong><br><span style="font:10px/14px Arial,sans-serif;color:#64635f">${escapeHtml(item?.page_url || item?.page?.url || '')}</span></td></tr>`).join('');
  const card = (title, content) => `<td class="lifecycle-card" style="width:50%;vertical-align:top;border:1px solid #deddd8;padding:16px;background:#fff"><div style="font:700 8px/12px monospace;letter-spacing:1px;color:${CARTESIA.blue};text-transform:uppercase">${escapeHtml(title)}</div>${content}</td>`;
  const visualSystem = `<table role="presentation" class="lifecycle-card-row" width="100%" cellspacing="0" cellpadding="0" style="margin-top:18px"><tr>${card('Color palette', `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:10px"><tr>${swatches || '<td style="font:12px Arial,sans-serif;color:#64635f">No reliable palette was inferred.</td>'}</tr></table>`)}<td class="lifecycle-card-gap" style="width:12px"></td>${card('Typography & interface', `<p style="margin:10px 0 0;font:12px/18px Arial,sans-serif"><strong>Heading</strong> ${escapeHtml(typography.headings || 'Captured public-site hierarchy')}<br><strong>Body</strong> ${escapeHtml(typography.body || 'Sans-serif interface')}<br><strong>Voice</strong> ${escapeHtml(voice.tone || 'Evidence-led')}</p>`)}</tr></table><table role="presentation" class="lifecycle-card-row" width="100%" cellspacing="0" cellpadding="0" style="margin-top:12px"><tr>${card('Photography & composition', `<p style="margin:10px 0 0;font:12px/18px Arial,sans-serif">${escapeHtml(imagery.style || 'Use the retained report screenshots as the creative reference.')}</p>`)}<td class="lifecycle-card-gap" style="width:12px"></td>${card('Brand voice', `<p style="margin:10px 0 0;font:12px/18px Arial,sans-serif">${escapeHtml(voice.style || 'Apply only the style demonstrated on captured first-party pages.')}</p>`)}</tr></table>`;
  const briefItems = Array.isArray(brief.elements) ? brief.elements.slice(0, 5).map((item) => `<li style="margin:4px 0">${escapeHtml(typeof item === 'string' ? item : item?.content || '')}</li>`).join('') : '';
  const body = `<tr><td class="section" style="background:${CARTESIA.paper}"><div class="eyebrow">DAY 2 · YOUR AGENTS LEARNED YOUR BRAND</div><h1 class="h1">Your HyperAgents<br>mapped your visual language.</h1><p class="copy">Your source-backed Brand DNA is ready for ${escapeHtml(companyName)}.</p>${characterStrip(characters, { email: true, publicApiUrl })}${visualSystem}<div style="margin-top:18px;background:#101010;color:#fff;padding:18px"><div style="font:700 8px/12px monospace;letter-spacing:1px;color:#83b6ed;text-transform:uppercase">Reusable visual-artifact brief</div><div style="font:700 18px/23px Arial,sans-serif;margin-top:8px">${escapeHtml(brief.style || 'Evidence-first creative direction assembled from rendered first-party pages.')}</div>${briefItems ? `<ul style="margin:10px 0 0;padding-left:18px;font:12px/18px Arial,sans-serif;color:#e7e7e7">${briefItems}</ul>` : ''}</div><div style="margin-top:20px;font:700 8px/12px monospace;letter-spacing:1px;color:${CARTESIA.blue};text-transform:uppercase">Evidence ledger</div><h2 style="margin:6px 0 8px;font:700 20px/25px Arial,sans-serif">What the agents captured</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${evidenceRows || `<tr><td style="font:12px Arial,sans-serif">${escapeHtml(output)}</td></tr>`}</table><a class="action" href="${escapeHtml(roomUrl)}">OPEN THE FULL BRAND DNA REPORT →</a></td></tr>`;
  const html = lifecycleEmailShell({ title: 'Day 2 - Your Company Brand DNA', preheader: `Your HyperAgents mapped ${companyName}'s visual language.`, body }).replace('</style>', `${readmeStyles()}</style>`);
  return { subject: lifecycleSubject(companyName, 2, 'Your Brand DNA is ready'), text: `Your Brand DNA is ready.\n\n${output}\n\nOpen the full report: ${roomUrl}`, html };
}

/** Reusable portrait-report renderer paired with the lifecycle email renderer. */
export function renderLifecycleCompletionPortraitReport({ companyName, taskTitle, output, roomUrl, completedAt, characters = [], dayLabel = 'DAY-1 / RESEARCH' }) {
  const readme = renderRoomReadme(output);
  const people = characterStrip(characters, { email: false });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(taskTitle)}</title><style>
  @page{size:A4 portrait;margin:0}*{box-sizing:border-box}body{margin:0;background:${CARTESIA.paper};color:${CARTESIA.ink};font-family:Arial,"Noto Sans","Segoe UI Symbol",sans-serif;overflow-wrap:anywhere}.page{padding:12mm 15mm 14mm;background:linear-gradient(180deg,#f4f8ff 0,#fff 30mm,#fff 100%)}.head{display:flex;align-items:center;justify-content:space-between;padding-bottom:5mm;border-bottom:1px solid ${CARTESIA.line}}.brand-lockup{display:flex;align-items:center;gap:3mm}.brand-lockup svg{width:10mm;height:10mm}.brand-word{font-size:18px;font-weight:800;letter-spacing:-.6px}.brand-sub{margin-top:2px;font:700 6px/9px ${CARTESIA.mono};letter-spacing:1.3px;color:#999}.brand-sub span{color:${CARTESIA.blue}}.folio{font:700 7px/10px ${CARTESIA.mono};letter-spacing:1.5px;color:${CARTESIA.blue}}.intro{padding:8mm 0 6mm;border-bottom:1px solid ${CARTESIA.line}}.eyebrow{font:700 7px/11px ${CARTESIA.mono};letter-spacing:1.8px;color:${CARTESIA.blue}}h1{margin:3mm 0 0;max-width:165mm;font-size:30px;line-height:1.04;letter-spacing:-1.2px}.meta{margin-top:3mm;color:${CARTESIA.body};font-size:10px;line-height:15px}.character-strip{width:100%;table-layout:fixed;margin-top:4mm}.character{text-align:center;vertical-align:top;padding:0 1.5mm}.character-avatar{width:12mm;height:12mm;margin:0 auto 1mm;border-radius:50%;overflow:hidden;background:#fff4f8;border:1px solid #f6c5dc}.character-avatar svg{display:block;width:100%;height:100%}.character-name{font-size:7px;line-height:9px;font-weight:800}.character-role{margin-top:1px;font-size:5px;line-height:7px;color:${CARTESIA.muted}}.report{padding-top:6mm}${readmeStyles()}${lifecycleRichContentStyles()}.foot{margin-top:8mm;padding-top:3mm;border-top:1px solid ${CARTESIA.line};display:flex;justify-content:space-between;font:700 6px/9px ${CARTESIA.mono};letter-spacing:1.1px;color:#999;break-inside:avoid;page-break-inside:avoid}.foot a{color:${CARTESIA.blue};text-decoration:none}
  </style></head><body><main class="page"><header class="head">${brandLockup({ compact: true })}<div class="folio">${escapeHtml(dayLabel)}</div></header><section class="intro"><div class="eyebrow">HIVEMIND · FIRST MOVE COMPLETE</div><h1>${escapeHtml(taskTitle)}</h1><div class="meta">Prepared for <strong>${escapeHtml(companyName)}</strong>${completedAt ? ` · ${escapeHtml(new Date(completedAt).toISOString().slice(0, 10))}` : ''}<br>The report below is the room's sealed output, unchanged.</div>${people}</section><article class="report readme" dir="auto">${readme}</article><footer class="foot"><span>SINGULANCE · YOUR COMPANY, IN MOTION</span><a href="${escapeHtml(roomUrl)}">OPEN RESEARCH ROOM →</a></footer></main></body></html>`;
}

export function renderDayOnePortraitReport(input) { return renderLifecycleCompletionPortraitReport(input); }
export function renderDayTwoBrandDnaPortraitReport({ companyName, output, roomUrl, completedAt, characters = [] } = {}) {
  return renderLifecycleCompletionPortraitReport({ companyName, taskTitle: 'Your Company Brand DNA', output, roomUrl, completedAt, characters, dayLabel: 'DAY-2 / BRAND DNA' });
}

function dayTwoBrandDnaSummary(artifact = {}) {
  const analysis = artifact?.analysis || {};
  const identity = analysis.identity || {};
  const voice = analysis.voice || {};
  const palette = analysis.palette || {};
  const intelligence = analysis.company_intelligence || {};
  const lines = [
    `# ${clean(identity.name || 'Your company', 140)} — Brand DNA`,
    identity.tagline ? `\n${clean(identity.tagline, 360)}` : '',
    '\n## What your agents captured',
    voice.tone ? `- **Voice:** ${clean(voice.tone, 360)}` : '',
    voice.style ? `- **Expression:** ${clean(voice.style, 500)}` : '',
    Object.values(palette).filter((value) => typeof value === 'string').slice(0, 5).length ? `- **Captured palette:** ${Object.values(palette).filter((value) => typeof value === 'string').slice(0, 5).map((value) => clean(value, 80)).join(', ')}` : '',
    Array.isArray(intelligence.offers) && intelligence.offers.length ? `\n## Public offer signals\n${intelligence.offers.slice(0, 5).map((value) => `- ${clean(typeof value === 'string' ? value : value?.name || value?.description, 300)}`).join('\n')}` : '',
    Array.isArray(intelligence.audiences) && intelligence.audiences.length ? `\n## Audiences\n${intelligence.audiences.slice(0, 5).map((value) => `- ${clean(typeof value === 'string' ? value : value?.name || value?.description, 300)}`).join('\n')}` : '',
    intelligence.pricing_status ? `\n## Pricing\n${intelligence.pricing_status === 'not_publicly_listed_in_captured_pages' ? 'No public price was found in the captured first-party pages.' : clean((intelligence.public_prices || []).join(', '), 600)}` : '',
    '\n## Evidence rule\nThis report is based on retained, first-party rendered-page evidence. Revalidate time-sensitive commercial claims before use.',
  ].filter(Boolean);
  return lines.join('\n');
}

/** Deliver a completed Day-2 report using the proven Day-1 transactional
 * email + workspace-notification path. The room JSON claim is the idempotency
 * fence, so Workflow retries cannot create duplicate email deliveries. */
export async function deliverDayTwoBrandDna({ prisma, runId, renderPdf = renderDayZeroOnboardingPdf, sendEmail = sendRenderedSystemEmail } = {}) {
  if (!prisma || !runId) throw new Error('day2_delivery_input_invalid');
  const run = await prisma.visualIntelligenceRun.findUnique({ where: { id: runId } });
  if (!run?.roomId || run.status !== 'completed' || !run.artifact?.rendered_report?.r2_key) throw new Error('day2_delivery_not_ready');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, user_id, "agent_connectors"->'_company' AS company FROM "hivemind"."hyper_rooms" WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid AND "agent_connectors" ? '_company' LIMIT 1`,
    run.roomId, run.orgId, run.userId,
  );
  const row = rows?.[0];
  const company = typeof row?.company === 'string' ? JSON.parse(row.company) : row?.company;
  if (!company) throw new Error('day2_delivery_company_missing');
  const state = company.day2_brand_dna || {};
  if (state.status === 'sent') return { ok: true, accepted: false, status: 'sent', message_id: state.message_id || null };
  if (state.job_id && state.job_id !== run.jobId) throw new Error('day2_delivery_job_mismatch');
  const claim = { ...state, status: 'sending', job_id: run.jobId, run_id: run.id, delivery_claimed_at: new Date().toISOString() };
  const changed = await prisma.$executeRawUnsafe(
    `UPDATE "hivemind"."hyper_rooms" SET "agent_connectors"=jsonb_set("agent_connectors", '{_company,day2_brand_dna}', $1::jsonb, true) WHERE id=$2::uuid AND org_id=$3::uuid AND user_id=$4::uuid AND COALESCE("agent_connectors" #>> '{_company,day2_brand_dna,status}', '') NOT IN ('sending','sent')`,
    JSON.stringify(claim), row.id, run.orgId, run.userId,
  );
  if (!changed) throw new Error('day2_delivery_in_progress');
  try {
    const owner = await prisma.user.findUnique({ where: { id: run.userId }, select: { email: true } });
    if (!owner?.email) throw new Error('day2_recipient_missing');
    const companyName = clean(company.company || company.profile?.company_name || 'Your company', 110);
    const appBase = String(process.env.HIVEMIND_APP_URL || DEFAULT_APP_URL.replace(/\/employees$/, '')).replace(/\/$/, '');
    const roomUrl = `${appBase}/employees/rooms/${run.roomId}`;
    const characters = Array.isArray(company.team) ? company.team : [];
    const output = dayTwoBrandDnaSummary(run.artifact);
    const rendered = renderDayTwoBrandDnaEmail({ companyName, output, roomUrl, characters, artifact: run.artifact });
    const legacyPortrait = renderDayTwoBrandDnaPortraitReport({ companyName, output, roomUrl, completedAt: run.finishedAt || new Date(), characters });
    const artifactBase = String(process.env.HIVEMIND_VISUAL_ARTIFACT_URL || '').replace(/\/$/, '');
    const artifactSecret = String(process.env.HIVEMIND_VISUAL_WORKFLOW_SECRET || '');
    const reportKey = String(run.artifact?.rendered_report?.r2_key || '');
    let portrait = legacyPortrait;
    if (artifactBase && artifactSecret && reportKey.startsWith(`org/${run.orgId}/runs/${run.id}/reports/`)) {
      try {
        const response = await fetch(`${artifactBase}/artifact?key=${encodeURIComponent(reportKey)}`, { headers: { authorization: `Bearer ${artifactSecret}` } });
        const length = Number(response.headers.get('content-length') || 0);
        if (response.ok && (!length || length <= 2_000_000)) {
          const candidate = await response.text();
          if (candidate.includes('Day 2') && candidate.includes('Evidence ledger')) portrait = candidate;
        }
      } catch { /* retain the proven lifecycle portrait if artifact delivery is temporarily unavailable */ }
    }
    const pdf = await renderPdf(portrait);
    const slug = companyName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'company';
    const delivery = await sendEmail({
      templateId: 'day2_brand_dna', to: owner.email, rendered,
      attachments: [{ filename: `${slug}-day-2-brand-dna.pdf`, type: 'application/pdf', content: pdf }],
      notification: { orgId: run.orgId, userId: run.userId, type: 'lifecycle.email.sent', title: `${companyName} Day 2 Brand DNA is in your inbox`, body: 'Your reusable visual brief and evidence report are ready.', resourceType: 'visual_intelligence_run', resourceId: run.id, href: roomUrl, data: { lifecycle_day: 2, company: companyName, artifact_type: 'brand_dna' } },
    });
    if (!delivery.ok) throw new Error(`day2_delivery_${delivery.error || delivery.reason || 'failed'}`);
    const sent = { ...claim, status: 'sent', sent_at: new Date().toISOString(), provider: delivery.provider, delivery_status: delivery.deliveryStatus || 'accepted', message_id: delivery.messageId || null };
    await prisma.$executeRawUnsafe(`UPDATE "hivemind"."hyper_rooms" SET "agent_connectors"=jsonb_set("agent_connectors", '{_company,day2_brand_dna}', $1::jsonb, true) WHERE id=$2::uuid AND org_id=$3::uuid`, JSON.stringify(sent), row.id, run.orgId);
    return { ok: true, accepted: true, status: 'sent', message_id: delivery.messageId || null };
  } catch (error) {
    const failed = { ...claim, status: 'failed', failed_at: new Date().toISOString(), failure_reason: clean(error?.message || 'delivery_failed', 240) };
    await prisma.$executeRawUnsafe(`UPDATE "hivemind"."hyper_rooms" SET "agent_connectors"=jsonb_set("agent_connectors", '{_company,day2_brand_dna}', $1::jsonb, true) WHERE id=$2::uuid AND org_id=$3::uuid`, JSON.stringify(failed), row.id, run.orgId).catch(() => {});
    throw error;
  }
}

function workflowUrl(pathname = '') {
  const base = String(process.env.HIVEMIND_D1_WORKFLOW_URL || '').replace(/\/$/, '');
  return base ? `${base}${pathname}` : '';
}

async function workflowFetch(pathname, body, { fetchImpl = globalThis.fetch, attempts = 3 } = {}) {
  const url = workflowUrl(pathname);
  const secret = process.env.HIVEMIND_D1_WORKFLOW_SECRET || '';
  if (!url || !secret) return { ok: false, skipped: true, reason: 'workflow_not_configured' };
  let error = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) return { ok: true, ...payload };
      error = new Error(`workflow_http_${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (caught) { error = caught; }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return { ok: false, reason: error?.message || 'workflow_request_failed' };
}

export async function scheduleDayOneWorkflow({ orgId, hqRoomId, onboardedAt, fetchImpl } = {}) {
  if (!isDayOneWorkflowEnabled()) return { ok: false, skipped: true, reason: 'feature_disabled' };
  const onboarded = Date.parse(onboardedAt || '');
  const targetAt = new Date(Math.max(Date.now(), Number.isFinite(onboarded) ? onboarded + 24 * 60 * 60 * 1000 : Date.now() + 24 * 60 * 60 * 1000)).toISOString();
  return { target_at: targetAt, ...await workflowFetch('/start', { org_id: orgId, hq_room_id: hqRoomId, target_at: targetAt }, { fetchImpl }) };
}

/** Reconciliation source for Cloudflare's cron trigger; no report body leaves Postgres. */
export async function listEligibleDayOneCompanies({ prisma, limit = 500 } = {}) {
  requireDayOneWorkflowEnabled();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, org_id, "agent_connectors"->'_company' AS company
       FROM "hivemind"."hyper_rooms"
      WHERE "agent_connectors" ? '_company' AND archived_at IS NULL
        AND "agent_connectors" #>> '{_company,day0_report_email,status}' = 'sent'
        AND COALESCE("agent_connectors" #>> '{_company,day1_first_move,status}', '') NOT IN ('running','completed','sending','sent')
      ORDER BY created_at ASC LIMIT $1`,
    Math.max(1, Math.min(500, Number(limit) || 500)),
  ).catch(() => []);
  return (rows || []).map((row) => {
    const company = typeof row.company === 'string' ? JSON.parse(row.company) : row.company;
    const onboarded = Date.parse(company?.onboarded_at || '');
    return {
      org_id: String(row.org_id),
      hq_room_id: String(row.id),
      target_at: new Date(Number.isFinite(onboarded) ? onboarded + 24 * 60 * 60 * 1000 : Date.now()).toISOString(),
    };
  });
}

export async function notifyDayOneWorkflowCompletion({ prisma, turnId, status = 'complete', fetchImpl } = {}) {
  if (!isDayOneWorkflowEnabled()) return { ok: false, skipped: true, reason: 'feature_disabled' };
  const rows = await prisma.$queryRawUnsafe(
    `SELECT hq.id, hq.org_id, hq."agent_connectors"->'_company' AS company
       FROM "hivemind"."hyper_rooms" hq
      WHERE hq."agent_connectors" #>> '{_company,day1_first_move,turn_id}' = $1
      ORDER BY hq.created_at DESC LIMIT 1`,
    turnId,
  ).catch(() => []);
  const row = rows?.[0];
  if (!row?.company) return { ok: false, skipped: true, reason: 'not_day1_turn' };
  const company = typeof row.company === 'string' ? JSON.parse(row.company) : row.company;
  const state = company.day1_first_move || {};
  if (!state.workflow_instance_id) return { ok: false, skipped: true, reason: 'workflow_instance_missing' };
  const deliverable = DELIVERABLE_ROOM_STATUSES.has(status);
  state.status = deliverable ? 'completed' : 'failed';
  state.room_status = status;
  state.completed_at = new Date().toISOString();
  if (!deliverable) state.failure_reason = 'room_turn_failed';
  else delete state.failure_reason;
  await prisma.$executeRawUnsafe(
    `UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = jsonb_set("agent_connectors", '{_company,day1_first_move}', $1::jsonb, true) WHERE id = $2::uuid`,
    JSON.stringify(state), row.id,
  );
  const event = await workflowFetch('/event', { instance_id: state.workflow_instance_id, org_id: String(row.org_id), turn_id: turnId, status }, { fetchImpl, attempts: 5 });
  if (event.ok) return event;
  // A Cloudflare Workflow instance can be delayed or be recovering after an
  // edge failure exactly when the Room emits its only completion event. Put an
  // identifier-only admission back through the durable lifecycle Queue. The
  // queue-side handler re-reads this receipt and delivers idempotently.
  const recovery = await workflowFetch('/start', {
    org_id: String(row.org_id),
    hq_room_id: String(row.id),
    target_at: new Date().toISOString(),
  }, { fetchImpl, attempts: 5 });
  return { ...recovery, recovered_from_event_failure: true, event_reason: event.reason || null };
}

export async function prepareDayOneFirstMove({ prisma, orgId, hqRoomId, workflowInstanceId, dispatchTurn } = {}) {
  requireDayOneWorkflowEnabled();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, user_id, "agent_connectors"->'_company' AS company FROM "hivemind"."hyper_rooms"
      WHERE id = $1::uuid AND org_id = $2::uuid AND "agent_connectors" ? '_company' AND archived_at IS NULL LIMIT 1`,
    hqRoomId, orgId,
  );
  const hq = rows?.[0];
  if (!hq?.company) throw new Error('day1_company_not_found');
  const company = typeof hq.company === 'string' ? JSON.parse(hq.company) : hq.company;
  const prior = company.day1_first_move || {};
  if (prior.status === 'sent') return { status: 'sent', turn_id: prior.turn_id, room_id: prior.room_id };
  const recoveringFailedLifecycle = prior.status === 'failed';
  if (prior.workflow_instance_id && prior.workflow_instance_id !== workflowInstanceId && !recoveringFailedLifecycle) {
    throw new Error('day1_workflow_conflict');
  }
  let task = (company.tasks || []).find((item) => item.id === prior.task_id) || selectDayOneResearchTask(company.tasks || []);
  if (!task) throw new Error('day1_research_task_not_found');

  const preparing = { ...prior, version: DAY_ONE_VERSION, status: 'preparing', workflow_instance_id: workflowInstanceId, task_id: task.id, claimed_at: prior.claimed_at || new Date().toISOString(), complimentary: true };
  company.day1_first_move = preparing;
  await prisma.$executeRawUnsafe(
    `UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = jsonb_set("agent_connectors", '{_company}', $1::jsonb, true) WHERE id = $2::uuid AND org_id = $3::uuid`,
    JSON.stringify(company), hq.id, orgId,
  );

  let room = prior.room_id
    ? await prisma.hyperRoom.findFirst({ where: { id: prior.room_id, orgId, archivedAt: null } }).catch(() => null)
    : task.room_id
      ? await prisma.hyperRoom.findFirst({ where: { id: task.room_id, orgId, archivedAt: null } }).catch(() => null)
      : null;
  if (!room) {
    const participantIds = (company.team || []).map((member) => member.id).filter(Boolean).slice(0, 5);
    room = await prisma.hyperRoom.create({ data: {
      userId: hq.user_id, orgId, name: clean(task.title, 120), participantIds, template: 'auto',
      roomMode: 'work', roomTag: 'research', permanentLeadId: participantIds.slice().sort()[0] || null,
    } });
    const companyLocation = clean(company.company_location || company.profile?.location || company.location || '', 240);
    const locationContext = companyLocation
      ? `\nCompany HQ / operating location: ${companyLocation}. Use this as the geographic anchor for market, competitor, regulatory, and buyer research.`
      : '';
    const goal = `${task.title}\n${task.detail || ''}\nCompany: ${company.company || 'Company'} — ${company.mission || ''}${locationContext}`.slice(0, 2000);
    await prisma.$executeRawUnsafe('UPDATE "hivemind"."hyper_rooms" SET goal = $1 WHERE id = $2::uuid', goal, room.id).catch(() => {});
  }
  const companyLocation = clean(company.company_location || company.profile?.location || company.location || '', 240);
  const locationContext = companyLocation
    ? `\n\nCompany HQ / operating location: ${companyLocation}. Use it as the required geographic anchor; do not substitute a different market without evidence.`
    : '';
  const kickoff = `${task.detail ? `${task.title}\n\n${task.detail}` : task.title}${locationContext}`;
  const idempotencyKey = `day1-${hq.id}-${task.id}`.slice(0, 64);
  // Reuse the real task turn when Day-0/first-life dispatch already started
  // this research work. Its exact sealed output is the Day-1 deliverable.
  let turn = prior.turn_id
    ? await prisma.hyperTurn.findFirst({ where: { id: prior.turn_id, roomId: room.id } }).catch(() => null)
    : await prisma.hyperTurn.findFirst({ where: { roomId: room.id }, orderBy: { seq: 'desc' } }).catch(() => null);
  if (!turn) turn = await prisma.hyperTurn.findUnique({ where: { idempotencyKey } }).catch(() => null);
  let created = false;
  if (!turn) {
    const last = await prisma.hyperTurn.findFirst({ where: { roomId: room.id }, orderBy: { seq: 'desc' }, select: { seq: true } });
    turn = await prisma.hyperTurn.create({ data: { roomId: room.id, seq: (last?.seq ?? 0) + 1, userMessage: kickoff, status: 'live', idempotencyKey, lines: [] } });
    created = true;
  }
  task.room_id = room.id;
  const turnDeliverable = Boolean(turn.sealedAt) && DELIVERABLE_ROOM_STATUSES.has(turn.status);
  task.status = turnDeliverable ? 'done' : 'active';
  company.day1_first_move = { ...preparing, status: turnDeliverable ? 'completed' : 'running', room_id: room.id, turn_id: turn.id, started_at: prior.started_at || new Date().toISOString() };
  await prisma.$executeRawUnsafe(
    `UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = jsonb_set("agent_connectors", '{_company}', $1::jsonb, true) WHERE id = $2::uuid AND org_id = $3::uuid`,
    JSON.stringify(company), hq.id, orgId,
  );
  if (created) {
    const roomRow = await prisma.hyperRoom.findUnique({ where: { id: room.id }, select: { participantIds: true, goal: true, projectId: true } });
    void dispatchTurn({ room_id: room.id, turn_id: turn.id, user_id: hq.user_id, org_id: orgId, user_message: kickoff, participant_ids: roomRow?.participantIds || [], project_id: roomRow?.projectId || null, room_goal: roomRow?.goal || '', room_mode: 'work', task_tag: 'WORK', callback_url: `${process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000'}/internal/hyper/turn-event` })
      .catch((error) => console.warn('[day1] research room dispatch failed:', error.message));
  }
  return { status: company.day1_first_move.status, task_id: task.id, task_title: task.title, room_id: room.id, turn_id: turn.id };
}

export async function deliverDayOneFirstMove({
  prisma,
  orgId,
  hqRoomId,
  renderPdf = renderDayZeroOnboardingPdf,
  sendEmail = sendRenderedSystemEmail,
} = {}) {
  requireDayOneWorkflowEnabled();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, user_id, "agent_connectors"->'_company' AS company FROM "hivemind"."hyper_rooms"
      WHERE id = $1::uuid AND org_id = $2::uuid AND "agent_connectors" ? '_company' LIMIT 1`,
    hqRoomId, orgId,
  );
  const hq = rows?.[0];
  const company = typeof hq?.company === 'string' ? JSON.parse(hq.company) : hq?.company;
  const state = company?.day1_first_move || {};
  if (state.status === 'sent') return {
    ok: true, accepted: false, status: 'sent', message_id: state.message_id || null,
    output_sha256: state.output_sha256 || null, output_length: state.output_length || null,
  };
  if (!state.turn_id || !state.room_id) throw new Error('day1_turn_not_ready');
  const turn = await prisma.hyperTurn.findFirst({ where: { id: state.turn_id, roomId: state.room_id } });
  if (!turn?.sealedAt || !DELIVERABLE_ROOM_STATUSES.has(turn.status)) throw new Error('day1_turn_not_complete');
  const output = extractSealedRoomOutput(turn.lines);
  if (!output) throw new Error('day1_sealed_output_missing');
  const outputSha256 = crypto.createHash('sha256').update(output, 'utf8').digest('hex');
  const outputLength = Buffer.byteLength(output, 'utf8');
  const claimedAt = new Date().toISOString();
  const sendingState = { ...state, status: 'sending', delivery_claimed_at: claimedAt };
  const claimed = await prisma.$queryRawUnsafe(
    `UPDATE "hivemind"."hyper_rooms"
        SET "agent_connectors" = jsonb_set("agent_connectors", '{_company,day1_first_move}', $1::jsonb, true)
      WHERE id = $2::uuid
        AND (
          COALESCE("agent_connectors" #>> '{_company,day1_first_move,status}', '') NOT IN ('sending', 'sent')
          OR (
            "agent_connectors" #>> '{_company,day1_first_move,status}' = 'sending'
            AND COALESCE(("agent_connectors" #>> '{_company,day1_first_move,delivery_claimed_at}')::timestamptz, to_timestamp(0)) < now() - ($3::bigint * interval '1 millisecond')
          )
        )
    RETURNING id`,
    JSON.stringify(sendingState), hq.id, SENDING_LEASE_MS,
  );
  if (!claimed?.length) throw new Error('day1_delivery_in_progress');
  Object.assign(state, sendingState);
  try {
    const owner = await prisma.user.findUnique({ where: { id: hq.user_id }, select: { email: true } });
    if (!owner?.email) throw new Error('day1_recipient_missing');
    const task = (company.tasks || []).find((item) => item.id === state.task_id) || {};
    const companyName = clean(company.company || company.profile?.company_name || 'Your company', 110);
    const taskTitle = clean(task.title || 'Your first research move', 160);
    const appBase = String(process.env.HIVEMIND_APP_URL || DEFAULT_APP_URL.replace(/\/employees$/, '')).replace(/\/$/, '');
    const roomUrl = `${appBase}/employees/rooms/${state.room_id}`;
    const characters = Array.isArray(company.team) ? company.team : [];
    const rendered = renderDayOneEmail({ companyName, taskTitle, output, roomUrl, characters });
    const reportHtml = renderDayOnePortraitReport({ companyName, taskTitle, output, roomUrl, completedAt: turn.sealedAt, characters });
    const pdf = await renderPdf(reportHtml);
    const slug = companyName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'company';
    const delivery = await sendEmail({
      templateId: 'day1_first_move', to: owner.email, rendered,
      attachments: [{ filename: `${slug}-day-1-research-report.pdf`, type: 'application/pdf', content: pdf }],
      notification: {
        orgId,
        userId: hq.user_id,
        type: 'lifecycle.email.sent',
        title: `${companyName} Day 1 research is in your inbox`,
        body: `${taskTitle} is complete and its sealed report is ready.`,
        resourceType: 'hyper_room',
        resourceId: state.room_id,
        href: roomUrl,
        data: { lifecycle_day: 1, company: companyName, task_title: taskTitle },
      },
    });
    if (!delivery.ok) throw new Error(`day1_delivery_${delivery.error || delivery.reason || 'failed'}`);
    Object.assign(state, { status: 'sent', sent_at: new Date().toISOString(), provider: delivery.provider, delivery_status: delivery.deliveryStatus || 'accepted', message_id: delivery.messageId || null, output_sha256: outputSha256, output_length: outputLength });
    await prisma.$executeRawUnsafe(
      `UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = jsonb_set("agent_connectors", '{_company,day1_first_move}', $1::jsonb, true) WHERE id = $2::uuid`,
      JSON.stringify(state), hq.id,
    );
    return { ok: true, accepted: true, status: 'sent', provider: delivery.provider, message_id: delivery.messageId || null, room_id: state.room_id, turn_id: state.turn_id, output_sha256: outputSha256, output_length: outputLength };
  } catch (error) {
    Object.assign(state, { status: 'failed', failed_at: new Date().toISOString(), failure_reason: String(error.message || 'delivery_failed').slice(0, 240) });
    await prisma.$executeRawUnsafe(
      `UPDATE "hivemind"."hyper_rooms" SET "agent_connectors" = jsonb_set("agent_connectors", '{_company,day1_first_move}', $1::jsonb, true) WHERE id = $2::uuid`,
      JSON.stringify(state), hq.id,
    ).catch(() => {});
    throw error;
  }
}
