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
import { normalizeKnowledgeIngestMode, sanitizeKnowledgeJson } from './upload-contract.js';

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
const VERBOSE = String(process.env.KB_INGEST_VERBOSE || '').toLowerCase() === 'true';
const LIFECYCLE_PHASES = new Set(['started', 'completed', 'failed']);

export function knowledgeIngestEvent(phase, fields = {}) {
  if (!LIFECYCLE_PHASES.has(phase)) throw new Error(`Unsupported knowledge ingest lifecycle phase: ${phase}`);
  return JSON.stringify({
    event: `knowledge.ingest.${phase}`,
    task: 'knowledge.ingest',
    ts: new Date().toISOString(),
    ...fields,
  });
}

/** Return terminal-safe warnings without leaking provider error details. */
export function terminalIngestWarnings(coverage = {}) {
  const warnings = Array.isArray(coverage?.warnings) ? [...coverage.warnings] : [];
  const hasPromotionFailureWarning = warnings.some((warning) => warning?.code === 'MEMORY_PROMOTION_FAILED');
  if (coverage?.promotion_failed && !hasPromotionFailureWarning) {
    warnings.push({
      code: 'MEMORY_PROMOTION_FAILED',
      message: 'Memory generation failed; evidence is ready.',
    });
  }
  return warnings;
}

export function durableQueueJobId(trackerJobId, processingVersion = 1) {
  return `${String(trackerJobId).replace(/:/g, '-')}-v${Number(processingVersion) || 1}`;
}

export function isStoredEvidencePromotion(metadata = {}) {
  return metadata?.promotion_existing_evidence === true && !!metadata?.promotion_document_id;
}

/** The durable job, not a queued JSON payload, owns the upload's mode. */
export function latchQueuedIngestMode({ durableMode, queuedMode }) {
  const durable = normalizeKnowledgeIngestMode(durableMode);
  const queued = normalizeKnowledgeIngestMode(queuedMode);
  if (!durable.ok || !queued.ok || durable.value !== queued.value) {
    return { ok: false, expected: durable.ok ? durable.value : null, actual: queued.ok ? queued.value : null };
  }
  return { ok: true, value: durable.value };
}

/** Completion is forbidden while any persisted evidence lacks its vector. */
export function requireCompleteEvidenceEmbedding(result = {}) {
  const coverage = result?.coverage?.evidence_embed;
  if (!coverage) return result;
  const failed = Number(coverage?.failed || 0);
  const expected = Number(result?.segmentCount || coverage?.total || 0);
  const total = Number(coverage?.total || expected);
  const embedded = Number(coverage?.embedded || 0);
  const missing = Math.max(failed, expected - embedded, total - embedded, 0);
  if (missing <= 0) return result;
  const error = new Error(`${missing}/${Math.max(expected, total, missing)} evidence segments were not embedded`);
  error.code = 'PARTIAL_EMBEDDING';
  error.retryable = true;
  error.coverage = coverage;
  throw error;
}

function unrecoverable(queue, error) {
  const UnrecoverableError = queue?._bullmq?.UnrecoverableError;
  if (!UnrecoverableError) return error;
  const final = new UnrecoverableError(error.message);
  final.code = error.code;
  return final;
}

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
  constructor({ documentFirstIngestion, ingestTracker, recordUsage = null, jobStore = null,
    validateJob = null, processUpload = null, logger = console }) {
    this.dfi = documentFirstIngestion;
    this.tracker = ingestTracker;
    this.recordUsage = recordUsage;
    this.jobStore = jobStore;
    this.validateJob = validateJob;
    this.processUpload = processUpload;
    this.workflowStatusResolver = null;
    this.logger = logger;
    this.queue = null;
    this.worker = null;
    this.mode = 'off';
    this._modeReadAt = 0;
    this._orgRunning = new Map();   // orgId -> running count (fairness)
    this._orgPending = new Map();   // orgId -> queued count (backpressure, best-effort)
    this._counters = { processed: 0, failed: 0, dead: 0, delayed_fair: 0, rejected_backpressure: 0 };
    // DEGRADED MODE FLAG. When Redis is unreachable the queue disables itself and
    // ingestion runs INLINE in the request: no retry, no DLQ, no cross-node status,
    // no backpressure. That is a reasonable last resort but it was completely
    // silent — two WARN lines at startup and nothing afterwards, so an operator
    // could serve uploads for hours in a mode with none of the durability
    // guarantees the rest of this file provides. Exposed via stats() so health and
    // /api/knowledge/status can say so out loud.
    this.inlineFallback = false;
    this.inlineFallbackReason = null;
    this._ready = this._init();
  }

  async _init() {
    const deps = tryLoadBullMQ();
    if (!deps) {
      this.inlineFallback = true;
      this.inlineFallbackReason = 'bullmq/ioredis module unavailable';
      if (VERBOSE) this.logger.warn?.('[kb-queue] DEGRADED: bullmq/ioredis unavailable — queue disabled (inline fallback: no retry, no DLQ, no cross-node status)');
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
      this.inlineFallback = true;
      this.inlineFallbackReason = `no reachable Redis after ${PROBE_ATTEMPTS} attempts`;
      if (VERBOSE) this.logger.warn?.(`[kb-queue] DEGRADED: no reachable Redis after ${PROBE_ATTEMPTS} attempts — queue disabled (inline fallback: no retry, no DLQ, no cross-node status)`);
      return;
    }
    this._redisHost = host;
    const connection = {
      host, port, password, username, db,
      maxRetriesPerRequest: null,
    };
    this.queue = new bullmq.Queue(QUEUE_NAME, { connection });
    this.worker = new bullmq.Worker(QUEUE_NAME, (job, token) => this._process(job, token), {
      connection,
      concurrency: CONCURRENCY,
      // STALL WINDOW MUST EXCEED THE JOB'S OWN TIMEOUT.
      // These were left at BullMQ's defaults (lockDuration 30s), while real ingests
      // run 30-134s and the promote phase alone measured 25.4s. BullMQ renews the
      // lock while the processor runs, but renewal rides the event loop — a long
      // synchronous stretch (parse, embed batching) can miss it. A lapsed lock makes
      // BullMQ re-deliver the job to another worker, which would ingest the SAME
      // document twice: duplicate memories, duplicate edges, double usage billed.
      //
      // Sized so a job can never look stalled while it is still inside its own
      // timeout: past JOB_TIMEOUT_MS it fails honestly instead of being re-run.
      // Genuinely lost workers (container recreate) are recovered by the separate
      // stale-job reaper, which marks them STALE_ABANDONED — that is the correct
      // owner of that case, not lock expiry.
      lockDuration: JOB_TIMEOUT_MS,
      stalledInterval: Number(process.env.KB_QUEUE_STALLED_INTERVAL_MS || 60 * 1000),
      maxStalledCount: Number(process.env.KB_QUEUE_MAX_STALLED || 1),
    });
    this.worker.on('failed', (job, err) => {
      this._counters.failed++;
      const final = job && job.attemptsMade >= (job.opts?.attempts || ATTEMPTS);
      if (final) {
        this._counters.dead++;
        this.logger.error?.(knowledgeIngestEvent('failed', {
          job_id: job?.data?.trackerJobId || job?.id || null,
          org_id: job?.data?.orgId || null,
          file: job?.data?.filename || null,
          mode: job?.data?.metadata?.ingest_mode || 'both',
          error_code: err?.code || 'INGEST_FAILED',
          message: String(err?.message || 'ingestion failed').slice(0, 500),
          retryable: false,
          attempts: job?.attemptsMade || 0,
          duration_ms: Math.max(0, Date.now() - Number(job?.timestamp || Date.now())),
        }));
        try { this.tracker?.updateJob(job.data.trackerJobId, { status: 'dead', error: err?.message }); } catch { /* noop */ }
        this._setStatus(job?.data?.trackerJobId, { status: 'dead', error: err?.message, filename: job?.data?.filename });
      }
    });
    this.worker.on('error', (err) => {
      if (VERBOSE) this.logger.warn?.(`[kb-queue] worker error: ${err.message}`);
    });
    // Shared status mirror: the worker can run on a DIFFERENT hm-core node than
    // the one the FE polls /api/knowledge/status against (the in-memory
    // ingestTracker is per-process). Mirror job status into Redis so status is
    // readable cross-node. 24h TTL.
    this.redis = new IORedis({ host, port, password, username, db, maxRetriesPerRequest: null });
    this.redis.on('error', () => {});
    if (VERBOSE) this.logger.info?.(`[kb-queue] ready on redis://${host}:${port}/${db} (concurrency=${CONCURRENCY}, org-cap=${ORG_CONCURRENCY})`);
    this._startStaleJobReaper();
    this._startRawFileSweeper();
  }

  /**
   * Bound the retained raw-upload files.
   *
   * Terminal failures now KEEP their bytes so a dead job can be replayed (before
   * this, the module promised "raw file kept for replay" while unlinking on the
   * final attempt, so replay was impossible). Retention without a bound is a disk
   * leak — this box was measured at 92% full earlier today — so anything older
   * than KB_RAW_RETENTION_HOURS is removed on a slow tick.
   *
   * Deliberately time-based rather than status-based: reading job status per file
   * would couple the sweeper to the DB, and a file older than the retention window
   * is past the point where a human would still be retrying it.
   */
  _startRawFileSweeper() {
    const hours = Number(process.env.KB_RAW_RETENTION_HOURS || 168); // 7 days
    const everyMs = Number(process.env.KB_RAW_SWEEP_INTERVAL_MS || 60 * 60 * 1000);
    if (!(hours > 0)) return;
    const sweep = () => {
      try {
        // persistFile() writes KB_STORE_DIR/<orgId>/<checksum>/<filename>, so this
        // walks exactly two levels — a flat readdir would sweep nothing.
        if (!KB_STORE_DIR || !fs.existsSync(KB_STORE_DIR)) return;
        const cutoff = Date.now() - hours * 3600 * 1000;
        let removed = 0; let kept = 0;
        for (const org of fs.readdirSync(KB_STORE_DIR)) {
          const orgDir = path.join(KB_STORE_DIR, org);
          let checksums = [];
          try {
            if (!fs.statSync(orgDir).isDirectory()) continue;
            checksums = fs.readdirSync(orgDir);
          } catch { continue; }
          for (const sum of checksums) {
            const sumDir = path.join(orgDir, sum);
            try {
              if (!fs.statSync(sumDir).isDirectory()) continue;
              let emptied = true;
              for (const name of fs.readdirSync(sumDir)) {
                const p = path.join(sumDir, name);
                const st = fs.statSync(p);
                if (!st.isFile()) { emptied = false; continue; }
                if (st.mtimeMs < cutoff) { fs.unlinkSync(p); removed += 1; } else { kept += 1; emptied = false; }
              }
              if (emptied) fs.rmdirSync(sumDir); // drop the now-empty checksum dir
            } catch { /* raced with the worker or another node — skip */ }
          }
          try { if (!fs.readdirSync(orgDir).length) fs.rmdirSync(orgDir); } catch { /* non-empty */ }
        }
        if (VERBOSE && removed) this.logger.info?.(`[kb-queue] raw-file sweep: removed ${removed} file(s) older than ${hours}h, ${kept} retained for replay`);
      } catch (err) {
        if (VERBOSE) this.logger.warn?.(`[kb-queue] raw-file sweep failed: ${err.message}`);
      }
    };
    this._rawSweepTimer = setInterval(sweep, everyMs);
    this._rawSweepTimer.unref?.();
  }

  /**
   * Reap jobs that died without ever reporting a terminal state.
   *
   * A container recreate loses in-flight BullMQ jobs, but the tracker row in
   * knowledge_ingest_jobs stays exactly as it was — so the job sits `queued` or
   * `processing` forever. Nothing times it out, nothing retries it, and nothing
   * surfaces it: the FE just shows a spinner that never resolves.
   *
   * Measured 2026-08-02: `kb-canary-amr.md` and `kb-canary-hybrid.md` had been
   * `queued` for over FIVE HOURS (18086s / 18524s) and had never started, and
   * `BundB-Solvis_Pitch-Praesentation.pptx` had been `processing` for two hours.
   * All three were orphaned by restarts during that session's deploys.
   *
   * Marking them failed is the honest outcome — an upload that is never going to
   * finish should say so, so the user can retry. Silence is the worst option.
   */
  _startStaleJobReaper() {
    const BOOTED_AT = new Date();
    if (String(process.env.KB_QUEUE_REAPER ?? 'true').toLowerCase() === 'false') return;
    const EVERY_MS = Number(process.env.KB_REAPER_INTERVAL_MS || 5 * 60 * 1000);
    // Generous: a 54-page enriched PDF legitimately takes ~11 minutes, and with
    // several workers a job can wait behind others. Only reap well past that.
    const QUEUED_MAX_MIN = Number(process.env.KB_REAPER_QUEUED_MAX_MIN || 90);
    const PROCESSING_MAX_MIN = Number(process.env.KB_REAPER_PROCESSING_MAX_MIN || 45);

    const sweep = async () => {
      if (!this.jobStore?.reapStale) return;
      try {
        await this.jobStore.reapStale({
          queuedMaxMin: QUEUED_MAX_MIN,
          processingMaxMin: PROCESSING_MAX_MIN,
          // Anything non-terminal that predates this boot lost its BullMQ job when
          // the previous container went away. Age it out in minutes, not 90.
          bootedAt: BOOTED_AT,
        });
        await this.jobStore.reconcileCloudflareStale?.({
          workflowStatusResolver: this.workflowStatusResolver,
          staleMin: Number(process.env.KNOWLEDGE_INGEST_WORKFLOW_STALE_MIN || 15),
        });
      } catch (e) {
        if (VERBOSE) this.logger.warn?.(`[kb-queue] reaper sweep failed: ${e.message}`);
      }
    };

    // First sweep shortly after boot — a restart is exactly when jobs get orphaned.
    this._reaperBoot = setTimeout(sweep, 30_000);
    this._reaperTimer = setInterval(sweep, EVERY_MS);
    this._reaperTimer.unref?.();
    this._reaperBoot.unref?.();
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

  async isAvailable() {
    await this._ready;
    return !!this.queue;
  }

  /** Persist raw bytes durably; returns the stored path. */
  /**
   * Where persistFile() put (or would put) the raw bytes for a job.
   *
   * Exposed so replay does not re-derive the layout: the path formula lives here,
   * next to the writer, and nowhere else. A second copy in the route would drift
   * the moment either changes — which is exactly how the sweeper was first written
   * against a flat directory that never existed.
   *
   * Returns null when the bytes are gone. Terminal failures retain them now, but
   * anything that failed BEFORE that change, or aged past
   * KB_RAW_RETENTION_HOURS, has nothing to replay and the caller must say so
   * rather than enqueue a job that will die on a missing file.
   */
  rawFilePath({ orgId, checksum, filename }) {
    if (!orgId || !checksum || !filename) return null;
    const safe = String(filename).replace(/[/\\]/g, '_');
    const p = path.join(KB_STORE_DIR, String(orgId), String(checksum), safe);
    try { return fs.existsSync(p) ? p : null; } catch { return null; }
  }

  persistFile({ orgId, checksum, filename, fileBuffer }) {
    const dir = path.join(KB_STORE_DIR, orgId, checksum);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safe = filename.replace(/[/\\]/g, '_');
    const p = path.join(dir, safe);
    if (!fs.existsSync(p)) fs.writeFileSync(p, fileBuffer, { mode: 0o600 });
    return p;
  }

  /**
   * Enqueue an upload. Returns { job_id } or { backpressure: true } (caller → 429).
   * Caller has already validated auth/quota and computed the checksum.
   */
  async enqueue({ userId, orgId, filename, contentType, checksum, filePath, metadata, trackerJobId = null, processingVersion = 1 }) {
    await this._ready;
    if (!this.queue) throw new Error('kb-queue unavailable');
    const normalizedMode = normalizeKnowledgeIngestMode(metadata?.ingest_mode);
    if (!normalizedMode.ok) {
      throw Object.assign(new Error('Queued upload has an invalid ingest mode.'), { code: 'INVALID_INGEST_MODE' });
    }
    metadata = sanitizeKnowledgeJson({
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
      ingest_mode: normalizedMode.value,
    });

    // Backpressure: global depth + per-org pending cap.
    try {
      const counts = await this.queue.getJobCounts('waiting', 'delayed', 'active');
      const depth = (counts.waiting || 0) + (counts.delayed || 0) + (counts.active || 0);
      if (depth >= MAX_DEPTH || (this._orgPending.get(orgId) || 0) >= ORG_PENDING_CAP) {
        this._counters.rejected_backpressure++;
        return { backpressure: true, depth };
      }
    } catch { /* counts best-effort — never block enqueue on stats */ }

    trackerJobId ||= `kbq_${checksum.slice(0, 12)}_${Date.now().toString(36)}`;
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
      userId, orgId, filename, contentType, checksum, filePath, metadata, trackerJobId, processingVersion,
    }, {
      jobId: durableQueueJobId(trackerJobId, processingVersion),
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000, // failed set IS the DLQ — keep for inspection/replay
    });
    this._orgPending.set(orgId, (this._orgPending.get(orgId) || 0) + 1);
    this.logger.info?.(knowledgeIngestEvent('started', {
      job_id: trackerJobId,
      org_id: orgId,
      user_id: userId,
      file: filename,
      mode: metadata?.ingest_mode || 'both',
    }));
    return { job_id: trackerJobId, queue_job_id: job.id };
  }

  async _process(job, token) {
    const { userId, orgId, filename, contentType, checksum, filePath, trackerJobId,
      processingVersion = 1, metadata: queuedMetadata } = job.data;
    let metadata = sanitizeKnowledgeJson(
      queuedMetadata && typeof queuedMetadata === 'object' && !Array.isArray(queuedMetadata) ? queuedMetadata : {},
    );

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
      if (this.validateJob) await this.validateJob({ trackerJobId, userId, orgId, metadata });
      // A durable retry increments processingVersion. A delayed attempt from the
      // old version must finish harmlessly instead of creating a second document.
      const durable = this.jobStore?.findOwned
        ? await this.jobStore.findOwned(trackerJobId, { orgId, userId })
        : null;
      if (durable) {
        if (Number(durable.processingVersion || 1) !== Number(processingVersion || 1)
          || !['queued', 'processing'].includes(durable.status)) {
          if (VERBOSE) this.logger.info?.(knowledgeIngestEvent('completed', {
            job_id: trackerJobId, org_id: orgId, stale: true, processing_version: processingVersion,
          }));
          return { stale: true };
        }
        const latched = latchQueuedIngestMode({
          durableMode: durable.ingestMode ?? durable.metadata?.ingest_mode,
          queuedMode: metadata.ingest_mode,
        });
        if (!latched.ok) {
          const error = Object.assign(
            new Error(`Queued ingest mode ${latched.actual || 'invalid'} does not match durable mode ${latched.expected || 'invalid'}.`),
            { code: 'INGEST_MODE_MISMATCH' },
          );
          await this.jobStore.fail(trackerJobId, orgId, error);
          throw unrecoverable(this, error);
        }
        metadata = sanitizeKnowledgeJson({ ...metadata, ingest_mode: latched.value });
      }
      await this.jobStore?.progress(trackerJobId, orgId, 'processing', 5, { attempt: job.attemptsMade + 1 });
      const promotionOnly = isStoredEvidencePromotion(metadata);
      const fileBuffer = promotionOnly ? null : fs.readFileSync(filePath); // durable bytes
      // Canonical front door: file uploads normalize into the IngestEnvelope
      // (source.type='kb'); ingestSource routes document+file → the same
      // ingestKnowledgeDocument pipeline, adding uniform provenance.
      const ingestStartedAt = new Date().toISOString();
      let currentStage = null;
      let stageStartedAt = ingestStartedAt;
      const onProgress = (p) => {
          const now = new Date();
          if (p.stage && p.stage !== currentStage) {
            currentStage = p.stage;
            stageStartedAt = now.toISOString();
          }
          const detail = {
            ...p,
            started_at: ingestStartedAt,
            stage_started_at: stageStartedAt,
            elapsed_ms: Math.max(0, now.getTime() - new Date(ingestStartedAt).getTime()),
          };
          try {
            const prev = this.tracker?.getJob(trackerJobId)?.metadata || {};
            this.tracker?.updateJob(trackerJobId, { status: p.stage || 'processing', progress: p.progress ?? 0, metadata: { ...prev, ...detail } });
          } catch { /* noop */ }
          this._setStatus(trackerJobId, { status: p.stage || 'processing', progress: p.progress ?? 0, filename, ...detail });
          this.jobStore?.progress(trackerJobId, orgId, p.stage || 'processing', p.progress ?? 0, detail).catch(() => {});
        };
      const work = promotionOnly
        ? this.dfi.promoteStoredEvidence({
          documentId: metadata.promotion_document_id,
          userId,
          orgId,
          metadata: metadata || {},
          onProgress,
          promotionStrategy: 'upgrade_evidence_to_both',
        })
        : this.processUpload
        ? this.processUpload({ userId, orgId, filename, contentType, fileBuffer, metadata: metadata || {}, onProgress })
        : this.dfi.ingestSource({
            userId, orgId,
            source: { type: 'kb', filename },
            file: { buffer: fileBuffer, contentType: contentType || 'application/octet-stream', filename },
            metadata: metadata || {}, ingestMode: metadata?.ingest_mode || 'both', onProgress,
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
      // A doc is a FAILURE only when NOTHING is recallable: no document, or a
      // document with neither memories NOR evidence segments (parse fully
      // collapsed — e.g. a PDF whose only retained content was page markers).
      //
      // A document WITH evidence segments but ZERO memories is NOT a failure —
      // it is an evidence-only (degraded) success. This honors commit e8300bcf's
      // owner invariant ("even if memories fail, the context is inside
      // evidences"): the segments are committed, embedded and fully searchable,
      // so evidence recall answers them; only synthesis-from-memory is reduced.
      // Marking it 'failed' here (the old `promotedCount === 0` gate) contradicted
      // that fix and made the user re-upload a doc that WAS ingested — the
      // duplicate-row source the commit itself named. `Solvis_Branding_Skizze`
      // (6 segments, 0 memories) is exactly this case.
      const _promoted = Number(result?.promotedCount || 0);
      const _segs = Number(result?.segmentCount || 0);
      if (!result?.documentId || (_promoted === 0 && _segs === 0)) {
        const reason = !result?.documentId
          ? 'ingest produced no document (empty or unreadable content)'
          : 'ingest produced no recallable content — the document could not be parsed into memories or evidence';
        try {
          this.tracker?.updateJob(trackerJobId, { status: 'failed', progress: 100, error: reason });
        } catch { /* noop */ }
        this._setStatus(trackerJobId, { status: 'failed', progress: 100, error: reason });
        this._counters.failed = (this._counters.failed || 0) + 1;
        const failed = Object.assign(new Error(reason), { code: 'NO_RECALLABLE_CONTENT' });
        await this.jobStore?.fail(trackerJobId, orgId, failed);
        // Retain for replay (see the terminal-failure path below) — a document that
        // produced no recallable content is exactly the case a user wants to retry
        // after a parser or model fix. Bounded by _sweepRawFiles().
        throw failed;
      }
      // Defense in depth: document-first ingestion already fails closed on
      // incomplete evidence vectors. Keep the durable queue independently
      // strict so no alternate processUpload implementation can settle usage
      // or expose `ready` with partial semantic coverage.
      requireCompleteEvidenceEmbedding(result);
      const _evidenceOnly = _promoted === 0 && _segs > 0;
      const _evidenceOnlyReason = result?.evidenceOnlyReason
        || (_evidenceOnly ? (metadata?.ingest_mode === 'evidence' ? 'user_selected' : 'extraction_yield_zero') : null);
      if (_evidenceOnlyReason && !result.evidenceOnlyReason) result.evidenceOnlyReason = _evidenceOnlyReason;
      try {
        const prev = this.tracker?.getJob(trackerJobId)?.metadata || {};
        this.tracker?.updateJob(trackerJobId, {
          status: 'indexed', progress: 100, memoryId: result.documentId,
          metadata: { ...prev, document_id: result.documentId, segmentCount: result.segmentCount, promotedCount: result.promotedCount, coverage: result.coverage || null },
        });
      } catch { /* noop */ }
      if (this.jobStore) await this.jobStore.complete(trackerJobId, orgId, userId, result);
      else { try { this.recordUsage?.(orgId, result); } catch { /* legacy accounting */ } }
      this._setStatus(trackerJobId, {
        status: 'indexed', progress: 100, document_id: result.documentId,
        segmentCount: result.segmentCount, promotedCount: result.promotedCount,
        candidateCount: result.candidateCount,
        ingestMode: metadata?.ingest_mode || 'both', evidenceOnly: _evidenceOnly,
        evidenceOnlyReason: _evidenceOnlyReason, coverage: result.coverage || null, filename,
      });
      this._counters.processed++;
      const _ee = result?.coverage?.evidence_embed;
      const _embedding = {
        route: String(process.env.CLOUDFLARE_AI_GATEWAY_ENABLED || '').toLowerCase() === 'true'
          ? 'cloudflare/openrouter' : (process.env.EMBEDDING_PROVIDER || 'openrouter'),
        model: process.env.OPENROUTER_EMBED_MODEL || process.env.EMBEDDING_MODEL || 'baai/bge-m3',
        total: Number(_ee?.total || result?.segmentCount || 0),
        succeeded: Number(_ee?.embedded || 0),
        healed: Number(_ee?.healed || 0),
        failed: Number(_ee?.failed || 0),
      };
      const _terminal = {
        job_id: trackerJobId,
        org_id: orgId,
        user_id: userId,
        file: filename,
        mode: metadata?.ingest_mode || 'both',
        document_id: result.documentId,
        evidence: Number(result.segmentCount || 0),
        memories: Number(result.promotedCount || 0),
        embedding: _embedding,
        warnings: terminalIngestWarnings(result?.coverage),
        duration_ms: Math.max(0, Date.now() - Number(job.timestamp || Date.now())),
      };
      this.logger.info?.(knowledgeIngestEvent('completed', _terminal));
      if (filePath) try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      return { documentId: result.documentId, segmentCount: result.segmentCount, promotedCount: result.promotedCount };
    } catch (error) {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts?.attempts || ATTEMPTS);
      if (finalAttempt) {
        await this.jobStore?.fail(trackerJobId, orgId, error);
        // RETAIN the raw bytes on terminal failure. This used to unlink here, which
        // made the module's own "raw file kept for replay" promise false: a job that
        // exhausted its attempts had nothing left to replay FROM, so a dead document
        // was unrecoverable and the user was never told. Keeping the file is what
        // makes a retry endpoint possible at all.
        // Disk is bounded by _sweepRawFiles() below, not by deleting on failure.
        if (VERBOSE) this.logger.warn?.(`[kb-queue] retaining raw file for replay: ${filePath} (job ${trackerJobId} dead: ${error?.message})`);
      }
      throw error;
    } finally {
      const r = this._orgRunning.get(orgId) || 1;
      if (r <= 1) this._orgRunning.delete(orgId); else this._orgRunning.set(orgId, r - 1);
    }
  }

  /** Ops surface for /api/knowledge/queue-stats. */
  async stats() {
    await this._ready;
    // Degraded mode is a first-class answer, not an absence. `enabled:false` alone
    // reads as "queueing is off by config"; inline_fallback says the durability
    // guarantees are GONE and why.
    if (!this.queue) {
      return {
        enabled: false,
        mode: this._readMode(),
        inline_fallback: this.inlineFallback,
        inline_fallback_reason: this.inlineFallbackReason,
        degraded: this.inlineFallback,
      };
    }
    let counts = {};
    try { counts = await this.queue.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed'); } catch { /* noop */ }
    return {
      enabled: true,
      mode: this._readMode(),
      counts,
      per_org_running: Object.fromEntries(this._orgRunning),
      per_org_pending: Object.fromEntries(this._orgPending),
      lifetime: { ...this._counters },
      inline_fallback: false,
      degraded: false,
      config: {
        concurrency: CONCURRENCY, org_concurrency: ORG_CONCURRENCY, attempts: ATTEMPTS,
        max_depth: MAX_DEPTH, job_timeout_ms: JOB_TIMEOUT_MS,
        lock_duration_ms: JOB_TIMEOUT_MS,
        raw_retention_hours: Number(process.env.KB_RAW_RETENTION_HOURS || 168),
      },
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
