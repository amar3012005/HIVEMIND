import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '4:5']);
const USE_CASES = new Set(['campaign_social', 'campaign_ad', 'room_visual', 'presentation', 'website', 'product', 'editorial', 'general']);
const OUTPUT_MODES = new Set(['single', 'set']);
const QUALITY = new Set(['fast', 'balanced', 'quality']);
const MODEL_POLICIES = new Set(['auto', 'fast', 'quality']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const PROGRESS = { queued: 0, admitted: 5, context: 15, art_direction: 28, generating_anchor: 42, generating_master: 58, critiquing: 70, generating_variants: 82, storing: 94, completed: 100, failed: 100 };

function clean(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function boundedList(value, max = 8) { return (Array.isArray(value) ? value : []).map((item) => clean(item, 500)).filter(Boolean).slice(0, max); }
function visualError(message, status = 400, code = 'visual_generation_invalid') { return Object.assign(new Error(message), { status, code, retryable: status >= 500 }); }
function publicEvent(row) { return { ...row, id: String(row.id) }; }
function publicJob(job, events = []) {
  return {
    job_id: job.id, contract_version: job.contractVersion, status: job.status, stage: job.currentStage,
    instruction: job.instruction, source: job.source || {},
    progress: job.progress, use_case: job.useCase, output: { mode: job.outputMode, count: job.requestedCount, aspect_ratios: job.aspectRatios },
    quality: job.quality, model_policy: job.modelPolicy, production_spec: job.productionSpec || {}, assets: job.assets || [],
    error: job.error || null, terminal_reason: job.terminalReason || null, workflow_instance_id: job.workflowInstanceId || null,
    created_at: job.createdAt, updated_at: job.updatedAt, events: events.map(publicEvent),
  };
}

export async function listVisualGenerationJobs({ prisma, orgId, userId, roomId, limit = 12 } = {}) {
  if (!prisma || !UUID.test(String(orgId)) || !UUID.test(String(userId))) {
    throw visualError('authenticated tenant context is required', 401, 'visual_generation_unauthorized');
  }
  if (!UUID.test(String(roomId))) throw visualError('room_id must be a UUID');
  const membership = await prisma.userOrganization.findFirst({
    where: { orgId, userId, isActive: true }, select: { userId: true },
  });
  if (!membership) throw visualError('active organization membership is required', 403, 'visual_generation_forbidden');
  const jobs = await prisma.visualGenerationJob.findMany({
    where: { orgId, userId, roomId },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(24, Number(limit) || 12)),
  });
  return { jobs: jobs.map((job) => publicJob(job)) };
}

export function normalizeVisualGenerationRequest(input = {}) {
  const instruction = clean(input.instruction, 12_000);
  if (instruction.length < 8) throw visualError('instruction must describe the required visual');
  const output = input.output && typeof input.output === 'object' ? input.output : {};
  const mode = OUTPUT_MODES.has(output.mode) ? output.mode : 'single';
  const count = mode === 'single' ? 1 : Math.max(2, Math.min(8, Number(output.count) || 2));
  const aspectRatios = boundedList(output.aspect_ratios, 8).filter((ratio) => ASPECT_RATIOS.has(ratio));
  if (!aspectRatios.length) aspectRatios.push('1:1');
  const useCase = USE_CASES.has(input.use_case) ? input.use_case : 'general';
  const quality = QUALITY.has(output.quality || input.quality) ? (output.quality || input.quality) : 'quality';
  const modelPolicy = MODEL_POLICIES.has(input.model_policy) ? input.model_policy : 'auto';
  const source = input.source && typeof input.source === 'object' && !Array.isArray(input.source) ? input.source : {};
  for (const field of ['room_id', 'campaign_id', 'action_id']) if (source[field] && !UUID.test(String(source[field]))) throw visualError(`${field} must be a UUID`);
  return { instruction, useCase, mode, count, aspectRatios, quality, modelPolicy, source };
}

export function visualGenerationIdempotencyKey({ orgId, userId, request, supplied }) {
  const explicit = clean(supplied, 180);
  if (explicit) return explicit;
  return crypto.createHash('sha256').update(JSON.stringify({ orgId, userId, instruction: request.instruction, useCase: request.useCase, source: request.source, output: [request.mode, request.count, request.aspectRatios] })).digest('hex');
}

async function emit(prisma, jobId, { eventKey, stage, status = 'running', progress, message, data = {} }) {
  const normalizedProgress = Math.max(0, Math.min(100, Number(progress ?? PROGRESS[stage] ?? 0)));
  return prisma.visualGenerationEvent.upsert({
    where: { jobId_eventKey: { jobId, eventKey: clean(eventKey, 120) } },
    create: { jobId, eventKey: clean(eventKey, 120), stage: clean(stage, 48), status: clean(status, 24), progress: normalizedProgress, message: clean(message, 300), data },
    update: { stage: clean(stage, 48), status: clean(status, 24), progress: normalizedProgress, message: clean(message, 300), data },
  });
}

async function sendToWorkflow(job, fetchImpl = globalThis.fetch) {
  if (process.env.VISUAL_GENERATION_WORKFLOW_ENABLED === 'false') throw visualError('visual generation workflow is disabled', 503, 'visual_generation_disabled');
  const endpoint = clean(process.env.HIVEMIND_VISUAL_GENERATION_URL || 'https://hivemind-visual-generation.amarsai2005.workers.dev', 1000).replace(/\/$/, '');
  const secret = clean(process.env.HIVEMIND_VISUAL_GENERATION_SECRET || process.env.HIVEMIND_VISUAL_WORKFLOW_SECRET, 1000);
  if (!endpoint || !secret) throw visualError('visual generation workflow is not configured', 503, 'visual_generation_unconfigured');
  const trigger = { job_id: job.id, org_id: job.orgId, user_id: job.userId, processing_version: 1, requested_at: new Date().toISOString() };
  const response = await fetchImpl(`${endpoint}/start`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(trigger), signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw visualError(body.error || `visual workflow returned ${response.status}`, response.status >= 500 ? 503 : response.status, 'visual_generation_admission_failed');
  return body;
}

export async function createVisualGenerationJob({ prisma, orgId, userId, input, idempotencyKey, fetchImpl } = {}) {
  if (!prisma || !UUID.test(String(orgId)) || !UUID.test(String(userId))) throw visualError('authenticated tenant context is required', 401, 'visual_generation_unauthorized');
  const membership = await prisma.userOrganization.findFirst({ where: { orgId, userId, isActive: true }, select: { userId: true } });
  if (!membership) throw visualError('active organization membership is required', 403, 'visual_generation_forbidden');
  const request = normalizeVisualGenerationRequest(input);
  const key = visualGenerationIdempotencyKey({ orgId, userId, request, supplied: idempotencyKey || input?.idempotency_key });
  let job = await prisma.visualGenerationJob.findUnique({ where: { orgId_userId_idempotencyKey: { orgId, userId, idempotencyKey: key } } });
  let replayed = Boolean(job);
  if (!job) {
    try {
      job = await prisma.visualGenerationJob.create({ data: {
        orgId, userId, roomId: request.source.room_id || null, campaignId: request.source.campaign_id || null, actionId: request.source.action_id || null,
        idempotencyKey: key, instruction: request.instruction, useCase: request.useCase, outputMode: request.mode, requestedCount: request.count,
        aspectRatios: request.aspectRatios, quality: request.quality, modelPolicy: request.modelPolicy, source: request.source,
        status: 'queued', currentStage: 'queued', progress: 0, heartbeatAt: new Date(),
      } });
      await emit(prisma, job.id, { eventKey: 'queued', stage: 'queued', status: 'queued', progress: 0, message: 'Visual production request queued.' });
    } catch (error) {
      // Concurrent retries can both observe a miss. The unique tenant/user/key
      // constraint elects one job; losers re-read it instead of surfacing a 500.
      if (error?.code !== 'P2002') throw error;
      job = await prisma.visualGenerationJob.findUnique({ where: { orgId_userId_idempotencyKey: { orgId, userId, idempotencyKey: key } } });
      if (!job) throw error;
      replayed = true;
    }
  }
  if (!TERMINAL.has(job.status) && !job.workflowInstanceId) {
    try {
      const scheduled = await sendToWorkflow(job, fetchImpl);
      job = await prisma.visualGenerationJob.update({ where: { id: job.id }, data: { workflowInstanceId: scheduled.instance_id || null, heartbeatAt: new Date() } });
      await emit(prisma, job.id, { eventKey: 'workflow_queued', stage: 'queued', status: 'queued', progress: 1, message: 'Cloudflare accepted the durable workflow.', data: { workflow_instance_id: scheduled.instance_id || null } });
    } catch (error) {
      await emit(prisma, job.id, { eventKey: 'workflow_admission_waiting', stage: 'queued', status: 'waiting', progress: 1, message: 'Workflow admission will be retried safely.', data: { code: error.code || 'workflow_admission_failed' } });
      throw Object.assign(error, { jobId: job.id });
    }
  }
  const events = await prisma.visualGenerationEvent.findMany({ where: { jobId: job.id }, orderBy: { id: 'asc' } });
  return { ...publicJob(job, events), replayed };
}

export async function getVisualGenerationJob({ prisma, orgId, userId, jobId, afterEventId = 0 } = {}) {
  if (!UUID.test(String(jobId))) throw visualError('invalid job id');
  const job = await prisma.visualGenerationJob.findFirst({ where: { id: jobId, orgId, userId } });
  if (!job) throw visualError('visual generation job not found', 404, 'visual_generation_not_found');
  const after = BigInt(Math.max(0, Number(afterEventId) || 0));
  const events = await prisma.visualGenerationEvent.findMany({ where: { jobId, id: { gt: after } }, orderBy: { id: 'asc' }, take: 100 });
  return publicJob(job, events);
}

export class DurableVisualGenerationLifecycle {
  constructor({ prisma } = {}) { this.prisma = prisma; }

  async context({ job_id: jobId, workflow_instance_id: workflowInstanceId }) {
    const job = await this.prisma.visualGenerationJob.findUnique({ where: { id: String(jobId || '') } });
    if (!job) throw visualError('visual generation job not found', 404, 'visual_generation_not_found');
    const membership = await this.prisma.userOrganization.findFirst({ where: { orgId: job.orgId, userId: job.userId, isActive: true }, select: { userId: true } });
    if (!membership) throw visualError('visual generation tenant access denied', 403, 'visual_generation_forbidden');
    const org = await this.prisma.organization.findUnique({ where: { id: job.orgId }, select: { name: true, slug: true, companyProfile: true } });
    const room = job.roomId ? await this.prisma.hyperRoom.findFirst({ where: { id: job.roomId, orgId: job.orgId, userId: job.userId }, select: { name: true, goal: true, agentConnectors: true } }) : null;
    const brand = await this.prisma.visualIntelligenceRun.findFirst({ where: { orgId: job.orgId, status: 'completed', deliverable: 'brand_dna_v1' }, orderBy: { finishedAt: 'desc' }, select: { id: true, artifact: true, processingVersion: true, finishedAt: true } });
    const company = { name: org?.name || '', profile: org?.companyProfile || {}, room_name: room?.name || null, room_goal: room?.goal || null, room_company: room?.agentConnectors?._company || null };
    const brandRef = brand ? { run_id: brand.id, version: brand.artifact?.version || `visual-intelligence-v${brand.processingVersion}`, generated_at: brand.finishedAt, visual_generation_brief: brand.artifact?.visual_generation_brief || {}, analysis: brand.artifact?.analysis || {}, evidence: brand.artifact?.evidence || [] } : {};
    const updated = await this.prisma.visualGenerationJob.update({ where: { id: job.id }, data: { workflowInstanceId: workflowInstanceId || job.workflowInstanceId, status: 'running', currentStage: 'context', progress: PROGRESS.context, companyContext: company, brandDnaRef: brandRef, startedAt: job.startedAt || new Date(), heartbeatAt: new Date() } });
    await emit(this.prisma, job.id, { eventKey: 'context', stage: 'context', progress: PROGRESS.context, message: brand ? 'Company context and verified Brand DNA loaded.' : 'Company context loaded; no verified Brand DNA was available.', data: { brand_dna_available: Boolean(brand) } });
    return {
      job: publicJob(updated),
      request: { instruction: job.instruction, use_case: job.useCase, output: { mode: job.outputMode, count: job.requestedCount, aspect_ratios: job.aspectRatios }, quality: job.quality, model_policy: job.modelPolicy },
      company_context: company,
      brand_dna: brandRef,
      // This endpoint is authenticated with the workflow secret and resolves
      // the tenant's existing browser-rendered homepage capture. It is only a
      // fallback when a completed Brand DNA run is unavailable.
      website_visual_reference: brand ? null : { kind: 'homepage_screenshot', path: `/internal/visual-generation/reference?job_id=${encodeURIComponent(job.id)}` },
    };
  }

  async record(input = {}) {
    const job = await this.prisma.visualGenerationJob.findUnique({ where: { id: String(input.job_id || '') } });
    if (!job) throw visualError('visual generation job not found', 404, 'visual_generation_not_found');
    if (TERMINAL.has(job.status)) return publicJob(job);
    const stage = clean(input.stage, 48); const progress = Math.max(job.progress, Math.min(99, Number(input.progress ?? PROGRESS[stage] ?? job.progress)));
    const data = input.data && typeof input.data === 'object' ? input.data : {};
    const updated = await this.prisma.visualGenerationJob.update({ where: { id: job.id }, data: { status: 'running', currentStage: stage, progress, heartbeatAt: new Date(), ...(stage === 'art_direction' && data.production_spec ? { productionSpec: data.production_spec } : {}) } });
    await emit(this.prisma, job.id, { eventKey: clean(input.event_key || stage, 120), stage, progress, message: clean(input.message || `Visual production: ${stage}`, 300), data });
    return publicJob(updated);
  }

  async complete(input = {}) {
    const job = await this.prisma.visualGenerationJob.findUnique({ where: { id: String(input.job_id || '') } });
    if (!job) throw visualError('visual generation job not found', 404, 'visual_generation_not_found');
    if (job.status === 'completed') {
      await emit(this.prisma, job.id, { eventKey: 'completed', stage: 'completed', status: 'completed', progress: 100, message: `${job.requestedCount} visual asset${job.requestedCount === 1 ? '' : 's'} ready for review.`, data: { asset_count: job.requestedCount } });
      return publicJob(job);
    }
    const assets = Array.isArray(input.assets) ? input.assets : [];
    if (assets.length !== job.requestedCount) throw visualError('workflow returned an incomplete asset set', 422, 'visual_generation_incomplete');
    const prefix = `org/${job.orgId}/visual-generation/${job.id}/`;
    if (assets.some((asset) => !clean(asset?.r2_key, 600).startsWith(prefix) || !clean(asset?.content_hash, 128))) throw visualError('workflow returned invalid asset receipts', 422, 'visual_generation_invalid_receipt');
    const now = new Date();
    const completed = await this.prisma.visualGenerationJob.update({ where: { id: job.id }, data: { status: 'completed', currentStage: 'completed', progress: 100, assets, productionSpec: input.production_spec || job.productionSpec || {}, terminalReason: 'assets_ready_for_approval', finishedAt: now, heartbeatAt: now } });
    await emit(this.prisma, job.id, { eventKey: 'completed', stage: 'completed', status: 'completed', progress: 100, message: `${assets.length} visual asset${assets.length === 1 ? '' : 's'} ready for review.`, data: { asset_count: assets.length } });
    return publicJob(completed);
  }

  async fail(input = {}) {
    const job = await this.prisma.visualGenerationJob.findUnique({ where: { id: String(input.job_id || '') } });
    if (!job) throw visualError('visual generation job not found', 404, 'visual_generation_not_found');
    if (job.status === 'failed') {
      await emit(this.prisma, job.id, { eventKey: 'failed', stage: job.currentStage, status: 'failed', progress: 100, message: 'Visual production failed after durable retries.', data: { failure_code: job.terminalReason || 'visual_generation_failed' } });
      return publicJob(job);
    }
    if (TERMINAL.has(job.status)) return publicJob(job);
    const now = new Date(); const reason = clean(input.failure_code || 'visual_generation_failed', 180);
    const failed = await this.prisma.visualGenerationJob.update({ where: { id: job.id }, data: { status: 'failed', currentStage: clean(input.failed_stage || job.currentStage, 48), progress: 100, error: { code: reason, message: clean(input.message || reason, 1000) }, terminalReason: reason, finishedAt: now, heartbeatAt: now } });
    await emit(this.prisma, job.id, { eventKey: 'failed', stage: failed.currentStage, status: 'failed', progress: 100, message: 'Visual production failed after durable retries.', data: { failure_code: reason } });
    return publicJob(failed);
  }
}

export async function readVisualAsset({ prisma, orgId, userId, jobId, assetId, fetchImpl = globalThis.fetch } = {}) {
  const job = await prisma.visualGenerationJob.findFirst({ where: { id: jobId, orgId, userId } });
  if (!job) throw visualError('visual generation job not found', 404, 'visual_generation_not_found');
  const asset = (Array.isArray(job.assets) ? job.assets : []).find((row) => row.asset_id === assetId);
  if (!asset?.r2_key) throw visualError('visual asset not found', 404, 'visual_asset_not_found');
  const endpoint = clean(process.env.HIVEMIND_VISUAL_GENERATION_URL || 'https://hivemind-visual-generation.amarsai2005.workers.dev', 1000).replace(/\/$/, ''); const secret = clean(process.env.HIVEMIND_VISUAL_GENERATION_SECRET || process.env.HIVEMIND_VISUAL_WORKFLOW_SECRET, 1000);
  if (!endpoint || !secret) throw visualError('visual asset reader is not configured', 503, 'visual_generation_unconfigured');
  const response = await fetchImpl(`${endpoint}/artifact?key=${encodeURIComponent(asset.r2_key)}`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw visualError(`visual asset read failed with ${response.status}`, response.status >= 500 ? 503 : response.status, 'visual_asset_read_failed');
  return { asset, response };
}
