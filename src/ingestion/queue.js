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

function createIngestionQueue(options = {}) {
  const bullmqDeps = tryLoadBullMQ();

  if (!bullmqDeps || options.forceInMemory === true) {
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

  const { bullmq, IORedis } = bullmqDeps;
  const connection = new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  });

  const queue = new bullmq.Queue(options.queueName || DEFAULT_QUEUE_NAME, { connection });
  const dlq = new bullmq.Queue(options.dlqName || DEFAULT_DLQ_NAME, { connection });

  return {
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
}

async function ingest(payload, queueSystem, options = {}) {
  validatePayload(payload);

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
