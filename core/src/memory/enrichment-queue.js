/**
 * EnrichmentQueue — decouple LLM structured enrichment from save hot path.
 *
 * Design:
 *   • In-process async worker with concurrency cap (default 2)
 *   • Idempotency via source_metadata.metadata.enrichment_status
 *     (read inside enrichMemoryStructured itself — queue just routes work)
 *   • Restart-safe: jobs in_progress at restart become re-enqueueable via
 *     orphan recovery (status >5min old → eligible) handled by backfill endpoint
 *   • Optional BullMQ backend: only used when `ENRICHMENT_QUEUE_MODE=bullmq`
 *     AND ingestion-queue Redis probe already succeeded (avoids duplicate probes)
 *
 * Why not BullMQ-by-default:
 *   Redis hostname drifts on Coolify rebuilds (REDIS_HOST_FALLBACKS pattern
 *   in ingestion/queue.js). In-memory is sufficient because:
 *     (a) backfill endpoint re-enqueues anything stuck on restart
 *     (b) idempotency lock prevents duplicate enrichment work
 *     (c) save hot path already returns before enrichment runs
 *
 * Public API:
 *   const q = new EnrichmentQueue({ engine, concurrency, logger });
 *   q.enqueue(memoryId, { content, title, tags });   // returns immediately
 *   q.size();          // pending + running
 *   q.stats();         // { pending, running, completed, failed, total }
 */

import { orgIsRemote } from '../vector/mneme/driver.js';

const DEFAULT_CONCURRENCY = Number(process.env.ENRICHMENT_CONCURRENCY || 2);
const MAX_QUEUE_SIZE = Number(process.env.ENRICHMENT_MAX_QUEUE || 10000);

export class EnrichmentQueue {
  constructor({ engine, concurrency = DEFAULT_CONCURRENCY, logger = console } = {}) {
    if (!engine || typeof engine.enrichMemoryStructured !== 'function') {
      throw new Error('EnrichmentQueue requires engine with enrichMemoryStructured');
    }
    this.engine = engine;
    this.concurrency = Math.max(1, concurrency);
    this.logger = logger;
    this.pending = []; // [{ memoryId, payload, orgId, enqueuedAt }]
    this.running = new Set(); // memoryIds in flight (dedup)
    this.counters = { enqueued: 0, completed: 0, failed: 0, dropped: 0 };
  }

  /**
   * Add a memory to the enrichment queue. Drops silently if memoryId is
   * already pending/running (idempotent at queue level too) or if queue
   * is over capacity.
   */
  enqueue(memoryId, payload = {}) {
    if (!memoryId) return false;
    if (this.running.has(memoryId)) return false;
    if (this.pending.find((j) => j.memoryId === memoryId)) return false;
    if (this.pending.length >= MAX_QUEUE_SIZE) {
      this.counters.dropped += 1;
      this.logger.warn?.(`[enrichment-queue] full (${MAX_QUEUE_SIZE}) — dropping ${memoryId.slice(0, 8)}`);
      return false;
    }
    const orgId = payload?.orgId || payload?.org_id || null;
    this.pending.push({ memoryId, payload, orgId, enqueuedAt: Date.now() });
    this.counters.enqueued += 1;
    setImmediate(() => this._drain());
    return true;
  }

  /**
   * Enqueue many — returns count actually added.
   */
  enqueueBatch(items) {
    let added = 0;
    for (const it of items) {
      if (this.enqueue(it.memoryId, it.payload || {})) added += 1;
    }
    return added;
  }

  size() {
    return this.pending.length + this.running.size;
  }

  stats() {
    return {
      pending: this.pending.length,
      running: this.running.size,
      concurrency: this.concurrency,
      ...this.counters,
    };
  }

  async _drain() {
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      this.running.add(job.memoryId);
      this._runJob(job).finally(() => {
        this.running.delete(job.memoryId);
        // Continue draining — fresh tick to avoid deep recursion.
        if (this.pending.length > 0) setImmediate(() => this._drain());
      });
    }
  }

  async _runJob(job) {
    const startedAt = Date.now();
    // RESIDENCY: structured enrichment writes back to central source_metadata/memory rows, which don't
    // exist for an agent-org. Skip for remote orgs (agent-side enrichment is a tracked follow-up). The
    // memory + recall are unaffected. Managed/personal → enrich as normal.
    if (job.orgId && orgIsRemote(job.orgId)) { this.counters.completed += 1; return; }
    try {
      const ctx = globalThis.__hivemindOrgCtx;
      const run = job.orgId && ctx?.runWithOrg
        ? (fn) => ctx.runWithOrg(job.orgId, fn)
        : (fn) => fn();
      const result = await run(() => this.engine.enrichMemoryStructured(job.memoryId, job.payload));
      const dur = Date.now() - startedAt;
      if (result) {
        this.counters.completed += 1;
        this.logger.log?.(`[enrichment-queue] ✓ ${job.memoryId.slice(0, 8)} in ${dur}ms`);
      } else {
        this.counters.failed += 1;
        this.logger.warn?.(`[enrichment-queue] ✗ ${job.memoryId.slice(0, 8)} returned null (${dur}ms) — see enrichment_error on source_metadata`);
      }
    } catch (err) {
      this.counters.failed += 1;
      this.logger.warn?.(`[enrichment-queue] ✗ ${job.memoryId.slice(0, 8)} threw: ${err.message}`);
    }
  }
}

/**
 * Module-level singleton — instantiated lazily once engine is available.
 * server.js calls getEnrichmentQueue(engine) on first use.
 */
let _singleton = null;
export function getEnrichmentQueue(engine) {
  if (!_singleton && engine) {
    _singleton = new EnrichmentQueue({ engine });
  }
  return _singleton;
}
