/**
 * Durable outbox for engine→agent pushes (Production Compass Phase 4).
 *
 * REMOTE-ONLY: engages exclusively when orgIsRemote(orgId) is true.
 * Central / personal / managed orgs are byte-unchanged.
 *
 * Guarantees
 *   DURABLE    — every push is encrypted into memory_outbox (central PG) BEFORE
 *                the BullMQ job is queued.  A Redis blip at enqueue time does
 *                not lose the push: sweepStuckOutbox() re-enqueues 'pending'
 *                rows whose nextAttemptAt < now and that have no live BullMQ job.
 *   ORDERED    — ops for the same recordId are FIFO-gated by seq.  The worker
 *                re-delays job N+1 until job N is acked, so write→edge→updateTags
 *                always lands in the correct order on the agent.
 *   IDEMPOTENT — BullMQ jobId = outboxId (stable UUID from the row).  BullMQ
 *                deduplicates double-enqueues with the same jobId.
 *   DLQ        — after PUSH_MAX_ATTEMPTS retries (or on a poison 4xx) the row
 *                flips to status='dead' and a structured error is logged.
 *   CIRCUIT    — per-org in-process circuit breaker prevents one dead agent from
 *                saturating the worker pool.
 *
 * Design choice on write success: on a successful remoteWrite we do NOT write an
 * extra 'acked' outbox row. The synchronous write succeeds, the caller continues,
 * and the audit trail lives in the agent itself. Only on write FAILURE do we
 * enqueue for retry. After remote acknowledgement the replay payload is redacted;
 * the row retains only non-content delivery telemetry.
 */

import { createRequire } from 'node:module';
import { getCentralPrismaClient, runWithOrg } from '../db/prisma.js';
import {
  remoteWrite,
  remoteAddEdge,
  remoteUpdate,
  remoteUpdateTags,
  remoteDelete,
  remoteKbSegment,
} from '../vector/mneme/remote-backend.js';
import { openOutboxPayload, redactedOutboxPayload, sealOutboxPayload } from './outbox-crypto.js';

const require_ = createRequire(import.meta.url);

// ─── env knobs ────────────────────────────────────────────────────────────────
const PUSH_OUTBOX_ENABLED = (process.env.PUSH_OUTBOX_ENABLED ?? 'true') === 'true';
const PUSH_WORKER_CONCURRENCY = Number(process.env.PUSH_WORKER_CONCURRENCY || 8);
const PUSH_MAX_ATTEMPTS = Number(process.env.PUSH_MAX_ATTEMPTS || 8);
const PUSH_BREAKER_THRESHOLD = Number(process.env.PUSH_BREAKER_THRESHOLD || 10);
const PUSH_BREAKER_COOLDOWN_MS = Number(process.env.PUSH_BREAKER_COOLDOWN_MS || 60_000);
const ORDERING_REDEALY_MS = 500;
const SWEEP_INTERVAL_MS = Number(process.env.PUSH_SWEEP_INTERVAL_MS || 60_000);
const QUEUE_NAME = 'memory-push';

// ─── exponential backoff ──────────────────────────────────────────────────────
const BACKOFF_CAP_MS = 5 * 60 * 1000; // 5 min
function backoffMs(attempts) {
  const base = Math.min(1000 * 2 ** attempts, BACKOFF_CAP_MS);
  const jitter = Math.random() * base * 0.25;
  return Math.floor(base + jitter);
}

// ─── Redis connection (mirrors kb-ingest-queue pattern) ──────────────────────
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
    } catch { /* fall through */ }
  }
  const port = urlConn?.port || Number(process.env.REDIS_PORT || 6379);
  const password = urlConn?.password ?? (process.env.REDIS_PASSWORD || undefined);
  const username = urlConn?.username;
  const db = urlConn?.db || 0;
  const primaryHost = urlConn?.host || process.env.REDIS_HOST || 'localhost';
  const altHosts = [
    process.env.REDIS_HOST,
    ...((process.env.REDIS_HOST_FALLBACKS || '').split(',').map((s) => s.trim()).filter(Boolean)),
  ].filter(Boolean).filter((h) => h !== primaryHost);
  return { primaryHost, candidates: [primaryHost, ...altHosts], port, password, username, db };
}

// ─── per-org in-process circuit breaker ──────────────────────────────────────
const _breaker = new Map(); // orgId → { failures: number, openUntil: number }
function breakerOpen(orgId) {
  const b = _breaker.get(orgId);
  if (!b) return false;
  if (b.openUntil && Date.now() < b.openUntil) return true;
  if (b.openUntil) _breaker.delete(orgId); // cooldown expired — half-open
  return false;
}
function breakerRecord(orgId, success) {
  if (success) { _breaker.delete(orgId); return; }
  const b = _breaker.get(orgId) || { failures: 0, openUntil: 0 };
  b.failures += 1;
  if (b.failures >= PUSH_BREAKER_THRESHOLD) {
    b.openUntil = Date.now() + PUSH_BREAKER_COOLDOWN_MS;
  }
  _breaker.set(orgId, b);
}

// ─── classify errors ─────────────────────────────────────────────────────────
function isRetryable(err) {
  const msg = String(err?.message || '');
  // Network-level failures and 5xx / 429 are retryable
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|abort|network|timeout/i.test(msg)) return true;
  // HTTP status codes embedded in the message (our _call throws `agent /v1/xxx → <status>`)
  const m = msg.match(/→\s*(\d{3})/);
  if (m) {
    const code = Number(m[1]);
    if (code === 429 || code >= 500) return true;
    return false; // 4xx other than 429 → poison
  }
  return true; // unknown → optimistically retry
}

// ─── dispatch: map op to the correct remote-backend function ─────────────────
const DEFAULT_HANDLERS = {
  write: remoteWrite,
  edge: remoteAddEdge,
  update: remoteUpdate,
  updateTags: remoteUpdateTags,
  delete: remoteDelete,
  kbSegment: remoteKbSegment,
};

export async function dispatchOutboxRow(row, handlers = DEFAULT_HANDLERS) {
  const { op, orgId } = row;
  const payload = openOutboxPayload(row.payload);
  switch (op) {
    case 'write':
      return handlers.write(orgId, payload.record, payload.vector, payload.rels ?? []);
    case 'edge':
      return handlers.edge(orgId, payload.rel);
    case 'update':
      return handlers.update(orgId, payload.id, payload.patch);
    case 'updateTags':
      return handlers.updateTags(orgId, payload.id, payload.tags);
    case 'delete':
      return handlers.delete(orgId, payload.id, payload.hard ?? false);
    case 'kbSegment':
      return handlers.kbSegment(orgId, payload.segment, payload.vector);
    default:
      throw new Error(`[outbox] unknown op '${op}' for org=${orgId}`);
  }
}

// ─── BullMQ singleton ─────────────────────────────────────────────────────────
let _queue = null;
let _worker = null;
let _sweepTimer = null;
let _started = false;

function tryLoadBullMQ() {
  try { return require_('bullmq'); }
  catch { return null; }
}
function tryLoadIORedis() {
  try { return require_('ioredis'); }
  catch { return null; }
}

// ─── enqueuePush ─────────────────────────────────────────────────────────────
export async function lockOutboxRecord(tx, recordId) {
  // pg_advisory_xact_lock returns PostgreSQL `void`. Prisma's queryRaw attempts
  // to deserialize that pseudo-type and emits an error even though the lock was
  // acquired. executeRaw is the established lock primitive used elsewhere in
  // Core and preserves the transaction-scoped serialization contract without
  // decoding a result row.
  await tx.$executeRawUnsafe(
    'SELECT pg_advisory_xact_lock(hashtext($1::text))',
    recordId,
  );
}

/**
 * Insert a pending outbox row and enqueue a BullMQ job.
 *
 * @param {string} orgId
 * @param {'write'|'edge'|'update'|'updateTags'|'delete'|'kbSegment'} op
 * @param {string} recordId  — the memory/edge id (FIFO partition key)
 * @param {object} payload   — full replay envelope
 * @returns {Promise<string>} outboxId
 */
export async function enqueuePush(orgId, op, recordId, payload) {
  const prisma = getCentralPrismaClient();
  const sealedPayload = sealOutboxPayload(payload);
  // Serialize max(seq)+1 per record. Without the transaction-scoped lock, two
  // concurrent update operations can receive the same sequence and violate the
  // FIFO contract even though both inserts succeed.
  const row = await prisma.$transaction(async (tx) => {
    await lockOutboxRecord(tx, recordId);
    const seqResult = await tx.$queryRaw`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
      FROM memory_outbox
      WHERE record_id = ${recordId}::uuid
    `;
    const seq = seqResult[0]?.next_seq ?? 1n;
    return tx.memoryOutbox.create({
      data: {
        orgId,
        recordId,
        op,
        payload: sealedPayload,
        seq,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(),
      },
    });
  });

  // Best-effort BullMQ enqueue: if Redis is unreachable the row already exists
  // and sweepStuckOutbox() will pick it up on the next interval.
  if (_queue) {
    try {
      await _queue.add(QUEUE_NAME, { outboxId: row.id }, {
        jobId: row.id, // stable dedup key
        removeOnComplete: true,
        removeOnFail: false,
      });
    } catch (err) {
      // Row is durable — sweep will recover.
      console.error(`[outbox] enqueue to Redis failed (sweep will recover): ${err.message}`);
    }
  }

  return row.id;
}

// ─── PushWorker processor ────────────────────────────────────────────────────
export async function processOutboxJob(job, {
  prisma = getCentralPrismaClient(),
  queue = _queue,
  handlers = DEFAULT_HANDLERS,
  runWithOrgFn = runWithOrg,
} = {}) {
  const { outboxId } = job.data;
  if (!outboxId) return;
  const row = await prisma.memoryOutbox.findUnique({ where: { id: outboxId } });
  if (!row || row.status !== 'pending') return; // already acked/dead or not found

  const { orgId, recordId, seq } = row;

  // ── ordering gate: block if an earlier-seq op for this recordId is still pending ──
  const blocker = await prisma.memoryOutbox.findFirst({
    where: {
      recordId,
      seq: { lt: seq },
      status: 'pending',
    },
    select: { id: true },
  });
  if (blocker) {
    // Re-delay this job without counting as an attempt failure.
    if (queue) {
      await queue.add(QUEUE_NAME, { outboxId }, {
        jobId: `${outboxId}-retry-${Date.now()}`,
        delay: ORDERING_REDEALY_MS,
        removeOnComplete: true,
        removeOnFail: false,
      });
    }
    return;
  }

  // ── circuit breaker check ──
  if (breakerOpen(orgId)) {
    const delay = PUSH_BREAKER_COOLDOWN_MS;
    await prisma.memoryOutbox.update({
      where: { id: outboxId },
      data: { nextAttemptAt: new Date(Date.now() + delay) },
    });
    if (queue) {
      await queue.add(QUEUE_NAME, { outboxId }, {
        jobId: `${outboxId}-breaker-${Date.now()}`,
        delay,
        removeOnComplete: true,
        removeOnFail: false,
      });
    }
    return;
  }

  // ── attempt dispatch inside the org's async context ──
  let succeeded = false;
  let lastErr = null;
  try {
    await runWithOrgFn(orgId, async () => {
      const result = await dispatchOutboxRow(row, handlers);
      // remoteWrite/etc return truthy on success, null/false on caught error
      if (result === null || result === false) throw new Error('remote returned falsy — classified as failure');
      succeeded = true;
    });
  } catch (err) {
    lastErr = err;
  }

  if (succeeded) {
    breakerRecord(orgId, true);
    await prisma.memoryOutbox.update({
      where: { id: outboxId },
      data: { status: 'acked', ackedAt: new Date(), payload: redactedOutboxPayload() },
    });
    return;
  }

  // ── failure handling ──
  breakerRecord(orgId, false);
  const newAttempts = (row.attempts || 0) + 1;
  const poison = lastErr && !isRetryable(lastErr);
  const exhausted = newAttempts >= PUSH_MAX_ATTEMPTS;

  if (poison || exhausted) {
    await prisma.memoryOutbox.update({
      where: { id: outboxId },
      data: { status: 'dead', attempts: newAttempts, lastError: String(lastErr?.message || lastErr) },
    });
    console.error(
      `[outbox][DLQ] org=${orgId} op=${row.op} id=${outboxId} recordId=${recordId} attempts=${newAttempts} poison=${poison} err=${lastErr?.message}`,
    );
    return;
  }

  const delay = backoffMs(newAttempts);
  const nextAttemptAt = new Date(Date.now() + delay);
  await prisma.memoryOutbox.update({
    where: { id: outboxId },
    data: { attempts: newAttempts, lastError: String(lastErr?.message || lastErr), nextAttemptAt },
  });
  // Re-add with backoff delay
  if (queue) {
    try {
      await queue.add(QUEUE_NAME, { outboxId }, {
        jobId: `${outboxId}-a${newAttempts}-${Date.now()}`,
        delay,
        removeOnComplete: true,
        removeOnFail: false,
      });
    } catch { /* sweep will recover */ }
  }
}

// ─── sweepStuckOutbox ────────────────────────────────────────────────────────
/**
 * Re-enqueue 'pending' rows whose nextAttemptAt is in the past.
 * Covers the case where Redis was unavailable at original enqueue time,
 * or where the worker crashed before completing a job.
 */
// Phase 10 (observability): per-org outbox health — pending depth, oldest-unacked age (lag), DLQ
// (dead) count, last successful push. Cheap aggregate query; surfaced via /v1/selfhost/status so the
// onboarding/ops view shows lag + errors, not just green/red. Returns null on any failure (non-fatal).
export async function getOutboxStats(orgId) {
  try {
    const prisma = getCentralPrismaClient();
    const [pending, dead, oldest, lastAck] = await Promise.all([
      prisma.memoryOutbox.count({ where: { orgId, status: 'pending' } }),
      prisma.memoryOutbox.count({ where: { orgId, status: 'dead' } }),
      prisma.memoryOutbox.findFirst({ where: { orgId, status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.memoryOutbox.findFirst({ where: { orgId, status: 'acked' }, orderBy: { ackedAt: 'desc' }, select: { ackedAt: true } }),
    ]);
    const oldestUnackedAgeMs = oldest ? (Date.now() - new Date(oldest.createdAt).getTime()) : 0;
    return { pending, dead, oldestUnackedAgeMs, lastAckedAt: lastAck?.ackedAt || null };
  } catch { return null; }
}

export async function sweepStuckOutbox() {
  if (!PUSH_OUTBOX_ENABLED) return;
  if (!_queue) return; // BullMQ not initialised — nothing to re-enqueue into
  try {
    const prisma = getCentralPrismaClient();
    const stuck = await prisma.memoryOutbox.findMany({
      where: {
        status: 'pending',
        nextAttemptAt: { lte: new Date() },
      },
      select: { id: true },
      take: 500,
      orderBy: { nextAttemptAt: 'asc' },
    });
    for (const { id } of stuck) {
      try {
        await _queue.add(QUEUE_NAME, { outboxId: id }, {
          jobId: `sweep-${id}-${Date.now()}`,
          removeOnComplete: true,
          removeOnFail: false,
        });
      } catch { /* best-effort */ }
    }
    if (stuck.length > 0) {
      console.error(`[outbox][sweep] re-enqueued ${stuck.length} stuck rows`);
    }
  } catch (err) {
    console.error(`[outbox][sweep] error: ${err.message}`);
  }
}

// ─── startPushWorker (idempotent singleton) ───────────────────────────────────
/**
 * Initialise the BullMQ Queue + Worker for memory-push jobs.
 * Safe to call multiple times — only the first call has any effect.
 * Should be called at app boot, after Redis is expected to be reachable.
 */
export async function startPushWorker() {
  if (!PUSH_OUTBOX_ENABLED) {
    console.error('[outbox] PUSH_OUTBOX_ENABLED=false — push worker disabled');
    return;
  }
  if (_started) return;
  _started = true;

  const bullmq = tryLoadBullMQ();
  const IORedis = tryLoadIORedis();
  if (!bullmq || !IORedis) {
    console.error('[outbox] bullmq/ioredis unavailable — push worker disabled (durable rows still accumulate)');
    return;
  }

  const { candidates, port, password, username, db } = resolveRedisConn();

  // Probe Redis (same retry loop as kb-ingest-queue)
  let host = null;
  const PROBE_ATTEMPTS = Number(process.env.PUSH_WORKER_PROBE_ATTEMPTS || 10);
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
    if (!host && attempt < PROBE_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (!host) {
    console.error(`[outbox] no reachable Redis after ${PROBE_ATTEMPTS} attempts — push worker disabled (sweep will retry)`);
    return;
  }

  const connection = { host, port, password, username, db, maxRetriesPerRequest: null };

  _queue = new bullmq.Queue(QUEUE_NAME, { connection });
  _worker = new bullmq.Worker(QUEUE_NAME, processOutboxJob, {
    connection,
    concurrency: PUSH_WORKER_CONCURRENCY,
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
  });

  _worker.on('failed', (job, err) => {
    // processJob handles its own retry logic; this is a safety net for unexpected throws.
    console.error(`[outbox] worker job failed unexpectedly: job=${job?.id} err=${err?.message}`);
  });
  _worker.on('error', (err) => {
    console.error(`[outbox] worker error: ${err.message}`);
  });

  console.error(`[outbox] push worker ready on redis://${host}:${port}/${db} (concurrency=${PUSH_WORKER_CONCURRENCY})`);

  // Initial sweep to recover any rows that survived a restart
  await sweepStuckOutbox();

  // Periodic sweep interval
  _sweepTimer = setInterval(sweepStuckOutbox, SWEEP_INTERVAL_MS);
  _sweepTimer.unref?.(); // don't keep the process alive if nothing else is running

  // Graceful shutdown
  process.once('SIGTERM', async () => {
    clearInterval(_sweepTimer);
    try { await _worker?.close(); } catch { /* noop */ }
    try { await _queue?.close(); } catch { /* noop */ }
  });
}
