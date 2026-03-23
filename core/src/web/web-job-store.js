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
}
