/**
 * EntityLinkQueue — ONE global, bounded-concurrency worker pool for the
 * entity-co-mention LLM (entity:* tag extraction + co-mention edges).
 *
 * WHY THIS EXISTS (the bottleneck it fixes):
 *   ingestMemory used to run the ~2s entity-link LLM INSIDE the per-user
 *   advisory lock. Under burst (e.g. 277 writes to one userId, 16 workers)
 *   every write serialized on that lock through the LLM → lock held >180s →
 *   Prisma txn timeout → rows dropped; and the lock accidentally throttled
 *   entity-LLM concurrency to ~1/user. Naively deferring the LLM out of the
 *   lock removes the throttle → 16 concurrent Groq calls → blows past Groq's
 *   tokens-per-minute → calls 429 → rows persist UNtagged.
 *
 *   The correct fix is to (a) take the LLM out of the lock AND (b) funnel ALL
 *   entity-link work through ONE globally bounded pool so Groq pressure is
 *   capped regardless of how many ingests fire concurrently. The 3x retry in
 *   _attachEntityCoMentionEdges then actually lands instead of dog-piling.
 *
 * Mirrors EnrichmentQueue (restart-tolerant, counters, setImmediate drain).
 * Best-effort: a failed link never blocks ingest — the row is already
 * committed; tags are eventually-consistent (land seconds later).
 */

const DEFAULT_CONCURRENCY = Math.max(1, Number(process.env.ENTITY_LINK_QUEUE_CONCURRENCY || 4));
const MAX_JOB_ATTEMPTS = Math.max(1, Number(process.env.ENTITY_LINK_QUEUE_ATTEMPTS || 2));
const RETRY_DELAY_MS = Math.max(1000, Number(process.env.ENTITY_LINK_QUEUE_RETRY_MS || 5000));
const MAX_QUEUE_SIZE = Math.max(100, Number(process.env.ENTITY_LINK_QUEUE_MAX || 10000));

export class EntityLinkQueue {
  constructor({ engine, concurrency = DEFAULT_CONCURRENCY, logger = console } = {}) {
    if (!engine || typeof engine._attachEntityCoMentionEdges !== 'function') {
      throw new Error('EntityLinkQueue requires engine with _attachEntityCoMentionEdges');
    }
    this.engine = engine;
    this.concurrency = Math.max(1, concurrency);
    this.pending = [];           // [{ key, memory?, memoryId, enqueuedAt }]
    this.running = new Set();    // keys in flight (dedup)
    this.queuedKeys = new Set(); // keys pending (dedup)
    this.counters = { enqueued: 0, completed: 0, failed: 0, dropped: 0 };
    this.logger = logger;
  }

  /** Enqueue a memory (object preferred — avoids a reload) or an id string.
   *  peers = same-batch sibling memories passed as explicit co-mention candidates. */
  enqueue(memoryOrId, peers = null) {
    if (!memoryOrId) return false;
    const memory = typeof memoryOrId === 'object' ? memoryOrId : null;
    const memoryId = memory ? memory.id : String(memoryOrId);
    if (!memoryId) return false;
    if (this.running.has(memoryId) || this.queuedKeys.has(memoryId)) {
      this.counters.dropped += 1; // already queued/in-flight — idempotent
      return false;
    }
    if (this.pending.length >= MAX_QUEUE_SIZE) {
      this.counters.dropped += 1;
      this.logger.warn?.(`[entity-link-queue] capacity ${MAX_QUEUE_SIZE} reached; ${memoryId.slice(0, 8)} remains eligible for durable backfill`);
      return false;
    }
    this.queuedKeys.add(memoryId);
    // Capture the request's API key NOW (enqueue runs inside the request/ingest-worker context) so the
    // detached drain can attribute this memory's entity-link LLM spend to the originating org key.
    const apiKeyId = (() => { try { return globalThis.__hivemindOrgCtx?.currentApiKey?.() || null; } catch { return null; } })();
    this.pending.push({ key: memoryId, memory, memoryId, apiKeyId, peers, attempt: 1, enqueuedAt: Date.now() });
    this.counters.enqueued += 1;
    setImmediate(() => this._drain());
    return true;
  }

  /** Enqueue many memory objects/ids. Returns count actually queued. */
  enqueueBatch(items) {
    if (!Array.isArray(items)) return 0;
    // Same-batch peers (e.g. all memories promoted from ONE KB doc) are passed as explicit co-mention
    // candidates so siblings sharing entities link to each other in a SINGLE pass — independent of the
    // async tag/commit timing that otherwise leaves intra-doc memories disconnected (the "0 survived"
    // gap). Content-bearing so the linker's entity content-fallback matches even before tags attach.
    const objs = items.filter((it) => it && typeof it === 'object' && it.id);
    const peerPool = objs.map((o) => ({ id: o.id, content: o.content, title: o.title, tags: o.tags || [] }));
    let added = 0;
    for (const it of items) {
      const id = typeof it === 'object' ? it?.id : it;
      const peers = (peerPool.length > 1 && id)
        ? peerPool.filter((p) => p.id !== id).slice(0, 12)
        : null;
      if (this.enqueue(it, peers)) added += 1;
    }
    return added;
  }

  stats() {
    return {
      concurrency: this.concurrency,
      pending: this.pending.length,
      running: this.running.size,
      ...this.counters,
    };
  }

  async _drain() {
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      this.queuedKeys.delete(job.key);
      this.running.add(job.key);
      this._runJob(job).finally(() => {
        this.running.delete(job.key);
        if (this.pending.length > 0) setImmediate(() => this._drain());
      });
    }
  }

  async _runJob(job) {
    try {
      const memory = job.memory || (this.engine.store && typeof this.engine.store.getMemory === 'function'
        ? await this.engine.store.getMemory(job.memoryId)
        : null);
      if (!memory) { this.counters.failed += 1; return; }
      // similar=[] — _attachEntityCoMentionEdges self-fetches tag-overlap
      // candidates; entity TAG extraction works from the memory's own content
      // regardless of candidates. Its internal 3x retry/backoff handles 429.
      // Re-establish the org context (this is a detached setImmediate drain — the request-scope
      // context is gone), so the split client + .amr edge/tag routing resolve to the org's store.
      const _org = memory.org_id || memory.orgId;
      const _ctx = globalThis.__hivemindOrgCtx;
      const _run = (_org && _ctx && _ctx.runWithOrg)
        ? (fn) => _ctx.runWithOrg(_org, fn, job.apiKeyId || null)
        : (fn) => fn();
      const peers = Array.isArray(job.peers) ? job.peers : [];
      const result = await _run(() => this.engine._attachEntityCoMentionEdges(memory, this.engine.store, peers));
      if (!result || result.ok !== true) {
        this.counters.failed += 1;
        this.logger.warn?.(`[entity-link-queue] ✗ ${String(job.memoryId).slice(0, 8)} ${result.error || 'fallback'} — fallback entities retained; durable retry eligible`);
        if ((job.attempt || 1) < MAX_JOB_ATTEMPTS) {
          const nextJob = { ...job, attempt: (job.attempt || 1) + 1, enqueuedAt: Date.now() + RETRY_DELAY_MS };
          setTimeout(() => {
            if (this.running.has(job.memoryId) || this.queuedKeys.has(job.memoryId)) return;
            this.queuedKeys.add(job.memoryId);
            this.pending.push(nextJob);
            this.counters.enqueued += 1;
            this._drain();
          }, RETRY_DELAY_MS);
        }
        return;
      }
      this.counters.completed += 1;
    } catch (err) {
      this.counters.failed += 1;
      this.logger.warn?.(`[entity-link-queue] ✗ ${String(job.memoryId).slice(0, 8)}: ${err.message}`);
    }
  }
}

let _singleton = null;
export function getEntityLinkQueue(engine) {
  if (!_singleton && engine) _singleton = new EntityLinkQueue({ engine });
  return _singleton;
}
