/**
 * Process-wide embedding admission controller.
 *
 * Bulk ingestion used to create one HTTP request per segment with a concurrency
 * limit that applied PER DOCUMENT. Ten simultaneous documents therefore turned
 * `concurrency=8` into eighty provider calls and exhausted both the primary and
 * fallback. This controller is the shared boundary below every embedding caller.
 *
 * Interactive work is selected first, while ingestion/maintenance remain
 * tenant-fair and bounded. The queue never manufactures vectors or drops work:
 * callers either receive the real provider result or an explicit error which is
 * persisted as `vectorStored=false` and recovered by the reconcilers.
 */

const PRIORITY = Object.freeze({ interactive: 0, ingestion: 1, maintenance: 2 });

function positiveInt(value, fallback, max = 10_000) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export class EmbeddingAdmissionController {
  constructor({
    maxConcurrent = positiveInt(process.env.EMBEDDING_MAX_CONCURRENCY, 4, 64),
    maxPerTenant = positiveInt(process.env.EMBEDDING_MAX_CONCURRENCY_PER_TENANT, 2, 32),
    maxQueue = positiveInt(process.env.EMBEDDING_MAX_QUEUE, 512, 20_000),
  } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxPerTenant = Math.min(maxPerTenant, maxConcurrent);
    this.maxQueue = maxQueue;
    this.active = 0;
    this.activeByTenant = new Map();
    this.queue = [];
    this.lastTenantByPriority = new Map();
    this.counters = { admitted: 0, completed: 0, failed: 0, aborted: 0, rejected: 0 };
  }

  run(task, { tenantId = 'shared', workload = 'interactive', signal } = {}) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('embedding admission task must be a function'));
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('embedding admission aborted'));
    if (this.queue.length >= this.maxQueue) {
      this.counters.rejected += 1;
      return Promise.reject(new Error(`embedding admission queue full (${this.maxQueue})`));
    }
    const priority = PRIORITY[workload] ?? PRIORITY.interactive;
    const tenant = String(tenantId || 'shared');
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, tenant, workload, priority, enqueuedAt: Date.now(), signal, abort: null };
      if (signal) {
        entry.abort = () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) {
            this.queue.splice(index, 1);
            this.counters.aborted += 1;
            reject(signal.reason || new Error('embedding admission aborted'));
          }
        };
        signal.addEventListener('abort', entry.abort, { once: true });
      }
      this.queue.push(entry);
      this._drain();
    });
  }

  _nextRunnableIndex() {
    if (this.active >= this.maxConcurrent || !this.queue.length) return -1;
    for (let priority = 0; priority <= 2; priority += 1) {
      const eligible = [];
      for (let i = 0; i < this.queue.length; i += 1) {
        const entry = this.queue[i];
        if (entry.priority !== priority) continue;
        if ((this.activeByTenant.get(entry.tenant) || 0) >= this.maxPerTenant) continue;
        eligible.push(i);
      }
      if (!eligible.length) continue;
      const lastTenant = this.lastTenantByPriority.get(priority);
      return eligible.find((i) => this.queue[i].tenant !== lastTenant) ?? eligible[0];
    }
    return -1;
  }

  _drain() {
    while (this.active < this.maxConcurrent) {
      const index = this._nextRunnableIndex();
      if (index < 0) break;
      const [entry] = this.queue.splice(index, 1);
      if (entry.abort) entry.signal.removeEventListener('abort', entry.abort);
      this.active += 1;
      this.activeByTenant.set(entry.tenant, (this.activeByTenant.get(entry.tenant) || 0) + 1);
      this.lastTenantByPriority.set(entry.priority, entry.tenant);
      this.counters.admitted += 1;
      Promise.resolve().then(entry.task).then(
        (value) => { this.counters.completed += 1; entry.resolve(value); },
        (error) => { this.counters.failed += 1; entry.reject(error); },
      ).finally(() => {
        this.active -= 1;
        const remaining = (this.activeByTenant.get(entry.tenant) || 1) - 1;
        if (remaining > 0) this.activeByTenant.set(entry.tenant, remaining);
        else this.activeByTenant.delete(entry.tenant);
        this._drain();
      });
    }
  }

  stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      max_concurrent: this.maxConcurrent,
      max_per_tenant: this.maxPerTenant,
      queued_by_workload: this.queue.reduce((out, item) => {
        out[item.workload] = (out[item.workload] || 0) + 1;
        return out;
      }, {}),
      ...this.counters,
    };
  }
}

let singleton = null;
export function getEmbeddingAdmissionController() {
  if (!singleton) singleton = new EmbeddingAdmissionController();
  return singleton;
}

export function resetEmbeddingAdmissionControllerForTests() {
  singleton = null;
}

