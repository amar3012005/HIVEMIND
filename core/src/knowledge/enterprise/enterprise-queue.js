/**
 * Enterprise upload worker queue.
 *
 * Offloads heavy document processing (parsing, detection, extraction,
 * chunking, embedding, graph writes) from the Node.js API request thread.
 *
 * Uses a simple BullMQ-style in-process queue backed by the existing Redis.
 * Upgrade to full BullMQ / worker process for production scale.
 */

import { EventEmitter } from 'events';

// In-memory queue for current version — side-steps external deps.
// Replace with Bull/BullMQ when throughput demands it.

class EnterpriseUploadQueue extends EventEmitter {
  constructor({ concurrency = 2, pipeline } = {}) {
    super();
    this.concurrency = concurrency;
    this.active = 0;
    this.pending = [];
    this.jobs = new Map();
    this.pipeline = pipeline; // { parse, detect, extract, chunk, ingest }
  }

  /**
   * Enqueue an enterprise document processing job.
   *
   * @param {object} job
   * @param {string} job.tempPath
   * @param {string} job.filename
   * @param {string} job.uploadId
   * @param {string} job.userId
   * @param {string} job.orgId
   * @param {string[]} [job.tags]
   * @param {string} [job.scope]
   * @param {boolean} [job.smartExtract=true]
   * @returns {{ jobId: string, status: 'queued' }}
   */
  enqueue(job) {
    const jobId = job.uploadId || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      jobId,
      status: 'queued',
      progress: 'enqueued',
      stage: null,
      startedAt: null,
      completedAt: null,
      memoryCount: 0,
      error: null,
      ...job,
    };
    this.jobs.set(jobId, record);
    this.pending.push(jobId);
    this._drain();
    return { jobId, status: 'queued' };
  }

  /**
   * Get current job status.
   */
  status(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      memoryCount: job.memoryCount,
      error: job.error,
    };
  }

  // ── Internal dispatch ──────────────────────────────────────────

  async _drain() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const jobId = this.pending.shift();
      const job = this.jobs.get(jobId);
      if (!job) continue;
      this.active++;
      this._process(job).finally(() => {
        this.active--;
        this._drain();
      });
    }
  }

  async _process(job) {
    try {
      this._update(job.jobId, { status: 'running', progress: 'parsing', stage: 'parse', startedAt: new Date().toISOString() });

      // Stage 1: Parse
      const parseOutput = await this.pipeline.parse(job.tempPath, job.filename, { smart: job.smartExtract !== false });
      if (parseOutput.error && job.smartExtract !== false) {
        console.warn(`[enterprise-queue] smart parse failed for ${job.filename}: ${parseOutput.error}, falling back`);
        const fallbackParse = await this.pipeline.parse(job.tempPath, job.filename, { smart: false });
        Object.assign(parseOutput, fallbackParse);
      }

      this._update(job.jobId, { progress: 'classifying', stage: 'detect' });

      // Stage 2: Detect type
      let detection = await this.pipeline.detect(parseOutput, { filename: job.filename });
      if (!detection || typeof detection !== 'object') {
        detection = { type: 'general', confidence: 0.0, reasoning: 'detector returned null' };
      } else if (typeof detection.confidence !== 'number' || detection.confidence < 0.3) {
        detection.type = 'general';
      }

      this._update(job.jobId, { progress: 'extracting', stage: 'extract' });

      // Stage 3: Extract schema
      const schema = await this.pipeline.extract(parseOutput, detection.type, { filename: job.filename });

      this._update(job.jobId, { progress: 'chunking', stage: 'chunk' });

      // Stage 4: Build canonical payloads
      const payloads = await this.pipeline.chunk(schema, parseOutput, {
        uploadId: job.uploadId,
        userId: job.userId,
        orgId: job.orgId,
        tags: job.tags,
        scope: job.scope,
        filename: job.filename,
      });

      this._update(job.jobId, { progress: 'ingesting', stage: 'ingest' });

      // Stage 5: Ingest — parent first so we can backfill parent_schema_id
      // on every child chunk. Without this children carry parent_schema_id=null
      // and hierarchical retrieval (parent expansion on child hit) breaks.
      let results;
      if (payloads && payloads.parent && Array.isArray(payloads.chunks)) {
        const parentResult = await this.pipeline.ingest({ parent: payloads.parent, chunks: [] }, {
          userId: job.userId,
          orgId: job.orgId,
        });
        const parentId = parentResult?.parent_id
          || parentResult?.memory_id
          || (Array.isArray(parentResult?.memory_ids) ? parentResult.memory_ids[0] : null)
          || (Array.isArray(parentResult) ? parentResult[0]?.id : null);
        if (parentId) {
          for (const child of payloads.chunks) {
            child.metadata = child.metadata || {};
            child.metadata.parent_schema_id = parentId;
          }
        }
        const childResult = await this.pipeline.ingest({ parent: null, chunks: payloads.chunks }, {
          userId: job.userId,
          orgId: job.orgId,
        });
        results = {
          parent: parentResult,
          children: childResult,
          memories_created: 1 + (Array.isArray(childResult?.memory_ids) ? childResult.memory_ids.length : payloads.chunks.length),
        };
      } else {
        results = await this.pipeline.ingest(payloads, {
          userId: job.userId,
          orgId: job.orgId,
        });
      }

      const memoryCount = Array.isArray(results) ? results.length : (results?.memories_created || 0);

      this._update(job.jobId, {
        status: 'completed',
        progress: 'done',
        stage: 'done',
        completedAt: new Date().toISOString(),
        memoryCount,
      });
    } catch (err) {
      console.error(`[enterprise-queue] job ${job.jobId} failed:`, err.message);
      this._update(job.jobId, {
        status: 'failed',
        progress: 'failed',
        stage: 'error',
        error: err.message,
        completedAt: new Date().toISOString(),
      });
    }
  }

  _update(jobId, patch) {
    const job = this.jobs.get(jobId);
    if (job) Object.assign(job, patch);
    this.emit('update', { jobId, ...patch });
  }
}

let __enterpriseQueue = null;

/**
 * Singleton accessor.
 */
export function getEnterpriseQueue(pipeline) {
  if (!__enterpriseQueue) {
    __enterpriseQueue = new EnterpriseUploadQueue({
      concurrency: Number(process.env.ENTERPRISE_QUEUE_CONCURRENCY) || 2,
      pipeline,
    });
  }
  return __enterpriseQueue;
}
