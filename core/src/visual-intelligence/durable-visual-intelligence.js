import crypto from 'node:crypto';
import { PlaywrightServiceRuntime } from '../web/playwright-service-runtime.js';
import { gatewayFirstFetch } from '../llm/cloudflare-gateway.js';
import { createWorkspaceNotification } from '../workspace/notifications.js';

export const VISUAL_PIPELINE_VERSION = 1;
export const VISUAL_STAGES = Object.freeze(['admit', 'discover', 'capture', 'store', 'extract', 'verify', 'publish', 'notify']);
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
    captured_at: new Date().toISOString(),
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

export class DurableVisualIntelligenceLifecycle {
  constructor({ prisma, logger = console, browserFactory = () => new PlaywrightServiceRuntime(), fetchImpl = globalThis.fetch } = {}) { this.prisma = prisma; this.logger = logger; this.browserFactory = browserFactory; this.fetch = fetchImpl; }

  async admit(input) {
    validateVisualAdmission(input);
    const membership = await this.prisma.userOrganization.findFirst({ where: { orgId: input.org_id, userId: input.user_id, isActive: true }, select: { userId: true } });
    if (!membership) throw Object.assign(new Error('visual_tenant_access_denied'), { retryable: false });
    const data = { orgId: input.org_id, userId: input.user_id, jobId: input.job_id, roomId: UUID.test(String(input.room_id || '')) ? input.room_id : null, workflowInstanceId: clean(input.workflow_instance_id, 140) || null, processingVersion: input.processing_version, mode: input.mode, browserSession: input.mode === 'user_takeover' ? String(input.browser_session) : null, deliverable: input.deliverable, status: 'running', currentStage: 'admit', progress: 0, urls: input.urls.map(safeUrl).filter(Boolean), latchedFlags: input.flags || {}, heartbeatAt: new Date() };
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
    if (existing?.status === 'completed') return existing.outputReceipt;
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
    return this._receipt(await this.prisma.visualIntelligenceRun.update({ where: { id: run.id }, data: { status: 'failed', currentStage: clean(input.failed_stage, 48), terminalReason: clean(input.failure_code, 180), finishedAt: now, heartbeatAt: now } }));
  }

  async _admit(run) { return this._receipt(run); }
  async _discover(run) { const urls = (run.urls || []).map(safeUrl).filter(Boolean); return { run_id: run.id, urls, counts: { urls: urls.length } }; }
  async _capture(run) {
    const discovery = await this._stageOutput(run.id, 'discover'); const urls = (discovery?.urls || run.urls || []).map(safeUrl).filter(Boolean);
    const browser = this.browserFactory(); const captures = [];
    for (const url of urls) {
      const result = await browser.crawl({ urls: [url], depth: 0, pageLimit: 1, captureScreenshot: true, session: run.mode === 'user_takeover' ? run.browserSession : null });
      const page = result.pages?.[0]; if (!page) continue;
      captures.push({ page: compactPage(page), screenshot: screenshotData(page.screenshot) });
    }
    if (!captures.length) throw Object.assign(new Error('visual_capture_empty'), { retryable: true });
    return { run_id: run.id, counts: { captured_pages: captures.length }, capture_payload: captures };
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
    const images = await Promise.all(sourceRefs.map((source) => this._loadArtifactImage(source.r2_key)));
    const prompt = { company_name: 'Unknown organization', evidence: pages.map((page, index) => ({ source_index: index, url: page.url, title: page.title, description: page.description, text: page.text.slice(0, 9000), seo: page.seo })), required: ['identity', 'voice', 'palette', 'typography', 'layout', 'imagery', 'accessibility', 'visual_generation_brief'] };
    const response = await gatewayFirstFetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.OPENROUTER_API_KEY ? { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {}) }, body: JSON.stringify({ model: process.env.HIVEMIND_VISION_MODEL || 'google/gemini-2.5-flash-lite', temperature: 0, max_tokens: 1800, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Extract a cautious Brand DNA from supplied first-party rendered pages. Return JSON only. Every non-obvious claim must cite source_indexes. Never invent colors, compliance claims, logos, prices, or brand history.' }, { role: 'user', content: [{ type: 'text', text: JSON.stringify(prompt) }, ...images.filter(Boolean).map((url) => ({ type: 'image_url', image_url: { url } }))] }] }) }, { fetchImpl: this.fetch });
    if (!response.ok) throw Object.assign(new Error(`visual_extractor_http_${response.status}`), { retryable: true });
    const body = await response.json(); const extraction = parserJson(body?.choices?.[0]?.message?.content);
    if (!extraction || typeof extraction !== 'object') throw Object.assign(new Error('visual_extractor_invalid_response'), { retryable: true });
    return { run_id: run.id, extraction, model: process.env.HIVEMIND_VISION_MODEL || 'google/gemini-2.5-flash-lite', counts: { extracted_pages: pages.length } };
  }
  async _verify(run) {
    const extracted = await this._stageOutput(run.id, 'extract'); const sourceRefs = (await this._stageOutput(run.id, 'store'))?.source_refs || [];
    const brief = extracted?.extraction?.visual_generation_brief;
    if (!extracted?.extraction || !brief || typeof brief !== 'object' || !sourceRefs.length) throw Object.assign(new Error('visual_verification_incomplete'), { retryable: false });
    return { run_id: run.id, verified: true, counts: { evidence: sourceRefs.length } };
  }
  async _publish(run) {
    const extracted = await this._stageOutput(run.id, 'extract'); const sourceRefs = (await this._stageOutput(run.id, 'store'))?.source_refs || [];
    const artifact = { artifact_type: 'brand_dna', version: `visual-intelligence-v${run.processingVersion}`, generated_at: new Date().toISOString(), evidence: sourceRefs, analysis: extracted?.extraction || {}, visual_generation_brief: extracted?.extraction?.visual_generation_brief || {} };
    if (!artifact.evidence.length || !Object.keys(artifact.visual_generation_brief).length) throw Object.assign(new Error('invalid_brand_dna_artifact'), { retryable: false });
    await this.prisma.visualIntelligenceRun.update({ where: { id: run.id }, data: { artifact } }); return { ...this._receipt({ ...run, artifact }), artifact, counts: { evidence: artifact.evidence.length } };
  }
  async _notify(run) { const fresh = await this.prisma.visualIntelligenceRun.findUnique({ where: { id: run.id } }); await createWorkspaceNotification(this.prisma, { orgId: run.orgId, userId: run.userId, type: 'visual_intelligence.brand_dna_ready', title: 'Your Brand DNA is ready', body: 'Your Agents captured and verified a reusable visual brief.', resourceType: 'visual_intelligence_run', resourceId: run.id, dedupeKey: `visual-intelligence:${run.id}:ready`, data: { run_id: run.id, artifact_type: 'brand_dna' } }); const now = new Date(); return this._receipt(await this.prisma.visualIntelligenceRun.update({ where: { id: run.id }, data: { status: 'completed', currentStage: 'notify', progress: 100, finishedAt: now, heartbeatAt: now, terminalReason: 'verified_and_published', artifact: fresh?.artifact || {} } })); }
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
