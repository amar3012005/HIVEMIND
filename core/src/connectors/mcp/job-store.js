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

function matchesScope(record, { user_id, org_id, endpoint_name, status } = {}) {
  if (user_id && record.user_id !== user_id) return false;
  if (org_id && record.org_id !== org_id) return false;
  if (endpoint_name && record.endpoint_name !== endpoint_name) return false;
  if (status && record.status !== status) return false;
  return true;
}

export class MCPConnectorJobStore {
  constructor({ filePath }) {
    this.filePath = filePath;
  }

  create(record) {
    const now = new Date().toISOString();
    const jobs = readJson(this.filePath);
    const job = {
      id: record.id || crypto.randomUUID(),
      status: 'pending',
      attempt_count: 0,
      accepted_jobs: [],
      error: null,
      created_at: now,
      updated_at: now,
      ...record,
    };
    jobs.push(job);
    writeJson(this.filePath, jobs);
    return job;
  }

  update(jobId, patch) {
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

  get(jobId, scope = {}) {
    const jobs = readJson(this.filePath);
    return jobs.find(job => job.id === jobId && matchesScope(job, scope)) || null;
  }

  list(scope = {}, { limit = 50 } = {}) {
    const jobs = readJson(this.filePath)
      .filter(job => matchesScope(job, scope))
      .sort((left, right) => new Date(right.updated_at) - new Date(left.updated_at));
    return jobs.slice(0, limit);
  }
}
