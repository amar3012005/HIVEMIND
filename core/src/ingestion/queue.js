const crypto = require('crypto');
const EventEmitter = require('events');
const { SOURCE_TYPES, STAGES } = require('./constants');

const DEFAULT_QUEUE_NAME = 'hivemind-ingestion';
const DEFAULT_DLQ_NAME = 'hivemind-ingestion-dlq';

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('ingest payload must be an object');
  }

  if (!SOURCE_TYPES.has(payload.source_type)) {
    throw new Error('source_type must be one of: text | url | pdf | code | conversation');
  }

  if (!payload.user_id || !payload.org_id) {
    throw new Error('user_id and org_id are required for tenant isolation');
  }

  return true;
}

class InMemoryIngestionQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.queueName = options.queueName || DEFAULT_QUEUE_NAME;
    this.dlqName = options.dlqName || DEFAULT_DLQ_NAME;
    this.jobs = new Map();
    this.dlq = [];
    this.handler = null;
  }

  process(handler) {
    this.handler = handler;
  }

  async add(name, data, options = {}) {
    const id = options.jobId || crypto.randomUUID();
    const job = {
      id,
      name,
      data,
      opts: {
        attempts: options.attempts || 3,
        priority: options.priority || 3,
      },
      attemptsMade: 0,
      progress: { stage: STAGES.QUEUED },
      async updateProgress(progress) {
        this.progress = { ...this.progress, ...progress };
      },
      async log(message) {
        return message;
      },
    };

    this.jobs.set(id, job);
    setImmediate(() => this._run(job));
    return { id };
  }

  async _run(job) {
    if (!this.handler) {
      this.emit('error', new Error('No ingestion worker handler has been attached'));
      return;
    }

    while (job.attemptsMade < job.opts.attempts) {
      try {
        await this.handler(job);
        this.emit('completed', { id: job.id, result: job.result });
        return;
      } catch (error) {
        job.attemptsMade += 1;
        this.emit('failed-attempt', {
          id: job.id,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts,
          error: error.message,
        });

        if (job.attemptsMade >= job.opts.attempts) {
          this.dlq.push({
            id: job.id,
            name: job.name,
            data: job.data,
            failedAt: new Date().toISOString(),
            error: error.message,
          });
          this.emit('failed', { id: job.id, error: error.message, deadLetterQueue: this.dlqName });
          return;
        }
      }
    }
  }

  getDLQJobs() {
    return [...this.dlq];
  }
}

function tryLoadBullMQ() {
  try {
    const bullmq = require('bullmq');
    const IORedis = require('ioredis');
    return { bullmq, IORedis };
  } catch (_error) {
    return null;
  }
}

function buildInMemoryQueueSystem(options) {
  const fallbackQueue = new InMemoryIngestionQueue(options);
  return {
    mode: 'in-memory',
    queue: fallbackQueue,
    dlq: fallbackQueue,
    async close() {
      return undefined;
    },
  };
}

function createIngestionQueue(options = {}) {
  const bullmqDeps = tryLoadBullMQ();

  if (!bullmqDeps || options.forceInMemory === true) {
    return buildInMemoryQueueSystem(options);
  }

  const { bullmq, IORedis } = bullmqDeps;

  // Probe Redis on a throwaway connection first. Only construct BullMQ
  // Queue instances if the probe succeeds — BullMQ's internal RedisConnection
  // emits unhandled 'error' events on bad hosts which can crash the process.
  // If probe fails, fall back to in-memory queue. Resolved system is the
  // single source of truth after `ready` settles.
  //
  // Multi-host candidates: Coolify rebuilds containers with hashed names so
  // the configured REDIS_HOST=redis DNS alias can disappear on `docker
  // restart`. REDIS_HOST_FALLBACKS lets the runtime recover automatically
  // without env edits per rebuild.
  // Prefer REDIS_URL (Coolify's authoritative host+password+db); discrete
  // REDIS_HOST/PORT/PASSWORD are the fallback. REDIS_PASSWORD is frequently
  // UNSET while the real password lives only inside REDIS_URL — reading
  // REDIS_PASSWORD alone then yields undefined → "NOAUTH Authentication
  // required" → this queue silently degraded to the in-memory fallback (no
  // durability across restart).
  let urlHost; let urlPort; let urlPassword; let urlUsername; let urlDb;
  if (process.env.REDIS_URL) {
    try {
      const u = new URL(process.env.REDIS_URL);
      urlHost = u.hostname;
      urlPort = Number(u.port || 6379);
      urlPassword = u.password ? decodeURIComponent(u.password) : undefined;
      urlUsername = u.username ? decodeURIComponent(u.username) : undefined;
      urlDb = (u.pathname && u.pathname.length > 1) ? (Number(u.pathname.slice(1)) || 0) : 0;
    } catch { /* malformed URL — fall back to discrete vars */ }
  }
  const redisPort = urlPort || Number(process.env.REDIS_PORT || 6379);
  const redisPassword = urlPassword !== undefined ? urlPassword : (process.env.REDIS_PASSWORD || undefined);
  const redisUsername = urlUsername;
  const redisDb = urlDb || 0;
  const primaryHost = urlHost || process.env.REDIS_HOST || 'localhost';
  const altHosts = [
    process.env.REDIS_HOST,
    ...(process.env.REDIS_HOST_FALLBACKS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ].filter(Boolean).filter((h) => h !== primaryHost);
  const candidateHosts = [primaryHost, ...altHosts];

  let resolvedSystem = null;
  const inMemoryFallback = buildInMemoryQueueSystem(options);

  const ready = (async () => {
    let workingHost = null;
    for (const host of candidateHosts) {
      const probe = new IORedis({
        host,
        port: redisPort,
        password: redisPassword,
        username: redisUsername,
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
        workingHost = host;
        try { await probe.quit(); } catch {}
        break;
      } catch {
        try { await probe.quit(); } catch {}
        try { probe.disconnect(); } catch {}
      }
    }

    if (!workingHost) {
      console.warn(`[ingestion-queue] Redis probe failed on all hosts (${candidateHosts.join(', ')}) — falling back to in-memory queue`);
      resolvedSystem = inMemoryFallback;
      return resolvedSystem;
    }

    // Probe succeeded — build a real BullMQ connection for the queues
    // on the host that actually answered.
    const connection = new IORedis({
      host: workingHost,
      port: redisPort,
      password: redisPassword,
      username: redisUsername,
      db: redisDb,
      maxRetriesPerRequest: null,
    });
    connection.on('error', (err) => {
      console.warn('[ingestion-queue] Redis connection error:', err.message);
    });

    const queue = new bullmq.Queue(options.queueName || DEFAULT_QUEUE_NAME, { connection });
    const dlq = new bullmq.Queue(options.dlqName || DEFAULT_DLQ_NAME, { connection });

    if (String(process.env.RUNTIME_PROGRESS_VERBOSE || '').toLowerCase() === 'true') {
      console.log(`[ingestion-queue] Redis probe OK on ${workingHost} — using BullMQ mode`);
    }

    resolvedSystem = {
      mode: 'bullmq',
      queue,
      dlq,
      connection,
      async close() {
        await queue.close();
        await dlq.close();
        await connection.quit();
      },
    };
    return resolvedSystem;
  })();

  return {
    get mode() { return resolvedSystem ? resolvedSystem.mode : 'pending'; },
    get queue() { return resolvedSystem ? resolvedSystem.queue : inMemoryFallback.queue; },
    get dlq() { return resolvedSystem ? resolvedSystem.dlq : inMemoryFallback.dlq; },
    get connection() { return resolvedSystem?.connection || null; },
    ready,
    async close() {
      const sys = await ready;
      await sys.close();
    },
  };
}

async function ingest(payload, queueSystem, options = {}) {
  validatePayload(payload);

  // Wait for the Redis probe so we don't enqueue on a dead BullMQ that
  // will silently hang. Resolves quickly (<1.5s) and only on first call.
  if (queueSystem.ready && typeof queueSystem.ready.then === 'function') {
    await queueSystem.ready;
  }

  const jobPayload = {
    ...payload,
    stage: STAGES.QUEUED,
    enqueued_at: new Date().toISOString(),
    request_id: payload.request_id || crypto.randomUUID(),
  };

  const job = await queueSystem.queue.add('ingest-memory', jobPayload, {
    attempts: 3,
    priority: options.priority || payload.priority || 3,
    removeOnComplete: false,
    removeOnFail: false,
    jobId: payload.job_id || payload.idempotency_key,
  });

  return {
    jobId: String(job.id),
    stage: STAGES.QUEUED,
  };
}

module.exports = {
  createIngestionQueue,
  ingest,
  validatePayload,
  InMemoryIngestionQueue,
};
