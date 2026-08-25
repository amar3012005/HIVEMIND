/**
 * Enterprise upload worker queue.
 *
 * Offloads heavy document processing (parsing, detection, extraction,
 * chunking, embedding, graph writes) from the Node.js API request thread.
 *
 * Uses BullMQ when Redis is reachable (jobs survive process restarts);
 * falls back to in-memory EventEmitter queue when probe fails. Same
 * resilience pattern as src/ingestion/queue.js.
 */

import { EventEmitter } from 'events';

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

// ─── BullMQ-backed enterprise queue (persistent) ─────────────────

// Prefer REDIS_URL (Coolify's authoritative host+password+db). REDIS_PASSWORD
// is often UNSET while the password lives only in REDIS_URL — reading
// REDIS_PASSWORD alone yields undefined → "NOAUTH" → silent fallback.
function resolveRedisConn() {
  let urlHost; let urlPort; let urlPassword; let urlUsername; let urlDb;
  if (process.env.REDIS_URL) {
    try {
      const u = new URL(process.env.REDIS_URL);
      urlHost = u.hostname;
      urlPort = Number(u.port || 6379);
      urlPassword = u.password ? decodeURIComponent(u.password) : undefined;
      urlUsername = u.username ? decodeURIComponent(u.username) : undefined;
      urlDb = (u.pathname && u.pathname.length > 1) ? (Number(u.pathname.slice(1)) || 0) : 0;
    } catch { /* malformed — fall back to discrete vars */ }
  }
  const port = urlPort || Number(process.env.REDIS_PORT || 6379);
  const password = urlPassword !== undefined ? urlPassword : (process.env.REDIS_PASSWORD || undefined);
  const username = urlUsername;
  const db = urlDb || 0;
  const primary = urlHost || process.env.REDIS_HOST || 'localhost';
  const alts = [
    process.env.REDIS_HOST,
    ...(process.env.REDIS_HOST_FALLBACKS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ].filter(Boolean).filter((h) => h !== primary);
  return { candidates: [primary, ...alts], port, password, username, db };
}

async function probeRedisHost() {
  const { candidates, port, password, username } = resolveRedisConn();
  let IORedis;
  try {
    IORedis = (await import('ioredis')).default;
  } catch {
    return null;
  }
  for (const host of candidates) {
    const probe = new IORedis({
      host,
      port,
      password,
      username,
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    probe.on('error', () => {});
    try {
      await probe.connect();
      await probe.ping();
      try { await probe.quit(); } catch {}
      return host;
    } catch {
      try { await probe.quit(); } catch {}
      try { probe.disconnect(); } catch {}
    }
  }
  return null;
}

class BullMQEnterpriseQueue extends EventEmitter {
  constructor({ concurrency, pipeline, host }) {
    super();
    this.concurrency = concurrency;
    this.pipeline = pipeline;
    this.host = host;
    this.jobs = new Map(); // local status cache so status() works without round-trip
    this._init();
  }

  async _init() {
    const [{ Queue, Worker }, IORedisMod] = await Promise.all([
      import('bullmq'),
      import('ioredis'),
    ]);
    const IORedis = IORedisMod.default;
    const { port, password, username, db } = resolveRedisConn();
    const connection = new IORedis({
      host: this.host,
      port,
      password,
      username,
      db,
      maxRetriesPerRequest: null,
    });
    connection.on('error', (err) => {
      console.warn('[enterprise-queue] Redis connection error:', err.message);
    });
    this.queue = new Queue('hivemind-enterprise', { connection });
    this.worker = new Worker('hivemind-enterprise', async (job) => {
      const record = this.jobs.get(job.id) || { jobId: job.id, ...job.data };
      this.jobs.set(job.id, record);
      return await runEnterpriseJob(this.pipeline, record, (patch) => this._update(record.jobId, patch));
    }, {
      connection,
      concurrency: this.concurrency,
    });
    this.worker.on('failed', (job, err) => this._update(job?.id, { status: 'failed', stage: 'error', error: err?.message }));
    this.worker.on('completed', (job, result) => this._update(job?.id, { status: 'completed', progress: 'done', stage: 'done', memoryCount: result?.memoryCount || 0 }));
  }

  async enqueue(job) {
    const jobId = job.uploadId || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      jobId, status: 'queued', progress: 'enqueued', stage: null, startedAt: null, completedAt: null, memoryCount: 0, error: null, ...job,
    };
    this.jobs.set(jobId, record);
    // Persist via BullMQ — survives restart
    if (!this.queue) {
      // _init not done yet, queue in-memory pre-init and replay
      this._preInit = this._preInit || [];
      this._preInit.push(record);
      return { jobId, status: 'queued' };
    }
    await this.queue.add('enterprise-upload', record, { jobId, attempts: 3, removeOnComplete: false, removeOnFail: false });
    return { jobId, status: 'queued' };
  }

  status(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) return null;
    return { jobId: j.jobId, status: j.status, progress: j.progress, stage: j.stage, memoryCount: j.memoryCount, error: j.error };
  }

  _update(jobId, patch) {
    if (!jobId) return;
    const job = this.jobs.get(jobId);
    if (job) Object.assign(job, patch);
    this.emit('update', { jobId, ...patch });
  }
}

// Pull job-execution body out of the in-memory class so BullMQ worker can
// share the exact same logic.
async function runEnterpriseJob(pipeline, job, update) {
  try {
    update({ status: 'running', progress: 'parsing', stage: 'parse', startedAt: new Date().toISOString() });

    const parseOutput = await pipeline.parse(job.tempPath, job.filename, { smart: job.smartExtract !== false });
    if (parseOutput.error && job.smartExtract !== false) {
      console.warn(`[enterprise-queue] smart parse failed for ${job.filename}: ${parseOutput.error}, falling back`);
      const fallbackParse = await pipeline.parse(job.tempPath, job.filename, { smart: false });
      Object.assign(parseOutput, fallbackParse);
    }
    update({ progress: 'classifying', stage: 'detect' });

    let detection = await pipeline.detect(parseOutput, { filename: job.filename });
    if (!detection || typeof detection !== 'object') {
      detection = { type: 'general', confidence: 0.0, reasoning: 'detector returned null' };
    } else if (typeof detection.confidence !== 'number' || detection.confidence < 0.3) {
      detection.type = 'general';
    }
    update({ progress: 'extracting', stage: 'extract' });

    const schema = await pipeline.extract(parseOutput, detection.type, { filename: job.filename });
    update({ progress: 'chunking', stage: 'chunk' });

    const payloads = await pipeline.chunk(schema, parseOutput, {
      uploadId: job.uploadId, userId: job.userId, orgId: job.orgId, tags: job.tags, scope: job.scope, filename: job.filename,
    });
    update({ progress: 'ingesting', stage: 'ingest' });

    let results;
    if (payloads && payloads.parent && Array.isArray(payloads.chunks)) {
      const parentResult = await pipeline.ingest({ parent: payloads.parent, chunks: [] }, { userId: job.userId, orgId: job.orgId });
      const parentId = parentResult?.parent_id || parentResult?.memory_id
        || (Array.isArray(parentResult?.memory_ids) ? parentResult.memory_ids[0] : null)
        || (Array.isArray(parentResult) ? parentResult[0]?.id : null);
      if (parentId) {
        for (const child of payloads.chunks) {
          child.metadata = child.metadata || {};
          child.metadata.parent_schema_id = parentId;
        }
      }
      const childResult = await pipeline.ingest({ parent: null, chunks: payloads.chunks }, { userId: job.userId, orgId: job.orgId });
      results = { parent: parentResult, children: childResult, memories_created: 1 + (Array.isArray(childResult?.memory_ids) ? childResult.memory_ids.length : payloads.chunks.length) };
    } else {
      results = await pipeline.ingest(payloads, { userId: job.userId, orgId: job.orgId });
    }

    const memoryCount = Array.isArray(results) ? results.length : (results?.memories_created || 0);
    update({ status: 'completed', progress: 'done', stage: 'done', completedAt: new Date().toISOString(), memoryCount });
    return { memoryCount };
  } catch (err) {
    console.error(`[enterprise-queue] job ${job.jobId} failed:`, err.message);
    update({ status: 'failed', progress: 'failed', stage: 'error', error: err.message, completedAt: new Date().toISOString() });
    throw err;
  }
}

let __enterpriseQueue = null;

/**
 * Singleton accessor. Returns either BullMQ-backed queue (Redis up) or
 * the legacy in-memory queue (Redis down). Both expose the same surface:
 *   - enqueue(job) → { jobId, status }
 *   - status(jobId) → { jobId, status, progress, stage, memoryCount, error }
 */
class EnterpriseQueueProxy extends EventEmitter {
  constructor() {
    super();
    this._impl = null;
  }
  set impl(next) {
    const prev = this._impl;
    this._impl = next;
    next.on?.('update', (e) => this.emit('update', e));
    if (prev !== next) this.emit('impl-changed', { mode: next.constructor.name });
  }
  get impl() { return this._impl; }
  async enqueue(job) { return this._impl.enqueue(job); }
  status(jobId) { return this._impl?.status(jobId); }
}

export function getEnterpriseQueue(pipeline) {
  if (__enterpriseQueue) return __enterpriseQueue;

  const concurrency = Number(process.env.ENTERPRISE_QUEUE_CONCURRENCY) || 2;
  __enterpriseQueue = new EnterpriseQueueProxy();
  __enterpriseQueue.impl = new EnterpriseUploadQueue({ concurrency, pipeline });

  (async () => {
    const host = await probeRedisHost();
    if (!host) {
      console.warn('[enterprise-queue] Redis probe failed — staying on in-memory queue');
      return;
    }
    if (String(process.env.RUNTIME_PROGRESS_VERBOSE || '').toLowerCase() === 'true') {
      console.log(`[enterprise-queue] Redis probe OK on ${host} — upgrading to BullMQ mode`);
    }
    const bq = new BullMQEnterpriseQueue({ concurrency, pipeline, host });
    // Replay any in-memory pending jobs into Bull.
    const prev = __enterpriseQueue.impl;
    if (prev?.pending && prev?.jobs) {
      for (const jid of prev.pending) {
        const j = prev.jobs.get(jid);
        if (j) await bq.enqueue(j);
      }
    }
    __enterpriseQueue.impl = bq;
  })().catch((e) => console.warn('[enterprise-queue] upgrade failed:', e.message));

  return __enterpriseQueue;
}
