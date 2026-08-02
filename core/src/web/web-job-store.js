import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';

const MAX_LIST_LIMIT = 100;

function ensureFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]\n', 'utf8');
}

function readJson(filePath) {
  ensureFile(filePath);
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return []; }
}

function writeJson(filePath, data) {
  ensureFile(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function matchesScope(record, scope) {
  return (!scope.userId || record.userId === scope.userId)
    && (!scope.orgId || record.orgId === scope.orgId);
}

function iso(value) { return value ? new Date(value).toISOString() : null; }

function safeError(error) {
  if (!error) return { errorCode: null, errorMessage: null };
  if (typeof error === 'object') {
    return {
      errorCode: String(error.code || 'web_job_failed').slice(0, 80),
      errorMessage: String(error.message || error.error || 'Web Intelligence job failed').slice(0, 2000),
    };
  }
  return { errorCode: 'web_job_failed', errorMessage: String(error).slice(0, 2000) };
}

function toLegacy(row) {
  if (!row) return null;
  const request = row.request || {};
  const result = row.result ?? null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    params: request,
    results: result,
    progress: row.progress || [],
    partial_content: request.partial_content,
    partial_sources: request.partial_sources,
    userId: row.userId,
    orgId: row.orgId,
    idempotency_key: row.idempotencyKey || null,
    runtime_used: row.runtimeUsed || null,
    fallback_applied: Boolean(row.fallbackApplied),
    provider_attempts: row.providerAttempts || [],
    duration_ms: row.durationMs ?? null,
    pages_processed: row.pagesProcessed || 0,
    error: row.errorMessage || null,
    error_code: row.errorCode || null,
    retried_from: row.retriedFromId || null,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    completed_at: iso(row.completedAt),
  };
}

function fromLegacyPatch(patch) {
  const data = {};
  if ('status' in patch) data.status = patch.status;
  if ('results' in patch) data.result = patch.results;
  if ('progress' in patch) data.progress = patch.progress || [];
  if ('runtime_used' in patch) data.runtimeUsed = patch.runtime_used;
  if ('fallback_applied' in patch) data.fallbackApplied = Boolean(patch.fallback_applied);
  if ('duration_ms' in patch) data.durationMs = patch.duration_ms == null ? null : Number(patch.duration_ms);
  if ('pages_processed' in patch) data.pagesProcessed = Number(patch.pages_processed || 0);
  if ('provider_attempts' in patch) data.providerAttempts = patch.provider_attempts || [];
  if ('error' in patch) Object.assign(data, safeError(patch.error));
  if (['succeeded', 'failed', 'cancelled'].includes(patch.status)) data.completedAt = new Date();
  return data;
}

/**
 * Durable, tenant-scoped Web Intelligence job store.
 *
 * JSON fallback is retained only for non-production local development. A
 * configured Prisma client is always authoritative and every public server
 * instance supplies one. This preserves the legacy route shape while removing
 * file-backed production state and per-user accounting.
 */
export class WebJobStore {
  constructor(options = {}) {
    if (typeof options === 'string') options = { filePath: options };
    this.prisma = options.prisma || null;
    this.filePath = options.filePath || path.join(process.cwd(), 'data', 'web-jobs.json');
    this.allowFileFallback = !this.prisma && process.env.NODE_ENV !== 'production';
    if (!this.prisma && !this.allowFileFallback) {
      throw new Error('Web Intelligence requires durable database storage in production');
    }
  }

  async create({ type, params, userId, orgId, idempotencyKey = null, retriedFromId = null }) {
    if (this.prisma) {
      if (idempotencyKey) {
        const existing = await this.prisma.webIntelJob.findFirst({ where: { orgId, userId, idempotencyKey } });
        if (existing) return toLegacy(existing);
      }
      const row = await this.prisma.webIntelJob.create({
        data: { type, userId, orgId, request: params || {}, idempotencyKey, retriedFromId },
      });
      return toLegacy(row);
    }
    const now = new Date().toISOString();
    const jobs = readJson(this.filePath);
    const job = { id: crypto.randomUUID(), type, status: 'queued', params: params || {}, results: null, progress: [], userId, orgId, idempotency_key: idempotencyKey, runtime_used: null, fallback_applied: false, provider_attempts: [], duration_ms: null, pages_processed: 0, error: null, retried_from: retriedFromId, created_at: now, updated_at: now };
    jobs.push(job); writeJson(this.filePath, jobs); return job;
  }

  async update(jobId, patch) {
    if (this.prisma) {
      const existing = await this.prisma.webIntelJob.findUnique({ where: { id: jobId } });
      if (!existing) return null;
      const data = fromLegacyPatch(patch);
      // Partial research progress is request metadata, never a second hidden
      // result field. This keeps the durable schema compact and route-compatible.
      if ('partial_content' in patch || 'partial_sources' in patch || 'capability' in patch || 'capability_stage' in patch) {
        data.request = {
          ...(existing.request || {}),
          ...Object.fromEntries(Object.entries({
            partial_content: patch.partial_content,
            partial_sources: patch.partial_sources,
            capability: patch.capability,
            capability_stage: patch.capability_stage,
          }).filter(([, value]) => value !== undefined)),
        };
      }
      return toLegacy(await this.prisma.webIntelJob.update({ where: { id: jobId }, data }));
    }
    const jobs = readJson(this.filePath);
    const next = jobs.map((job) => job.id === jobId ? { ...job, ...patch, updated_at: new Date().toISOString() } : job);
    writeJson(this.filePath, next); return next.find((job) => job.id === jobId) || null;
  }

  async get(jobId, scope = {}) {
    if (this.prisma) return toLegacy(await this.prisma.webIntelJob.findFirst({ where: { id: jobId, ...scope } }));
    return readJson(this.filePath).find((job) => job.id === jobId && matchesScope(job, scope)) || null;
  }

  async list(scope = {}, { limit = 50, type } = {}) {
    const take = Math.max(1, Math.min(Number(limit) || 50, MAX_LIST_LIMIT));
    if (this.prisma) {
      return (await this.prisma.webIntelJob.findMany({ where: { ...scope, ...(type ? { type } : {}) }, orderBy: { updatedAt: 'desc' }, take })).map(toLegacy);
    }
    let jobs = readJson(this.filePath).filter((job) => matchesScope(job, scope) && (!type || job.type === type));
    jobs.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)); return jobs.slice(0, take);
  }

  async _all(scope = {}) {
    if (this.prisma) return (await this.prisma.webIntelJob.findMany({ where: scope })).map(toLegacy);
    return readJson(this.filePath).filter((job) => matchesScope(job, scope));
  }

  async getUsage(scope) {
    const normalized = typeof scope === 'string' ? { userId: scope } : scope;
    const jobs = await this._all(normalized || {});
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const today = jobs.filter((job) => new Date(job.created_at) >= start);
    return {
      web_search_requests: today.filter((job) => ['search', 'research'].includes(job.type)).length,
      web_crawl_pages: today.filter((job) => ['crawl', 'seo_audit'].includes(job.type)).reduce((sum, job) => sum + (job.pages_processed || 0), 0),
    };
  }

  async retry(jobId, scope = {}) {
    const original = await this.get(jobId, scope);
    if (!original) throw new Error('Job not found');
    if (original.status !== 'failed') throw new Error(`Only failed jobs can be retried (current status: ${original.status})`);
    return this.create({ type: original.type, params: original.params, userId: original.userId, orgId: original.orgId, retriedFromId: original.id });
  }

  async getMonthlyUsage(scope) {
    const normalized = typeof scope === 'string' ? { userId: scope } : scope;
    const jobs = await this._all(normalized || {});
    const now = new Date(); const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const current = jobs.filter((job) => new Date(job.created_at) >= monthStart);
    return {
      web_search_requests: { used: current.filter((job) => ['search', 'research'].includes(job.type)).length, limit: Number(process.env.HIVEMIND_WEB_SEARCH_MONTHLY_LIMIT || 3000) },
      web_crawl_pages: { used: current.filter((job) => ['crawl', 'seo_audit'].includes(job.type)).reduce((sum, job) => sum + (job.pages_processed || 0), 0), limit: Number(process.env.HIVEMIND_WEB_CRAWL_MONTHLY_LIMIT || 15000) },
      month: monthStart.toISOString().slice(0, 7), reset_at: nextMonth.toISOString(),
    };
  }

  async getMetrics(orgId) {
    const jobs = await this._all(orgId ? { orgId } : {});
    const now = Date.now(); const durations = jobs.filter((j) => j.status === 'succeeded' && Number.isFinite(j.duration_ms)).map((j) => j.duration_ms).sort((a, b) => a - b);
    const count = (status) => jobs.filter((job) => job.status === status).length;
    const errors = new Map();
    for (const job of jobs) if (job.error) errors.set(job.error, (errors.get(job.error) || 0) + 1);
    const runtime_distribution = jobs.reduce((acc, job) => { const key = job.runtime_used || 'unknown'; acc[key] = (acc[key] || 0) + 1; return acc; }, {});
    const succeeded = count('succeeded'); const total_jobs = jobs.length;
    return { total_jobs, succeeded, failed: count('failed'), queued: count('queued'), running: count('running'), success_rate: total_jobs ? Math.round((succeeded / total_jobs) * 10000) / 100 : 0, avg_duration_ms: durations.length ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length) : 0, p95_duration_ms: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0, top_errors: [...errors.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count).slice(0, 5), runtime_distribution, jobs_last_hour: jobs.filter((job) => new Date(job.created_at).getTime() >= now - 3_600_000).length, jobs_last_24h: jobs.filter((job) => new Date(job.created_at).getTime() >= now - 86_400_000).length, queue_depth: count('queued') + count('running') };
  }

  async exportUsage(scope = {}, { from, to } = {}) {
    const jobs = await this._all(scope);
    const fromDate = from ? new Date(from) : new Date(0); const toDate = to ? new Date(to) : new Date(); toDate.setUTCHours(23, 59, 59, 999);
    const buckets = new Map();
    for (const job of jobs) {
      const created = new Date(job.created_at); if (created < fromDate || created > toDate) continue;
      const date = job.created_at.slice(0, 10); const bucket = buckets.get(date) || { date, search_count: 0, crawl_count: 0, pages_total: 0 };
      if (['search', 'research'].includes(job.type)) bucket.search_count += 1;
      if (['crawl', 'seo_audit'].includes(job.type)) { bucket.crawl_count += 1; bucket.pages_total += job.pages_processed || 0; }
      buckets.set(date, bucket);
    }
    return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  async checkLimits(scope) {
    const normalized = typeof scope === 'string' ? { userId: scope } : scope;
    const daily = await this.getUsage(normalized); const monthly = await this.getMonthlyUsage(normalized);
    const bucket = (used, hard) => ({ used, soft: Math.floor(hard * 0.8), hard, exceeded: used >= hard });
    return { daily: { search: bucket(daily.web_search_requests, Number(process.env.HIVEMIND_WEB_SEARCH_DAILY_LIMIT || 100)), crawl: bucket(daily.web_crawl_pages, Number(process.env.HIVEMIND_WEB_CRAWL_DAILY_LIMIT || 500)) }, monthly: { search: bucket(monthly.web_search_requests.used, monthly.web_search_requests.limit), crawl: bucket(monthly.web_crawl_pages.used, monthly.web_crawl_pages.limit) } };
  }

  async settleUsage({ orgId, userId, jobId, metric, amount = 1, metadata = {} }) {
    if (!this.prisma) return { settled: true, fallback: true };
    try {
      await this.prisma.webIntelUsageSettlement.create({ data: { orgId, userId, jobId, metric, amount: BigInt(amount), metadata } });
      return { settled: true };
    } catch (error) {
      if (error?.code === 'P2002') return { settled: false, duplicate: true };
      throw error;
    }
  }
}
