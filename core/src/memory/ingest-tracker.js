/**
 * In-memory ingest job tracker.
 * Tracks progress of async memory ingestion for status polling.
 * Jobs expire after 10 minutes to prevent unbounded growth.
 */

const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

export class IngestTracker {
  constructor() {
    this._jobs = new Map();
    // Cleanup every 5 minutes
    this._cleanupInterval = setInterval(() => this._cleanup(), 5 * 60 * 1000);
    // Allow the timer to not block process exit
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  createJob(jobId, metadata = {}) {
    const job = {
      id: jobId,
      status: 'queued',
      memoryId: null,
      progress: 0,
      metadata,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    this._jobs.set(jobId, job);
    return job;
  }

  updateJob(jobId, updates) {
    const job = this._jobs.get(jobId);
    if (!job) return null;
    Object.assign(job, updates, { updatedAt: new Date().toISOString() });
    if (updates.status === 'indexed' || updates.status === 'failed') {
      job.completedAt = new Date().toISOString();
    }
    return job;
  }

  getJob(jobId) {
    return this._jobs.get(jobId) || null;
  }

  getJobsByUser(userId, limit = 20) {
    const jobs = [];
    for (const job of this._jobs.values()) {
      if (job.metadata?.userId === userId) jobs.push(job);
    }
    return jobs
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, limit);
  }

  _cleanup() {
    const now = Date.now();
    for (const [id, job] of this._jobs) {
      if (now - new Date(job.startedAt).getTime() > EXPIRY_MS) {
        this._jobs.delete(id);
      }
    }
  }

  destroy() {
    clearInterval(this._cleanupInterval);
  }
}
