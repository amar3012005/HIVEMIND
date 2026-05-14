/**
 * Per-tenant concurrency gate for expensive endpoints (graph queries, etc.)
 *
 * Prevents single-tenant abuse from saturating shared resources:
 *  - Caps in-flight requests per (userId, endpoint) tuple at MAX_INFLIGHT
 *  - Subsequent calls await release of any prior request — no spawn
 *  - Hard timeout so a wedged request can't block the gate forever
 *
 * Used by /api/graph and any other endpoint where a single tenant
 * could otherwise issue N parallel expensive queries.
 *
 * Note: in-process state — works per-replica. For cross-replica
 * gating use Redis distributed lock (overkill here; if a tenant
 * hits replica A then B in parallel, that's 2 concurrent, still bounded).
 */

const MAX_INFLIGHT_PER_TENANT = 2;
const QUEUE_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 30 * 1000; // hard cap

const inflight = new Map(); // key -> { count, waiters: [{resolve, timer}] }

function keyFor(tenantId, endpoint) {
  return `${tenantId}::${endpoint}`;
}

/**
 * Acquire a slot. Returns a release function.
 * If already at MAX_INFLIGHT, waits up to QUEUE_TIMEOUT_MS for a slot.
 * Throws TimeoutError if gate doesn't open in time.
 */
export async function acquireTenantSlot(tenantId, endpoint) {
  const key = keyFor(tenantId, endpoint);
  let entry = inflight.get(key);
  if (!entry) {
    entry = { count: 0, waiters: [] };
    inflight.set(key, entry);
  }

  if (entry.count < MAX_INFLIGHT_PER_TENANT) {
    entry.count++;
    return makeRelease(key);
  }

  // Wait for a slot
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = entry.waiters.findIndex((w) => w.resolve === waiterResolve);
      if (idx >= 0) entry.waiters.splice(idx, 1);
      reject(new Error(`Tenant slot wait timeout for ${endpoint}`));
    }, QUEUE_TIMEOUT_MS);

    const waiterResolve = () => {
      clearTimeout(timer);
      entry.count++;
      resolve(makeRelease(key));
    };
    entry.waiters.push({ resolve: waiterResolve, timer });
  });
}

function makeRelease(key) {
  let released = false;
  const hardTimeout = setTimeout(() => {
    if (!released) {
      console.warn(`[tenant-gate] Force-releasing wedged slot for ${key} after ${REQUEST_TIMEOUT_MS}ms`);
      release();
    }
  }, REQUEST_TIMEOUT_MS);

  function release() {
    if (released) return;
    released = true;
    clearTimeout(hardTimeout);
    const entry = inflight.get(key);
    if (!entry) return;
    entry.count = Math.max(0, entry.count - 1);
    // Wake next waiter
    if (entry.waiters.length > 0 && entry.count < MAX_INFLIGHT_PER_TENANT) {
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
  QUEUE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
};
