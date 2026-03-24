import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';

function ensureFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '[]\n', 'utf8');
  }
}

function readJson(filePath) {
  ensureFile(filePath);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

function writeJson(filePath, data) {
  ensureFile(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function matchesScope(record, scope) {
  if (scope.userId && record.userId !== scope.userId) return false;
  if (scope.orgId && record.orgId !== scope.orgId) return false;
  return true;
}

export class WebJobStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(process.cwd(), 'data', 'web-jobs.json');
  }

  async create({ type, params, userId, orgId }) {
    const now = new Date().toISOString();
    const jobs = readJson(this.filePath);
    const job = {
      id: crypto.randomUUID(),
      type,
      status: 'queued',
      params,
      results: null,
      userId,
      orgId,
      runtime_used: null,
      fallback_applied: false,
      duration_ms: null,
      pages_processed: 0,
      error: null,
      created_at: now,
      updated_at: now,
    };
    jobs.push(job);
    writeJson(this.filePath, jobs);
    return job;
  }

  async update(jobId, patch) {
    const jobs = readJson(this.filePath);
    const next = jobs.map(job => {
      if (job.id !== jobId) return job;
      return {
        ...job,
        ...patch,
        updated_at: new Date().toISOString(),
      };
    });
    writeJson(this.filePath, next);
    return next.find(job => job.id === jobId) || null;
  }

  async get(jobId, scope = {}) {
    const jobs = readJson(this.filePath);
    return jobs.find(job => job.id === jobId && matchesScope(job, scope)) || null;
  }

  async list(scope = {}, { limit = 50, type } = {}) {
    let jobs = readJson(this.filePath)
      .filter(job => matchesScope(job, scope));

    if (type) {
      jobs = jobs.filter(job => job.type === type);
    }

    jobs.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    return jobs.slice(0, limit);
  }

  async getUsage(userId) {
    const jobs = readJson(this.filePath);
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const todayJobs = jobs.filter(
      job => job.userId === userId && job.created_at >= startOfDay
    );

    const searchRequests = todayJobs.filter(j => j.type === 'search').length;
    const crawlPages = todayJobs
      .filter(j => j.type === 'crawl')
      .reduce((sum, j) => sum + (j.pages_processed || 0), 0);

    return {
      web_search_requests: searchRequests,
      web_crawl_pages: crawlPages,
    };
  }

  /**
   * Retry a failed job by creating a new job with the same params.
   * Only jobs with status 'failed' can be retried.
   */
  async retry(jobId, scope = {}) {
    const jobs = readJson(this.filePath);
    const original = jobs.find(job => job.id === jobId && matchesScope(job, scope));

    if (!original) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (original.status !== 'failed') {
      throw new Error(`Only failed jobs can be retried (current status: ${original.status})`);
    }

    const now = new Date().toISOString();
    const retryJob = {
      id: crypto.randomUUID(),
      type: original.type,
      status: 'queued',
      params: original.params,
      results: null,
      userId: original.userId,
      orgId: original.orgId,
      runtime_used: null,
      fallback_applied: false,
      duration_ms: null,
      pages_processed: 0,
      error: null,
      retried_from: original.id,
      created_at: now,
      updated_at: now,
    };

    jobs.push(retryJob);
    writeJson(this.filePath, jobs);
    return retryJob;
  }

  /**
   * Monthly usage accounting for a user.
   * Returns search request and crawl page counts for the current calendar month
   * compared against configurable monthly limits.
   */
  async getMonthlyUsage(userId) {
    const jobs = readJson(this.filePath);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthStartISO = monthStart.toISOString();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const resetAt = nextMonth.toISOString();
    const monthLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const monthJobs = jobs.filter(
      job => job.userId === userId && job.created_at >= monthStartISO
    );

    const searchUsed = monthJobs.filter(j => j.type === 'search').length;
    const crawlUsed = monthJobs
      .filter(j => j.type === 'crawl')
      .reduce((sum, j) => sum + (j.pages_processed || 0), 0);

    const searchLimit = parseInt(process.env.HIVEMIND_WEB_SEARCH_MONTHLY_LIMIT, 10) || 3000;
    const crawlLimit = parseInt(process.env.HIVEMIND_WEB_CRAWL_MONTHLY_LIMIT, 10) || 15000;

    return {
      web_search_requests: { used: searchUsed, limit: searchLimit },
      web_crawl_pages: { used: crawlUsed, limit: crawlLimit },
      month: monthLabel,
      reset_at: resetAt,
    };
  }

  /**
   * Admin metrics aggregated across ALL jobs (not scoped).
   */
  async getMetrics(orgId) {
    let jobs = readJson(this.filePath);
    if (orgId) jobs = jobs.filter(j => j.orgId === orgId);
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const total_jobs = jobs.length;
    const succeeded = jobs.filter(j => j.status === 'succeeded').length;
    const failed = jobs.filter(j => j.status === 'failed').length;
    const queued = jobs.filter(j => j.status === 'queued').length;
    const running = jobs.filter(j => j.status === 'running').length;
    const success_rate = total_jobs > 0
      ? Math.round((succeeded / total_jobs) * 10000) / 100
      : 0;

    // Duration stats from succeeded jobs
    const durations = jobs
      .filter(j => j.status === 'succeeded' && typeof j.duration_ms === 'number')
      .map(j => j.duration_ms)
      .sort((a, b) => a - b);

    const avg_duration_ms = durations.length > 0
      ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
      : 0;

    const p95_duration_ms = durations.length > 0
      ? durations[Math.floor(durations.length * 0.95)]
      : 0;

    // Top 5 error messages
    const errorCounts = {};
    for (const job of jobs) {
      if (job.error) {
        const msg = typeof job.error === 'string' ? job.error : JSON.stringify(job.error);
        errorCounts[msg] = (errorCounts[msg] || 0) + 1;
      }
    }
    const top_errors = Object.entries(errorCounts)
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Runtime distribution
    const runtime_distribution = { lightpanda: 0, fetch: 0, unknown: 0 };
    for (const job of jobs) {
      const rt = job.runtime_used;
      if (rt === 'lightpanda') runtime_distribution.lightpanda++;
      else if (rt === 'fetch') runtime_distribution.fetch++;
      else runtime_distribution.unknown++;
    }

    // Time-based counts
    const jobs_last_hour = jobs.filter(j => new Date(j.created_at).getTime() >= oneHourAgo).length;
    const jobs_last_24h = jobs.filter(j => new Date(j.created_at).getTime() >= oneDayAgo).length;

    const queue_depth = queued + running;

    return {
      total_jobs,
      succeeded,
      failed,
      queued,
      running,
      success_rate,
      avg_duration_ms,
      p95_duration_ms,
      top_errors,
      runtime_distribution,
      jobs_last_hour,
      jobs_last_24h,
      queue_depth,
    };
  }

  /**
   * Export daily usage breakdown within a date range, scoped by userId/orgId.
   * @param {object} scope - { userId, orgId }
   * @param {object} range - { from: ISO8601 string, to: ISO8601 string }
   */
  async exportUsage(scope = {}, { from, to } = {}) {
    const jobs = readJson(this.filePath);
    const fromDate = from ? new Date(from) : new Date(0);
    const toDate = to ? new Date(to) : new Date();

    // Normalize toDate to end of day
    toDate.setHours(23, 59, 59, 999);

    const filtered = jobs.filter(job => {
      if (!matchesScope(job, scope)) return false;
      const created = new Date(job.created_at);
      return created >= fromDate && created <= toDate;
    });

    // Group by date string (YYYY-MM-DD)
    const buckets = {};
    for (const job of filtered) {
      const date = job.created_at.slice(0, 10);
      if (!buckets[date]) {
        buckets[date] = { date, search_count: 0, crawl_count: 0, pages_total: 0 };
      }
      if (job.type === 'search') {
        buckets[date].search_count++;
      } else if (job.type === 'crawl') {
        buckets[date].crawl_count++;
        buckets[date].pages_total += job.pages_processed || 0;
      }
    }

    return Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Check soft and hard limits for a user (daily and monthly).
   * Soft limits are 80% of hard limits (advisory warnings).
   */
  async checkLimits(userId) {
    const jobs = readJson(this.filePath);
    const now = new Date();

    // Date boundaries
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Hard limits from env
    const dailySearchHard = parseInt(process.env.HIVEMIND_WEB_SEARCH_DAILY_LIMIT, 10) || 100;
    const dailyCrawlHard = parseInt(process.env.HIVEMIND_WEB_CRAWL_DAILY_LIMIT, 10) || 500;
    const monthlySearchHard = parseInt(process.env.HIVEMIND_WEB_SEARCH_MONTHLY_LIMIT, 10) || 3000;
    const monthlyCrawlHard = parseInt(process.env.HIVEMIND_WEB_CRAWL_MONTHLY_LIMIT, 10) || 15000;

    const userJobs = jobs.filter(j => j.userId === userId);

    const todayJobs = userJobs.filter(j => j.created_at >= startOfDay);
    const monthJobs = userJobs.filter(j => j.created_at >= startOfMonth);

    const dailySearchUsed = todayJobs.filter(j => j.type === 'search').length;
    const dailyCrawlUsed = todayJobs
      .filter(j => j.type === 'crawl')
      .reduce((sum, j) => sum + (j.pages_processed || 0), 0);
    const monthlySearchUsed = monthJobs.filter(j => j.type === 'search').length;
    const monthlyCrawlUsed = monthJobs
      .filter(j => j.type === 'crawl')
      .reduce((sum, j) => sum + (j.pages_processed || 0), 0);

    function buildBucket(used, hard) {
      const soft = Math.floor(hard * 0.8);
      return { used, soft, hard, exceeded: used >= hard };
    }

    return {
      daily: {
        search: buildBucket(dailySearchUsed, dailySearchHard),
        crawl: buildBucket(dailyCrawlUsed, dailyCrawlHard),
      },
      monthly: {
        search: buildBucket(monthlySearchUsed, monthlySearchHard),
        crawl: buildBucket(monthlyCrawlUsed, monthlyCrawlHard),
      },
    };
  }
}
