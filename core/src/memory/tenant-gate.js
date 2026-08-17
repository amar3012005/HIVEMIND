/**
 * Per-tenant concurrency gate for expensive endpoints (graph queries, etc.)
 *
 * Prevents single-tenant abuse from saturating shared resources:
 *  - Caps in-flight requests per (tenantId, endpoint) tuple at MAX_INFLIGHT
 *  - Subsequent calls await release of any prior request — no spawn
 *  - Bounds each tenant's FIFO and removes disconnected waiters immediately
 *  - Observes overdue owners without releasing work that is still running
 *
 * Used by /api/graph and any other endpoint where a single tenant
 * could otherwise issue N parallel expensive queries.
 *
 * Note: in-process state — works per-replica. For cross-replica
 * gating use Redis distributed lock (overkill here; if a tenant
 * hits replica A then B in parallel, that's 2 concurrent, still bounded).
 */

const MAX_INFLIGHT_PER_TENANT = 2;
const MAX_QUEUED_PER_TENANT = 16;
const QUEUE_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 30 * 1000; // overdue-owner observation threshold

const inflight = new Map(); // key -> { count, waiters: [{resolve, timer}] }

function keyFor(tenantId, endpoint) {
  return `${tenantId}::${endpoint}`;
}

/**
 * Acquire a slot. Returns a release function.
 * If already at MAX_INFLIGHT, waits up to QUEUE_TIMEOUT_MS for a slot.
 * Throws TimeoutError if gate doesn't open in time.
 */
export async function acquireTenantSlot(tenantId, endpoint, options = {}) {
  const maxInflight = Math.max(1, Number(options.maxInflight || MAX_INFLIGHT_PER_TENANT));
  const queueTimeoutMs = Math.max(1, Number(options.queueTimeoutMs || QUEUE_TIMEOUT_MS));
  const requestTimeoutMs = Math.max(1, Number(options.requestTimeoutMs || REQUEST_TIMEOUT_MS));
  const maxQueued = Math.max(0, Number(options.maxQueued ?? MAX_QUEUED_PER_TENANT));
  const signal = options.signal || null;
  const key = keyFor(tenantId, endpoint);
  let entry = inflight.get(key);
  if (!entry) {
    entry = { count: 0, waiters: [] };
    inflight.set(key, entry);
  }

  if (signal?.aborted) throw signal.reason || new Error(`Tenant slot wait cancelled for ${endpoint}`);

  if (entry.count < maxInflight) {
    entry.count++;
    return makeRelease(key, { maxInflight, requestTimeoutMs });
  }

  // Wait for a slot
  if (entry.waiters.length >= maxQueued) {
    const busy = new Error(`Tenant queue full for ${endpoint}`);
    busy.code = 'TENANT_QUEUE_FULL';
    throw busy;
  }
  return new Promise((resolve, reject) => {
    const removeWaiter = () => {
      const idx = entry.waiters.indexOf(waiter);
      if (idx >= 0) entry.waiters.splice(idx, 1);
      if (entry.count === 0 && entry.waiters.length === 0) inflight.delete(key);
    };
    const timer = setTimeout(() => {
      removeWaiter();
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Tenant slot wait timeout for ${endpoint}`));
    }, queueTimeoutMs);

    const waiterResolve = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      entry.count++;
      resolve(makeRelease(key, { maxInflight, requestTimeoutMs }));
    };
    const onAbort = () => {
      clearTimeout(timer);
      removeWaiter();
      reject(signal.reason || new Error(`Tenant slot wait cancelled for ${endpoint}`));
    };
    const waiter = { resolve: waiterResolve, timer, maxInflight };
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.waiters.push(waiter);
  });
}

function makeRelease(key, { maxInflight, requestTimeoutMs }) {
  let released = false;
  const hardTimeout = setTimeout(() => {
    if (!released) {
      // Observe the overdue owner but keep the slot occupied. Releasing while
      // the underlying work is still running would let a wedged tenant exceed
      // its cap and defeat the isolation boundary. Stage deadlines or socket
      // close remain responsible for cancelling/releasing the actual request.
      console.warn(`[tenant-gate] Slot owner for ${key} is still running after ${requestTimeoutMs}ms`);
    }
  }, requestTimeoutMs);
  hardTimeout.unref?.();

  function release() {
    if (released) return;
    released = true;
    clearTimeout(hardTimeout);
    const entry = inflight.get(key);
    if (!entry) return;
    entry.count = Math.max(0, entry.count - 1);
    // Wake next waiter
    if (entry.waiters.length > 0 && entry.count < maxInflight) {
      const next = entry.waiters.shift();
      if (next) next.resolve();
    }
    // GC empty entries
    if (entry.count === 0 && entry.waiters.length === 0) {
      inflight.delete(key);
    }
  }
  return release;
}

/** Hold a tenant slot until the HTTP response finishes or disconnects. */
export async function acquireTenantRequestSlot(req, res, tenantId, endpoint, options = {}) {
  const controller = new AbortController();
  const abortQueued = () => {
    if (!controller.signal.aborted) controller.abort(new Error(`Client disconnected while waiting for ${endpoint}`));
  };
  res.once('close', abortQueued);
  let release;
  try {
    release = await acquireTenantSlot(tenantId, endpoint, { ...options, signal: controller.signal });
  } catch (error) {
    res.removeListener('close', abortQueued);
    throw error;
  }

  let completed = false;
  const finish = () => {
    if (completed) return;
    completed = true;
    res.removeListener('finish', finish);
    res.removeListener('close', close);
    res.removeListener('close', abortQueued);
    release();
  };
  const close = () => {
    abortQueued();
    finish();
  };
  res.once('finish', finish);
  res.once('close', close);
  return finish;
}

export function getGateStats() {
  const stats = { totalKeys: inflight.size, slots: [] };
  for (const [key, entry] of inflight) {
    stats.slots.push({
      key,
      inflight: entry.count,
      waiting: entry.waiters.length,
    });
  }
  return stats;
}

export const TENANT_GATE_TUNING = {
  MAX_INFLIGHT_PER_TENANT,
  MAX_QUEUED_PER_TENANT,
  QUEUE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
};
