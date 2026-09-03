import crypto from 'node:crypto';
import { PlaywrightServiceRuntime } from '../web/playwright-service-runtime.js';
import { gatewayFirstFetch } from '../llm/cloudflare-gateway.js';
import { createWorkspaceNotification } from '../workspace/notifications.js';

export const VISUAL_PIPELINE_VERSION = 1;
export const VISUAL_STAGES = Object.freeze(['admit', 'discover', 'capture', 'store', 'extract', 'verify', 'publish', 'render', 'notify']);
const PROGRESS = Object.freeze(Object.fromEntries(VISUAL_STAGES.map((stage, index) => [stage, Math.round((index / (VISUAL_STAGES.length - 1)) * 100)])));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function safeUrl(value) { try { const url = new URL(String(value)); return url.protocol === 'https:' ? url.href : null; } catch { return null; } }
function clean(value, limit = 3000) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
function compactPage(page) {
  return {
    url: safeUrl(page?.url), title: clean(page?.title, 300), description: clean(page?.description, 800),
    text: clean(page?.text || page?.markdown, 18_000), seo: page?.seo && typeof page.seo === 'object' ? page.seo : {},
    visual: page?.visual && typeof page.visual === 'object' ? page.visual : {},
    captured_at: new Date().toISOString(), brand_logo: screenshotData(page?.brand_logo),
  };
}
function screenshotData(value) {
  const raw = String(value || '');
  if (!raw) return null;
  return raw.startsWith('data:') ? raw : `data:image/jpeg;base64,${raw}`;
}
export function validateVisualAdmission(input) {
  if (!UUID.test(String(input?.org_id || '')) || !UUID.test(String(input?.user_id || '')) || !UUID.test(String(input?.job_id || ''))) throw Object.assign(new Error('invalid_visual_identity'), { retryable: false });
  if (!['public', 'user_takeover'].includes(input?.mode)) throw Object.assign(new Error('invalid_visual_mode'), { retryable: false });
  if (input?.mode === 'user_takeover' && !/^[A-Za-z0-9_-]{1,40}$/.test(String(input?.browser_session || ''))) throw Object.assign(new Error('visual_browser_session_required'), { retryable: false });
  if (!['brand_dna_v1', 'visual_artifact_brief_v1', 'ui_audit_v1'].includes(input?.deliverable)) throw Object.assign(new Error('invalid_visual_deliverable'), { retryable: false });
  if (!Array.isArray(input?.urls) || !input.urls.length || input.urls.length > 12 || input.urls.some((url) => !safeUrl(url))) throw Object.assign(new Error('invalid_visual_urls'), { retryable: false });
  if (!Number.isInteger(input?.processing_version) || input.processing_version < 1) throw Object.assign(new Error('invalid_visual_processing_version'), { retryable: false });
}
function parserJson(value) { try { return typeof value === 'object' ? value : JSON.parse(String(value).replace(/^```json\s*/i, '').replace(/\s*```$/i, '')); } catch { return null; } }
export function normalizeBrandDnaExtraction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const extraction = { ...value };
  // Models occasionally return a valid brief as prose instead of the object
  // requested by the contract. Normalize that one safe representation; never
  // invent missing analysis or silently accept an empty brief.
  if (typeof extraction.visual_generation_brief === 'string' && extraction.visual_generation_brief.trim()) {
    extraction.visual_generation_brief = { style: clean(extraction.visual_generation_brief, 3000), elements: [] };
  }
  return extraction;
}
function evidenceOnlyBrandDna(pages) {
  const root = pages[0] || {};
  const name = clean(root.title, 240) || (() => { try { return new URL(root.url).hostname.replace(/^www\./, ''); } catch { return 'Brand'; } })();
  const description = clean(root.description, 600);
  const visual = root.visual || {}; const colors = Array.isArray(visual.colors) ? visual.colors.filter((value) => /^rgb/.test(String(value))).slice(0, 6) : [];
  const [primary, secondary, accent, background] = colors;
  const font = Array.isArray(visual.fonts) ? visual.fonts[0] : '';
  const visualSummary = `Captured interface uses ${colors.length ? colors.join(', ') : 'the stored screenshot palette'}${font ? ` with ${font}` : ''}.`;
  return {
    identity: { name, ...(description ? { tagline: description } : {}) },
    voice: { tone: 'Evidence-led, product-focused', style: 'Derived from the captured page hierarchy and copy; validate editorial claims before publication.' },
    palette: { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}), ...(accent ? { accent } : {}), ...(background ? { background } : {}) },
    typography: { ...(font ? { headings: font, body: font } : {}) }, layout: { structure: 'Captured public-site hierarchy' }, imagery: { style: visualSummary, content: Array.isArray(visual.image_alts) ? visual.image_alts.join(' · ') : '' }, accessibility: {},
    visual_generation_brief: { style: 'Evidence-first creative direction assembled from rendered first-party pages.', elements: ['Use retained screenshots for palette, typography, composition, product imagery, and logo treatment.', 'Preserve the captured hierarchy and generous visual pacing.', 'Do not add unsupported claims, brand history, or compliance language.'] },
    extraction_status: 'evidence_only_fallback',
  };
}
function enrichBrandDnaFromRenderedSignals(extraction, pages) {
  const root = pages[0] || {}; const visual = root.visual || {};
  const colors = Array.isArray(visual.colors) ? visual.colors.filter((value) => /^rgb/.test(String(value))).slice(0, 6) : [];
  const accents = Array.isArray(visual.accent_colors) ? visual.accent_colors.filter((value) => /^rgb/.test(String(value))).slice(0, 4) : [];
  const [primary, secondary, accent, background] = colors;
  const currentAccent = String(extraction?.palette?.accent || '');
  const saturation = (value) => { const values = String(value).match(/\d+/g)?.slice(0, 3).map(Number); return values?.length === 3 ? (Math.max(...values) - Math.min(...values)) / Math.max(1, Math.max(...values)) : 0; };
  extraction.palette = { ...(extraction.palette || {}), ...(!clean(extraction?.palette?.primary) && primary ? { primary } : {}), ...(!clean(extraction?.palette?.secondary) && secondary ? { secondary } : {}), ...((!currentAccent || saturation(currentAccent) < 0.18) && (accents[0] || accent) ? { accent: accents[0] || accent } : {}), ...(!clean(extraction?.palette?.background) && background ? { background } : {}), ...(accents.length ? { accents } : {}) };
  const font = Array.isArray(visual.fonts) ? visual.fonts[0] : '';
  extraction.typography = { ...(extraction.typography || {}), ...(!clean(extraction?.typography?.headings) && font ? { headings: font } : {}), ...(!clean(extraction?.typography?.body) && font ? { body: font } : {}) };
  extraction.layout = { ...(extraction.layout || {}), ...(!clean(extraction?.layout?.structure) ? { structure: 'Captured public-site hierarchy' } : {}) };
  extraction.imagery = { ...(extraction.imagery || {}), ...(!clean(extraction?.imagery?.content) && Array.isArray(visual.image_alts) && visual.image_alts.length ? { content: visual.image_alts.join(' · ') } : {}) };
  return extraction;
}
function commercialSignals(pages) {
  const text = pages.map((page) => String(page?.text || '')).join(' ').replace(/\s+/g, ' ');
  const priceMatches = [...text.matchAll(/(?:€|\$|£)\s?\d{1,5}(?:[.,]\d{2})?(?:\s*(?:\/|per)\s*(?:month|mo|year|yr))?/gi)].map((match) => match[0]).filter((value, index, values) => values.indexOf(value) === index).slice(0, 20);
  const ctas = [...text.matchAll(/\b(?:book(?: an?)?|request|start|contact|buy|shop|discover|learn more|download|demo|trial|subscribe)\b[^.]{0,90}/gi)].map((match) => clean(match[0], 120)).filter((value, index, values) => values.indexOf(value) === index).slice(0, 16);
  return { public_prices: priceMatches, calls_to_action: ctas, pricing_status: priceMatches.length ? 'public_prices_found' : 'not_publicly_listed_in_captured_pages' };
}

/**
 * The single admission path used by Rooms, lifecycle episodes, and future
 * API callers. It sends identifiers and public HTTPS URLs only; page bytes,
 * screenshots and credentials never leave the bounded browser/Worker path.
 */
export async function startVisualIntelligenceWorkflow({ orgId, userId, urls, roomId = null, lifecycleDay = null, mode = 'public', deliverable = 'brand_dna_v1', fetchImpl = globalThis.fetch } = {}) {
  if (process.env.VISUAL_INTELLIGENCE_WORKFLOW_ENABLED !== 'true') return { ok: false, skipped: true, reason: 'feature_disabled' };
  const endpoint = String(process.env.HIVEMIND_VISUAL_WORKFLOW_URL || '').replace(/\/$/, '');
  const secret = String(process.env.HIVEMIND_VISUAL_WORKFLOW_SECRET || '');
  if (!endpoint || !secret) return { ok: false, skipped: true, reason: 'workflow_not_configured' };
  // Day 2 is a lifecycle episode, not a Room turn. The room reference is only
  // the tenant-scoped source of the company profile, recipient, and Humation
  // roster needed for its email/report delivery. Requiring it here prevents a
  // detached workflow from accidentally claiming a customer lifecycle send.
  if (lifecycleDay === 2 && (!UUID.test(String(roomId || '')) || deliverable !== 'brand_dna_v1')) {
    return { ok: false, skipped: true, reason: 'day2_lifecycle_context_required' };
  }
  const trigger = { job_id: crypto.randomUUID(), org_id: orgId, user_id: userId, urls, mode, deliverable, processing_version: VISUAL_PIPELINE_VERSION, requested_at: new Date().toISOString(), ...(UUID.test(String(roomId || '')) ? { room_id: roomId } : {}), ...(lifecycleDay === 2 ? { lifecycle_day: 2 } : {}) };
  validateVisualAdmission(trigger);
  const response = await fetchImpl(`${endpoint}/start`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(trigger), signal: AbortSignal.timeout(15_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, status: response.status, error: payload.error || `workflow_http_${response.status}` };
  return { ok: true, job_id: trigger.job_id, ...payload };
}

export function isDayTwoBrandDnaEnabled() { return process.env.HIVEMIND_D2_BRAND_DNA_WORKFLOW_ENABLED === 'true'; }
function companyWebsite(company) {
  const candidate = company?.website || company?.website_url || company?.profile?.website || '';
  try { const url = new URL(String(candidate).includes('://') ? String(candidate) : `https://${candidate}`); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}
/** The Worker cron asks for candidates; eligibility is entirely PostgreSQL-backed. */
export async function listEligibleDayTwoBrandDna({ prisma, limit = 25 } = {}) {
  if (!isDayTwoBrandDnaEnabled()) throw Object.assign(new Error('day2_feature_disabled'), { retryable: false });
  const rows = await prisma.$queryRawUnsafe(`SELECT id, org_id, user_id, "agent_connectors"->'_company' AS company FROM "hivemind"."hyper_rooms" WHERE "agent_connectors" ? '_company' AND archived_at IS NULL AND "agent_connectors" #>> '{_company,day1_first_move,status}' = 'sent' AND COALESCE("agent_connectors" #>> '{_company,day2_brand_dna,status}', '') NOT IN ('queued','running','completed','sent') ORDER BY created_at ASC LIMIT $1`, Math.max(1, Math.min(100, Number(limit) || 25))).catch(() => []);
  const now = Date.now();
  return rows.map((row) => {
    const company = typeof row.company === 'string' ? JSON.parse(row.company) : row.company;
    const target = Date.parse(company?.onboarded_at || ''); const website = companyWebsite(company);
    return website && (!Number.isFinite(target) || target + 48 * 60 * 60 * 1000 <= now) ? { org_id: String(row.org_id), user_id: String(row.user_id), room_id: String(row.id), url: website } : null;
  }).filter(Boolean);
}
/** Claims one Day-2 episode before scheduling, so cron replays never duplicate it. */
export async function prepareDayTwoBrandDna({ prisma, orgId, userId, roomId, url, fetchImpl } = {}) {
  if (!isDayTwoBrandDnaEnabled()) throw Object.assign(new Error('day2_feature_disabled'), { retryable: false });
  if (!UUID.test(String(orgId)) || !UUID.test(String(userId)) || !UUID.test(String(roomId)) || !safeUrl(url)) throw Object.assign(new Error('invalid_day2_brand_dna_input'), { retryable: false });
  const rows = await prisma.$queryRawUnsafe(`SELECT "agent_connectors"->'_company' AS company FROM "hivemind"."hyper_rooms" WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid AND archived_at IS NULL FOR UPDATE`, roomId, orgId, userId);
  const company = rows?.[0]?.company && (typeof rows[0].company === 'string' ? JSON.parse(rows[0].company) : rows[0].company);
  const state = company?.day2_brand_dna || {};
  if (['queued', 'running', 'completed', 'sent'].includes(state.status)) return { ok: true, existing: true, job_id: state.job_id || null };
  const scheduling = { ...state, status: 'scheduling', scheduled_at: new Date().toISOString(), website: safeUrl(url) };
  company.day2_brand_dna = scheduling;
  await prisma.$executeRawUnsafe(`UPDATE "hivemind"."hyper_rooms" SET "agent_connectors"=jsonb_set("agent_connectors", '{_company}', $1::jsonb, true) WHERE id=$2::uuid AND org_id=$3::uuid`, JSON.stringify(company), roomId, orgId);
  const scheduled = await startVisualIntelligenceWorkflow({ orgId, userId, urls: [safeUrl(url)], roomId, lifecycleDay: 2, fetchImpl });
  company.day2_brand_dna = { ...scheduling, status: scheduled.ok ? 'queued' : 'failed', job_id: scheduled.job_id || null, workflow_response: scheduled.ok ? { queued: true } : { error: scheduled.error || scheduled.reason || 'schedule_failed' }, updated_at: new Date().toISOString() };
  await prisma.$executeRawUnsafe(`UPDATE "hivemind"."hyper_rooms" SET "agent_connectors"=jsonb_set("agent_connectors", '{_company}', $1::jsonb, true) WHERE id=$2::uuid AND org_id=$3::uuid`, JSON.stringify(company), roomId, orgId);
  return scheduled;
}

export class DurableVisualIntelligenceLifecycle {
  constructor({ prisma, logger = console, browserFactory = () => new PlaywrightServiceRuntime(), fetchImpl = globalThis.fetch } = {}) { this.prisma = prisma; this.logger = logger; this.browserFactory = browserFactory; this.fetch = fetchImpl; }

  async admit(input) {
    validateVisualAdmission(input);
    const membership = await this.prisma.userOrganization.findFirst({ where: { orgId: input.org_id, userId: input.user_id, isActive: true }, select: { userId: true } });
    if (!membership) throw Object.assign(new Error('visual_tenant_access_denied'), { retryable: false });
    const roomId = UUID.test(String(input.room_id || '')) ? input.room_id : null;
    if (roomId) {
      const room = await this.prisma.hyperRoom.findFirst({ where: { id: roomId, orgId: input.org_id, userId: input.user_id, archivedAt: null }, select: { id: true } });
      if (!room) throw Object.assign(new Error('visual_room_access_denied'), { retryable: false });
    }
    if (input.lifecycle_day === 2 && !roomId) throw Object.assign(new Error('day2_lifecycle_context_required'), { retryable: false });
    const data = { orgId: input.org_id, userId: input.user_id, jobId: input.job_id, roomId, workflowInstanceId: clean(input.workflow_instance_id, 140) || null, processingVersion: input.processing_version, mode: input.mode, browserSession: input.mode === 'user_takeover' ? String(input.browser_session) : null, deliverable: input.deliverable, status: 'running', currentStage: 'admit', progress: 0, urls: input.urls.map(safeUrl).filter(Boolean), latchedFlags: { ...(input.flags || {}), lifecycle_day: input.lifecycle_day === 2 ? 2 : null }, heartbeatAt: new Date() };
    let run = await this.prisma.visualIntelligenceRun.findUnique({ where: { orgId_jobId_processingVersion: { orgId: data.orgId, jobId: data.jobId, processingVersion: data.processingVersion } } });
    if (!run) run = await this.prisma.visualIntelligenceRun.create({ data });
    return this._receipt(run);
  }

  async executeStage({ run_id: runId, stage, input = {}, shard_key: shardKey = 'root' }) {
    if (!UUID.test(String(runId || '')) || !VISUAL_STAGES.includes(stage)) throw Object.assign(new Error('invalid_visual_stage_request'), { retryable: false });
    const run = await this.prisma.visualIntelligenceRun.findUnique({ where: { id: runId } });
    if (!run) throw Object.assign(new Error('visual_run_not_found'), { retryable: false });
    if (TERMINAL.has(run.status)) return this._receipt(run);
    const inputDigest = hash({ runId, stage, shardKey, input, version: run.processingVersion });
    const existing = await this.prisma.visualIntelligenceStep.findUnique({ where: { runId_stageKey_shardKey: { runId, stageKey: stage, shardKey } } });
    if (existing?.status === 'completed') {
      // Capture payloads contain large transient image bytes and are
      // deliberately omitted from PostgreSQL receipts. If the Worker crashes
      // or rejects a quality gate before storing those bytes in R2, permit an
      // explicit bounded recapture instead of returning an unusable receipt.
      if (stage !== 'capture' || input?.recapture_missing_payload !== true) return existing.outputReceipt;
      await this.prisma.visualIntelligenceStep.update({
        where: { id: existing.id },
        data: { status: 'failed', error: { message: 'capture_payload_replay_requested', retryable: true }, completedAt: null, leaseExpiresAt: null },
      });
      existing.status = 'failed';
      existing.leaseExpiresAt = null;
    }
    if (existing?.status === 'running' && existing.leaseExpiresAt > new Date()) throw Object.assign(new Error('visual_stage_lease_busy'), { retryable: true });
    const leaseExpiresAt = new Date(Date.now() + 5 * 60_000);
    if (existing) {
      const claimed = await this.prisma.visualIntelligenceStep.updateMany({ where: { id: existing.id, status: { not: 'completed' }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }] }, data: { status: 'running', attempt: { increment: 1 }, inputDigest, leaseExpiresAt, startedAt: existing.startedAt || new Date() } });
      if (claimed.count !== 1) throw Object.assign(new Error('visual_stage_lease_busy'), { retryable: true });
    } else await this.prisma.visualIntelligenceStep.create({ data: { runId, stageKey: stage, shardKey, status: 'running', attempt: 1, inputDigest, leaseExpiresAt, startedAt: new Date() } });
    await this.prisma.visualIntelligenceRun.update({ where: { id: runId }, data: { currentStage: stage, progress: PROGRESS[stage], heartbeatAt: new Date() } });
    try {
      const output = await this[`_${stage.replaceAll('-', '_')}`](run, input);
      const stored = stage === 'capture' ? { ...output, capture_payload: undefined } : output;
      await this.prisma.visualIntelligenceStep.update({ where: { runId_stageKey_shardKey: { runId, stageKey: stage, shardKey } }, data: { status: 'completed', outputReceipt: stored, counters: output.counts || {}, completedAt: new Date(), leaseExpiresAt: null } });
      return output;
    } catch (error) {
      await this.prisma.visualIntelligenceStep.update({ where: { runId_stageKey_shardKey: { runId, stageKey: stage, shardKey } }, data: { status: 'failed', error: { message: error.message, retryable: error.retryable !== false }, leaseExpiresAt: null } }).catch(() => null);
      await this.prisma.visualIntelligenceRun.update({ where: { id: runId }, data: { error: { message: error.message }, heartbeatAt: new Date() } }).catch(() => null);
      throw error;
    }
  }

  async failRun(input) {
    const run = await this.prisma.visualIntelligenceRun.findUnique({ where: { id: String(input?.run_id || '') } });
    if (!run) throw Object.assign(new Error('visual_run_not_found'), { retryable: false });
    if (TERMINAL.has(run.status)) return this._receipt(run);
    const now = new Date();
    const failed = await this.prisma.visualIntelligenceRun.update({ where: { id: run.id }, data: { status: 'failed', currentStage: clean(input.failed_stage, 48), terminalReason: clean(input.failure_code, 180), finishedAt: now, heartbeatAt: now } });
    // The Day-2 room claim is the scheduling fence. Release it only when this
    // exact durable run failed, so a later workflow retry or another run can
    // never overwrite a completed/sent episode for the tenant.
    if (failed.latchedFlags?.lifecycle_day === 2 && failed.roomId) {
      const rows = await this.prisma.$queryRawUnsafe(
        `SELECT "agent_connectors"->'_company' AS company FROM "hivemind"."hyper_rooms" WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid FOR UPDATE`,
        failed.roomId, failed.orgId, failed.userId,
      ).catch(() => []);
      const company = typeof rows?.[0]?.company === 'string' ? JSON.parse(rows[0].company) : rows?.[0]?.company;
      const episode = company?.day2_brand_dna;
      if (company && episode?.job_id === failed.jobId && !['sent', 'completed'].includes(episode.status)) {
        company.day2_brand_dna = { ...episode, status: 'failed', failed_at: now.toISOString(), failure_reason: clean(input.failure_code, 180) || 'workflow_failure', updated_at: now.toISOString() };
        await this.prisma.$executeRawUnsafe(
          `UPDATE "hivemind"."hyper_rooms" SET "agent_connectors"=jsonb_set("agent_connectors", '{_company}', $1::jsonb, true) WHERE id=$2::uuid AND org_id=$3::uuid AND user_id=$4::uuid`,
          JSON.stringify(company), failed.roomId, failed.orgId, failed.userId,
        ).catch(() => null);
      }
    }
    return this._receipt(failed);
  }

  async _admit(run) { return this._receipt(run); }
  async _discover(run) { const urls = (run.urls || []).map(safeUrl).filter(Boolean); return { run_id: run.id, urls, counts: { urls: urls.length } }; }
  async _capture(run) {
    const discovery = await this._stageOutput(run.id, 'discover'); const urls = (discovery?.urls || run.urls || []).map(safeUrl).filter(Boolean);
    const browser = this.browserFactory(); const captures = [];
    const depth = Math.max(0, Math.min(4, Number(process.env.VISUAL_INTELLIGENCE_CRAWL_DEPTH || 2)));
    const pageLimit = Math.max(1, Math.min(40, Number(process.env.VISUAL_INTELLIGENCE_CRAWL_PAGE_LIMIT || 16)));
    const result = await browser.crawl({ urls, depth, pageLimit, captureScreenshot: true, allowSubdomains: true, session: run.mode === 'user_takeover' ? run.browserSession : null, orgId: run.orgId });
    for (const page of result.pages || []) captures.push({ page: compactPage(page), screenshot: screenshotData(page.screenshot) });
    if (!captures.length) throw Object.assign(new Error('visual_capture_empty'), { retryable: true });
    const visualPages = captures.filter((entry) => entry.screenshot).length;
    if (!visualPages) throw Object.assign(new Error('visual_capture_no_screenshot_receipts'), { retryable: true });
    return { run_id: run.id, counts: { captured_pages: captures.length, visual_pages: visualPages, crawl_errors: (result.errors || []).length }, capture_payload: captures };
  }
  async _store(run, input) {
    const artifacts = Array.isArray(input?.artifacts) ? input.artifacts.filter((x) => x && safeUrl(x.page_url) && clean(x.r2_key, 500) && x.page && typeof x.page === 'object') : [];
    if (!artifacts.length) throw Object.assign(new Error('visual_artifacts_missing'), { retryable: true });
    await this.prisma.visualIntelligenceRun.update({ where: { id: run.id }, data: { sourceRefs: artifacts } });
    return { run_id: run.id, source_refs: artifacts, counts: { artifacts: artifacts.length } };
  }
  async _extract(run) {
    const store = await this._stageOutput(run.id, 'store'); const sourceRefs = store?.source_refs || [];
    const pages = sourceRefs.map((row) => row?.page).filter(Boolean);
    if (!pages.length || !sourceRefs.length) throw Object.assign(new Error('visual_evidence_not_ready'), { retryable: true });
    // The full crawl is retained as evidence, while model synthesis receives a
    // deliberately bounded representative sample. This prevents a large site
    // from turning one extraction turn into an unreliable mega-prompt.
    const modelSources = sourceRefs.slice(0, 4); const modelPages = pages.slice(0, 4);
    const images = await Promise.all(modelSources.slice(0, 3).map((source) => this._loadArtifactImage(source.r2_key)));
    const prompt = { company_name: 'Unknown organization', evidence: modelPages.map((page, index) => ({ source_index: index, url: page.url, title: page.title, description: page.description, text: page.text.slice(0, 5000), seo: page.seo })), required: ['identity', 'voice', 'palette', 'typography', 'layout', 'imagery', 'accessibility', 'visual_generation_brief', 'company_intelligence'], company_intelligence_contract: { offers: 'array of source-backed products/services', audiences: 'array of source-backed customer segments', pricing: 'public prices only; state not_publicly_listed when absent', proof_points: 'array with source_indexes', calls_to_action: 'array', positioning: 'concise source-backed statement' } };
    const response = await gatewayFirstFetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.OPENROUTER_API_KEY ? { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {}) }, body: JSON.stringify({ model: process.env.HIVEMIND_VISION_MODEL || 'google/gemini-2.5-flash-lite', temperature: 0, max_tokens: 1800, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Extract a cautious Brand DNA from supplied first-party rendered pages. Return JSON only. Every non-obvious claim must cite source_indexes. Never invent colors, compliance claims, logos, prices, or brand history.' }, { role: 'user', content: [{ type: 'text', text: JSON.stringify(prompt) }, ...images.filter(Boolean).map((url) => ({ type: 'image_url', image_url: { url } }))] }] }) }, { fetchImpl: this.fetch });
    if (!response.ok) throw Object.assign(new Error(`visual_extractor_http_${response.status}`), { retryable: true });
    const body = await response.json();
    let extraction = normalizeBrandDnaExtraction(parserJson(body?.choices?.[0]?.message?.content));
    // A provider can return a successful response with an incomplete JSON
    // object. Once the visual-evidence gate has retained several independently
    // rendered pages, use a deterministic, source-backed composition as a
    // repair path—not the old one-page generic shell. This keeps Day 2 useful
    // and durable while clearly marking the model repair in the artifact.
    if (!extraction?.visual_generation_brief || typeof extraction.visual_generation_brief !== 'object') {
      if (sourceRefs.length < 3) throw Object.assign(new Error('visual_extraction_contract_invalid'), { retryable: true });
      extraction = evidenceOnlyBrandDna(pages);
      extraction.extraction_status = 'deterministic_evidence_repair';
    }
    enrichBrandDnaFromRenderedSignals(extraction, pages);
    // Title is browser-captured, first-party evidence. It is a safe fallback
    // when a model returns a usable brief but omits the brand name.
    if (!clean(extraction?.identity?.name, 240) && clean(pages[0]?.title, 240)) extraction.identity = { ...(extraction.identity || {}), name: clean(pages[0].title, 240) };
    extraction.company_intelligence = { ...(extraction.company_intelligence || {}), ...commercialSignals(pages) };
    return { run_id: run.id, extraction, model: extraction.extraction_status ? 'evidence-only-fallback' : (process.env.HIVEMIND_VISION_MODEL || 'google/gemini-2.5-flash-lite'), counts: { extracted_pages: pages.length, model_sample_pages: modelPages.length } };
  }
  async _verify(run) {
    const extracted = await this._stageOutput(run.id, 'extract'); const sourceRefs = (await this._stageOutput(run.id, 'store'))?.source_refs || [];
    const brief = extracted?.extraction?.visual_generation_brief;
    if (!extracted?.extraction || !brief || typeof brief !== 'object' || !sourceRefs.length) throw Object.assign(new Error('visual_verification_incomplete'), { retryable: false });
    return { run_id: run.id, verified: true, counts: { evidence: sourceRefs.length } };
  }
  async _publish(run) {
    const extracted = await this._stageOutput(run.id, 'extract'); const sourceRefs = (await this._stageOutput(run.id, 'store'))?.source_refs || [];
    const room = run.roomId ? await this.prisma.hyperRoom.findFirst({ where: { id: run.roomId, orgId: run.orgId, userId: run.userId }, select: { agentConnectors: true } }).catch(() => null) : null;
    const company = room?.agentConnectors?._company || {};
    const agent_roster = (Array.isArray(company.team) ? company.team : []).slice(0, 6).map((agent) => ({
      id: clean(agent?.id || agent?.employeeId || agent?.slug, 120),
      name: clean(agent?.name, 72),
      role: clean(agent?.jobTitle || agent?.title || agent?.role, 96),
      role_archetype: clean(agent?.roleArchetype || agent?.archetype || agent?.role, 96),
    })).filter((agent) => agent.name);
    const artifact = {
      artifact_type: 'brand_dna', version: `visual-intelligence-v${run.processingVersion}`,
      generated_at: new Date().toISOString(), evidence: sourceRefs,
      analysis: extracted?.extraction || {}, visual_generation_brief: extracted?.extraction?.visual_generation_brief || {}, agent_roster,
      reusable: { kind: 'company_brand_dna', scope: 'organization', authority: 'captured_first_party_evidence', intended_uses: ['visual_artifacts', 'brand_intelligence', 'hyperagent_context'] },
    };
    if (!artifact.evidence.length || !Object.keys(artifact.visual_generation_brief).length) throw Object.assign(new Error('invalid_brand_dna_artifact'), { retryable: false });
    await this.prisma.visualIntelligenceRun.update({ where: { id: run.id }, data: { artifact } }); return { ...this._receipt({ ...run, artifact }), artifact, counts: { evidence: artifact.evidence.length } };
  }
  async _render(run, input) {
    const fresh = await this.prisma.visualIntelligenceRun.findUnique({ where: { id: run.id } });
    const report = input?.report;
    if (!fresh?.artifact?.artifact_type || !String(report?.r2_key || '').startsWith(`org/${run.orgId}/runs/${run.id}/reports/`)) throw Object.assign(new Error('invalid_rendered_brand_dna_report'), { retryable: false });
    const artifact = { ...fresh.artifact, rendered_report: { r2_key: String(report.r2_key), content_type: clean(report.content_type, 100) || 'text/html; charset=utf-8', version: clean(report.version, 120) || null } };
    await this.prisma.visualIntelligenceRun.update({ where: { id: run.id }, data: { artifact } });
    return { ...this._receipt({ ...fresh, artifact }), artifact, counts: { rendered_reports: 1 } };
  }
  async _notify(run) {
    const fresh = await this.prisma.visualIntelligenceRun.findUnique({ where: { id: run.id } });
    await createWorkspaceNotification(this.prisma, { orgId: run.orgId, userId: run.userId, type: 'visual_intelligence.brand_dna_ready', title: 'Your Brand DNA is ready', body: 'Your Agents captured, mapped and verified a reusable visual brief.', resourceType: 'visual_intelligence_run', resourceId: run.id, dedupeKey: `visual-intelligence:${run.id}:ready`, data: { run_id: run.id, artifact_type: 'brand_dna', rendered_report: fresh?.artifact?.rendered_report || null } });
    const now = new Date();
    const completed = await this.prisma.visualIntelligenceRun.update({ where: { id: run.id }, data: { status: 'completed', currentStage: 'notify', progress: 100, finishedAt: now, heartbeatAt: now, terminalReason: 'verified_and_published', artifact: fresh?.artifact || {} } });
    if (completed.latchedFlags?.lifecycle_day === 2 && process.env.HIVEMIND_D2_BRAND_DNA_WORKFLOW_ENABLED === 'true') {
      const { deliverDayTwoBrandDna } = await import('../lifecycle/day1-first-move.js');
      await deliverDayTwoBrandDna({ prisma: this.prisma, runId: completed.id });
    }
    return this._receipt(completed);
  }
  async _stageOutput(runId, stageKey) { const step = await this.prisma.visualIntelligenceStep.findUnique({ where: { runId_stageKey_shardKey: { runId, stageKey, shardKey: 'root' } } }); return step?.outputReceipt || null; }
  async _loadArtifactImage(key) {
    const base = String(process.env.HIVEMIND_VISUAL_ARTIFACT_URL || '').replace(/\/$/, ''); const secret = String(process.env.HIVEMIND_VISUAL_WORKFLOW_SECRET || '');
    if (!base || !secret || !key) throw Object.assign(new Error('visual_artifact_reader_unconfigured'), { retryable: true });
    const response = await this.fetch(`${base}/artifact?key=${encodeURIComponent(key)}`, { headers: { authorization: `Bearer ${secret}` } });
    if (!response.ok) throw Object.assign(new Error(`visual_artifact_read_http_${response.status}`), { retryable: response.status >= 500 });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 7_000_000) throw Object.assign(new Error('visual_artifact_invalid_size'), { retryable: false });
    return `data:${response.headers.get('content-type') || 'image/jpeg'};base64,${bytes.toString('base64')}`;
  }
  _receipt(run) { return { run_id: run.id, org_id: run.orgId, user_id: run.userId, workflow_instance_id: run.workflowInstanceId, processing_version: run.processingVersion, status: run.status, stage: run.currentStage, progress: run.progress, artifact: run.artifact || {}, source_refs: run.sourceRefs || {} }; }
}
