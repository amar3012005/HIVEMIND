/**
 * In-process cache for /api/graph results (Phase 7 of GRAPH_MEMORY_UPGRADE).
 *
 * Caches the assembled response by request signature. Short TTL keeps stale
 * data bounded; FE auto-refresh hits the cache and avoids the 6-query waterfall.
 *
 * No invalidation on writes today — TTL is conservative (15s). For tighter
 * freshness, the caller can clear via clearGraphCache(userId).
 *
 * NOT a substitute for a materialized view; this is a no-migration quick win.
 */

const TTL_MS = 15 * 1000;
const MAX_ENTRIES = 200;

const cache = new Map();

function buildKey(parts) {
  return Object.entries(parts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v == null ? '' : String(v)}`)
    .join('|');
}

export function getGraphCache(parts) {
  const key = buildKey(parts);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function setGraphCache(parts, value) {
  const key = buildKey(parts);
  if (cache.size >= MAX_ENTRIES) {
    // Drop oldest entry — simple FIFO eviction
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { ts: Date.now(), value });
}

export function clearGraphCache(userIdOrOrgId = null) {
  if (!userIdOrOrgId) {
    cache.clear();
    return;
  }
  const needle = String(userIdOrOrgId);
  for (const key of cache.keys()) {
    if (key.includes(`userId=${needle}`) || key.includes(`orgId=${needle}`)) {
      cache.delete(key);
    }
  }
}

export const GRAPH_CACHE_TUNING = { TTL_MS, MAX_ENTRIES };
