/**
 * Durable KB ingestion queue — BullMQ on the existing Redis, wrapping the
 * verified document-first pipeline (documentFirstIngestion is called UNCHANGED
 * by the worker; nothing in the synchronous path is touched).
 *
 * Production shape (how Notion/Glean/OpenAI file-stores ingest):
 *   upload request = validate → persist raw bytes → ENQUEUE → return job_id.
 *   A bounded worker pool does parse→promote→index; enrichment stays async.
 *
 * Properties:
 *   DURABLE      raw bytes on disk (kb-store/<org>/<checksum>/) + BullMQ jobs
 *                in Redis survive restarts; in-memory fallback degrades to the
 *                old inline behavior when Redis is unreachable.
 *   IDEMPOTENT   jobId = <orgId>-<checksum> (BullMQ dedups double-submits);
 *                downstream sourceArtifact/knowledgeDocument upserts already
 *                dedup by checksum.
 *   RETRY + DLQ  attempts:3, exponential backoff, 10-min hard timeout per
 *                attempt (poison-pill guard — e.g. a Docling hang). Final
 *                failure stays in the BullMQ failed set (the DLQ) + tracker
 *                status 'dead'; raw file kept for replay.
 *   FAIR         per-org running cap (default 2) — a tenant bulk-dropping
 *                hundreds of docs cannot starve other tenants; saturated
 *                jobs are delayed-requeued with jitter.
 *   BACKPRESSURE enqueue rejects (caller → 429) past a global depth cap and
 *                a per-org pending cap.
 *
 * Rollout flag (no compose surgery needed): env KB_QUEUE_MODE, else the file
 * /app/data/kb-queue-mode (hot-reloaded every 30s). Values:
 *   'off' (default) | 'all' | comma-separated org ids (canary by org).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

const KB_STORE_DIR = process.env.KB_STORE_DIR || '/app/data/kb-store';
const MODE_FILE = process.env.KB_QUEUE_MODE_FILE || '/app/data/kb-queue-mode';
const QUEUE_NAME = 'kb-ingest';
const ATTEMPTS = Number(process.env.KB_QUEUE_ATTEMPTS || 3);
const JOB_TIMEOUT_MS = Number(process.env.KB_QUEUE_JOB_TIMEOUT_MS || 10 * 60 * 1000);
const CONCURRENCY = Number(process.env.KB_QUEUE_CONCURRENCY || 6);
const ORG_CONCURRENCY = Number(process.env.KB_QUEUE_ORG_CONCURRENCY || 4);
const MAX_DEPTH = Number(process.env.KB_QUEUE_MAX_DEPTH || 2000);
const ORG_PENDING_CAP = Number(process.env.KB_QUEUE_ORG_PENDING_CAP || 500);

function tryLoadBullMQ() {
  try {
    const bullmq = require_('bullmq');
    const IORedis = require_('ioredis');
    return { bullmq, IORedis };
  } catch {
    return null;
  }
}

/**
 * Resolve Redis connection options. Coolify injects the authoritative
 * connection string (host + password + db) into REDIS_URL but does NOT always
 * set a discrete REDIS_PASSWORD — reading only process.env.REDIS_PASSWORD then
 * yields `undefined` → "NOAUTH Authentication required" against a
 * password-protected Redis (silently kills the worker → jobs stick at
 * 'queued'). So prefer REDIS_URL, fall back to discrete REDIS_HOST/PORT/
 * PASSWORD. REDIS_HOST + REDIS_HOST_FALLBACKS are still tried as alternate
 * hosts (Coolify rebuilds the container under a hashed name; the `redis` alias
 * may or may not resolve after a restart).
 */
function resolveRedisConn() {
  let urlConn = null;
  if (process.env.REDIS_URL) {
    try {
      const u = new URL(process.env.REDIS_URL);
      urlConn = {
        host: u.hostname,
        port: Number(u.port || 6379),
        password: u.password ? decodeURIComponent(u.password) : undefined,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        db: u.pathname && u.pathname.length > 1 ? (Number(u.pathname.slice(1)) || 0) : 0,
      };
    } catch { /* malformed URL — fall back to discrete vars */ }
  }
  const port = urlConn?.port || Number(process.env.REDIS_PORT || 6379);
  const password = urlConn?.password ?? (process.env.REDIS_PASSWORD || undefined);
  const username = urlConn?.username;
  const db = urlConn?.db || 0;
  const primaryHost = urlConn?.host || process.env.REDIS_HOST || 'localhost';
  const altHosts = [
    process.env.REDIS_HOST,
    ...((process.env.REDIS_HOST_FALLBACKS || '').split(',').map(s => s.trim()).filter(Boolean)),
  ].filter(Boolean).filter(h => h !== primaryHost);
  return { primaryHost, candidates: [primaryHost, ...altHosts], port, password, username, db };
}

export class KbIngestQueue {
  /**
   * @param {object} deps
   * @param {object} deps.documentFirstIngestion  the verified pipeline (unchanged)
   * @param {object} deps.ingestTracker           in-memory job status store (FE polls /api/knowledge/status)
   * @param {function} [deps.recordUsage]         (orgId, result) => void — plan-quota accounting post-success
   * @param {object} [deps.logger]
   */
  constructor({ documentFirstIngestion, ingestTracker, recordUsage = null, logger = console }) {
    this.dfi = documentFirstIngestion;
    this.tracker = ingestTracker;
    this.recordUsage = recordUsage;
    this.logger = logger;
    this.queue = null;
    this.worker = null;
    this.mode = 'off';
    this._modeReadAt = 0;
    this._orgRunning = new Map();   // orgId -> running count (fairness)
    this._orgPending = new Map();   // orgId -> queued count (backpressure, best-effort)
    this._counters = { processed: 0, failed: 0, dead: 0, delayed_fair: 0, rejected_backpressure: 0 };
    this._ready = this._init();
  }

  async _init() {
    const deps = tryLoadBullMQ();
    if (!deps) {
      this.logger.warn?.('[kb-queue] bullmq/ioredis unavailable — queue disabled (inline fallback)');
      return;
    }
    const { bullmq, IORedis } = deps;
    this._bullmq = bullmq;
    const { candidates, port, password, username, db } = resolveRedisConn();
    // Retry the probe: at boot Redis can briefly be unready (container restart
    // race / DNS warmup). A single failed pass used to PERMANENTLY disable the
    // queue on that node — leaving one hm-core node queueing and the other
    // serving uploads inline + unable to read cross-node status. Retry so the
    // node self-heals within seconds instead of needing a manual restart.
    let host = null;
    const PROBE_ATTEMPTS = Number(process.env.KB_QUEUE_PROBE_ATTEMPTS || 10);
    for (let attempt = 0; attempt < PROBE_ATTEMPTS && !host; attempt++) {
      for (const h of candidates) {
        const probe = new IORedis({
          host: h, port, password, username,
          maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true,
          enableOfflineQueue: false, retryStrategy: () => null,
        });
        probe.on('error', () => {});
        try { await probe.connect(); await probe.ping(); host = h; probe.disconnect(); break; }
        catch { try { probe.disconnect(); } catch { /* noop */ } }
      }
      if (!host && attempt < PROBE_ATTEMPTS - 1) await new Promise(r => setTimeout(r, 2000));
    }
    if (!host) {
      this.logger.warn?.(`[kb-queue] no reachable Redis after ${PROBE_ATTEMPTS} attempts — queue disabled (inline fallback)`);
      return;
    }
    this._redisHost = host;
    const connection = {
      host, port, password, username, db,
      maxRetriesPerRequest: null,
    };
    this.queue = new bullmq.Queue(QUEUE_NAME, { connection });
    this.worker = new bullmq.Worker(QUEUE_NAME, (job, token) => this._process(job, token), {
      connection, concurrency: CONCURRENCY,
    });
    this.worker.on('failed', (job, err) => {
      this._counters.failed++;
      const final = job && job.attemptsMade >= (job.opts?.attempts || ATTEMPTS);
      if (final) {
        this._counters.dead++;
        this.logger.error?.(`[kb-queue] DLQ: job ${job?.id} (${job?.data?.filename}) dead after ${job?.attemptsMade} attempts: ${err?.message}`);
        try { this.tracker?.updateJob(job.data.trackerJobId, { status: 'dead', error: err?.message }); } catch { /* noop */ }
        this._setStatus(job?.data?.trackerJobId, { status: 'dead', error: err?.message, filename: job?.data?.filename });
      }
    });
    this.worker.on('error', (err) => this.logger.warn?.(`[kb-queue] worker error: ${err.message}`));
    // Shared status mirror: the worker can run on a DIFFERENT hm-core node than
    // the one the FE polls /api/knowledge/status against (the in-memory
    // ingestTracker is per-process). Mirror job status into Redis so status is
    // readable cross-node. 24h TTL.
    this.redis = new IORedis({ host, port, password, username, db, maxRetriesPerRequest: null });
    this.redis.on('error', () => {});
    this.logger.info?.(`[kb-queue] ready on redis://${host}:${port}/${db} (concurrency=${CONCURRENCY}, org-cap=${ORG_CONCURRENCY})`);
  }

  async _setStatus(trackerJobId, obj) {
    if (!this.redis || !trackerJobId) return;
    try {
      await this.redis.set(`kbq:status:${trackerJobId}`, JSON.stringify({ ...obj, updated_at: new Date().toISOString() }), 'EX', 86400);
    } catch { /* status mirror best-effort */ }
  }

  /**
   * Cross-node job status (Redis). Returns null on miss. Works even when THIS
   * node's queue worker failed to init (transient boot Redis-unready) — it
   * lazily opens a read client so status is readable on every node.
   */
  async getStatus(trackerJobId) {
    await this._ready;
    if (!trackerJobId) return null;
    let client = this.redis;
    if (!client) client = await this._lazyStatusRedis();
    if (!client) return null;
    try {
      const raw = await client.get(`kbq:status:${trackerJobId}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  async _lazyStatusRedis() {
    if (this._statusRedis) return this._statusRedis;
    const deps = tryLoadBullMQ();
    if (!deps) return null;
    const { IORedis } = deps;
    const { candidates, port, password, username, db } = resolveRedisConn();
    for (const h of candidates) {
      try {
        const c = new IORedis({ host: h, port, password, username, db, maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true, retryStrategy: () => null });
        c.on('error', () => {});
        await c.connect(); await c.ping();
        this._statusRedis = c;
        return c;
      } catch { /* try next host */ }
    }
    return null;
  }

  /** Rollout mode: env wins, else hot-reloaded mode file. 'off'|'all'|csv-org-ids */
  _readMode() {
    const now = Date.now();
    if (now - this._modeReadAt < 30_000) return this.mode;
    this._modeReadAt = now;
    let raw = (process.env.KB_QUEUE_MODE || '').trim();
    if (!raw) {
      try { raw = fs.readFileSync(MODE_FILE, 'utf8').trim(); } catch { raw = 'off'; }
    }
    this.mode = raw || 'off';
    return this.mode;
  }

  isEnabledFor(orgId) {
    if (!this.queue) return false; // no Redis → inline path
    const mode = this._readMode();
    if (!mode || mode === 'off') return false;
    if (mode === 'all') return true;
    return mode.split(',').map(s => s.trim()).filter(Boolean).includes(orgId);
  }

  /** Persist raw bytes durably; returns the stored path. */
  persistFile({ orgId, checksum, filename, fileBuffer }) {
    const dir = path.join(KB_STORE_DIR, orgId, checksum);
    fs.mkdirSync(dir, { recursive: true });
    const safe = filename.replace(/[/\\]/g, '_');
    const p = path.join(dir, safe);
    if (!fs.existsSync(p)) fs.writeFileSync(p, fileBuffer);
    return p;
  }

  /**
   * Enqueue an upload. Returns { job_id } or { backpressure: true } (caller → 429).
   * Caller has already validated auth/quota and computed the checksum.
   */
  async enqueue({ userId, orgId, filename, contentType, checksum, filePath, metadata }) {
    await this._ready;
    if (!this.queue) throw new Error('kb-queue unavailable');

    // Backpressure: global depth + per-org pending cap.
    try {
      const counts = await this.queue.getJobCounts('waiting', 'delayed', 'active');
      const depth = (counts.waiting || 0) + (counts.delayed || 0) + (counts.active || 0);
      if (depth >= MAX_DEPTH || (this._orgPending.get(orgId) || 0) >= ORG_PENDING_CAP) {
        this._counters.rejected_backpressure++;
        return { backpressure: true, depth };
      }
    } catch { /* counts best-effort — never block enqueue on stats */ }

    const trackerJobId = `kbq_${checksum.slice(0, 12)}_${Date.now().toString(36)}`;
    try { this.tracker?.createJob(trackerJobId, { userId, orgId, filename, kind: 'knowledge_upload', queued: true }); } catch { /* noop */ }
    this._setStatus(trackerJobId, { status: 'queued', filename, progress: 0 });

    // Unique jobId per accepted upload (trackerJobId = kbq_<checksum>_<ts>).
    // Dedup is handled UPSTREAM — the upfront DB checksum check returns 409 for
    // identical re-uploads before we ever enqueue, and the downstream
    // sourceArtifact/knowledgeDocument upsert dedups at the data layer. Using
    // <org>-<checksum> as the jobId (the old scheme) silently broke legitimate
    // re-ingests: BullMQ retains completed ids (removeOnComplete:1000), so a
    // delete-then-reupload or a forced re-ingest of the same bytes matched a
    // stale completed id, `add` was IGNORED, the worker never ran, and the
    // status mirror stuck at 'queued' forever (FE "Processing" hang).
    const job = await this.queue.add('ingest', {
      userId, orgId, filename, contentType, checksum, filePath, metadata, trackerJobId,
    }, {
      jobId: trackerJobId,
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000, // failed set IS the DLQ — keep for inspection/replay
    });
    this._orgPending.set(orgId, (this._orgPending.get(orgId) || 0) + 1);
    return { job_id: trackerJobId, queue_job_id: job.id };
  }

  async _process(job, token) {
    const { userId, orgId, filename, contentType, checksum, filePath, metadata, trackerJobId } = job.data;

    // Per-org fairness: cap concurrent jobs per tenant; saturated → delayed
    // requeue with jitter (does not consume an attempt).
    const running = this._orgRunning.get(orgId) || 0;
    if (running >= ORG_CONCURRENCY) {
      this._counters.delayed_fair++;
      await job.moveToDelayed(Date.now() + 2000 + Math.floor(Math.random() * 4000), token);
      throw new this._bullmq.DelayedError();
    }
    this._orgRunning.set(orgId, running + 1);
    this._orgPending.set(orgId, Math.max(0, (this._orgPending.get(orgId) || 1) - 1));

    try {
      const fileBuffer = fs.readFileSync(filePath); // durable bytes
      // Canonical front door: file uploads normalize into the IngestEnvelope
      // (source.type='kb'); ingestSource routes document+file → the same
      // ingestKnowledgeDocument pipeline, adding uniform provenance.
      const work = this.dfi.ingestSource({
        userId, orgId,
        source: { type: 'kb', filename },
        file: { buffer: fileBuffer, contentType: contentType || 'application/octet-stream', filename },
        metadata: metadata || {},
        onProgress: (p) => {
          try {
            const prev = this.tracker?.getJob(trackerJobId)?.metadata || {};
            this.tracker?.updateJob(trackerJobId, { status: p.stage || 'processing', progress: p.progress ?? 0, metadata: { ...prev, ...p } });
          } catch { /* noop */ }
          this._setStatus(trackerJobId, { status: p.stage || 'processing', progress: p.progress ?? 0, filename });
        },
      });
      // Hard timeout: poison-pill guard. The pipeline is idempotent (checksum
      // upserts + segment reuse), so an abandoned attempt is safe to retry.
      const result = await Promise.race([
        work,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`kb-ingest timeout ${JOB_TIMEOUT_MS}ms`)), JOB_TIMEOUT_MS)),
      ]);
      // An ingest that produced NO document is a failure, not a success. This
      // block ran unconditionally on resolve, so an empty upload logged
      //   [kb-queue] ✓ empty.txt org=1380251c doc=undefined segs=undefined promoted=undefined
      // and the job went to status 'indexed', progress 100. The caller already
      // holds its 202 {success:true}, so NOTHING anywhere said the upload produced
      // nothing — the user waits for memories that will never arrive.
      // Zero promoted memories is ALSO a failure, not just a missing document.
      // Measured: a 39.6 MB PDF whose parse chain fully collapsed —
      //   groq-vision failed: spawnSync convert ENOENT   (ImageMagick absent)
      //   Docling async polling timeout after 120000ms
      //   falling back to fast-pdf
      // — produced a document whose entire retained content was page markers
      // ("-- 1 of 19 --") and ZERO memories, and still logged ✓ promoted=0.
      // A document the user can never recall from is a failed ingest.
      if (!result?.documentId || Number(result?.promotedCount || 0) === 0) {
        const reason = !result?.documentId
          ? 'ingest produced no document (empty or unreadable content)'
          : 'ingest produced no memories — the document could not be parsed into recallable content';
        try {
          this.tracker?.updateJob(trackerJobId, { status: 'failed', progress: 100, error: reason });
        } catch { /* noop */ }
        this._setStatus(trackerJobId, { status: 'failed', progress: 100, error: reason });
        this._counters.failed = (this._counters.failed || 0) + 1;
        this.logger.warn?.(`[kb-queue] ✗ ${filename} org=${orgId.slice(0, 8)} doc=${result?.documentId || 'none'} — ${reason}`);
        return { documentId: result?.documentId || null, segmentCount: result?.segmentCount || 0, promotedCount: 0, error: reason };
      }
      try {
        const prev = this.tracker?.getJob(trackerJobId)?.metadata || {};
        this.tracker?.updateJob(trackerJobId, {
          status: 'indexed', progress: 100, memoryId: result.documentId,
          metadata: { ...prev, document_id: result.documentId, segmentCount: result.segmentCount, promotedCount: result.promotedCount, coverage: result.coverage || null },
        });
      } catch { /* noop */ }
      try { this.recordUsage?.(orgId, result); } catch { /* quota accounting best-effort */ }
      this._setStatus(trackerJobId, { status: 'indexed', progress: 100, document_id: result.documentId, segmentCount: result.segmentCount, promotedCount: result.promotedCount, coverage: result.coverage || null, filename });
      this._counters.processed++;
      this.logger.info?.(`[kb-queue] ✓ ${filename} org=${orgId.slice(0, 8)} doc=${result.documentId} segs=${result.segmentCount} promoted=${result.promotedCount}`);
      return { documentId: result.documentId, segmentCount: result.segmentCount, promotedCount: result.promotedCount };
    } finally {
      const r = this._orgRunning.get(orgId) || 1;
      if (r <= 1) this._orgRunning.delete(orgId); else this._orgRunning.set(orgId, r - 1);
    }
  }

  /** Ops surface for /api/knowledge/queue-stats. */
  async stats() {
    await this._ready;
    if (!this.queue) return { enabled: false, mode: this._readMode() };
    let counts = {};
    try { counts = await this.queue.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed'); } catch { /* noop */ }
    return {
      enabled: true,
      mode: this._readMode(),
      counts,
      per_org_running: Object.fromEntries(this._orgRunning),
      per_org_pending: Object.fromEntries(this._orgPending),
      lifetime: { ...this._counters },
      config: { concurrency: CONCURRENCY, org_concurrency: ORG_CONCURRENCY, attempts: ATTEMPTS, max_depth: MAX_DEPTH, job_timeout_ms: JOB_TIMEOUT_MS },
    };
  }

  /** Remove a queued/failed job + its status mirror by tracker job id or BullMQ
   *  job id. Best-effort — used when the FE deletes a stuck/processing card. */
  async clearJob(id) {
    await this._ready;
    try { if (this.redis && id) await this.redis.del(`kbq:status:${id}`); } catch { /* noop */ }
    if (!this.queue) return;
    try {
      // id may be the tracker job id (kbq_*) — scan recent jobs for a match;
      // or a BullMQ jobId (<org>-<checksum>) — try direct removal too.
      const direct = await this.queue.getJob(id).catch(() => null);
      if (direct) { await direct.remove().catch(() => {}); return; }
      const jobs = await this.queue.getJobs(['waiting', 'delayed', 'failed', 'active'], 0, 500).catch(() => []);
      for (const j of jobs) {
        if (j?.data?.trackerJobId === id) { await j.remove().catch(() => {}); }
      }
    } catch { /* best-effort */ }
  }

  async close() {
    try { await this.worker?.close(); } catch { /* noop */ }
    try { await this.queue?.close(); } catch { /* noop */ }
    try { this.redis?.disconnect(); } catch { /* noop */ }
  }
}
