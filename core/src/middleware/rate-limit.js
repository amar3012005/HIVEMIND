/**
 * Per-org token-bucket rate limit.
 *
 * Backed by Redis when REDIS_HOST set (multi-instance safe via INCR+EXPIRE),
 * falls back to in-memory bucket for single-instance dev. The Redis path
 * uses a fixed-window counter rather than a true bucket — simpler and
 * sufficient since the window is 1 minute.
 *
 * Tune via:
 *   RATE_LIMIT_RPM_PER_ORG  (default 120)
 *   RATE_LIMIT_BURST_X      (default 2)
 *   RATE_LIMIT_BACKEND      ('redis' | 'memory' | auto-detect)
 */

const DEFAULT_RPM = Number(process.env.RATE_LIMIT_RPM_PER_ORG || 120);
const BURST_MULTIPLIER = Number(process.env.RATE_LIMIT_BURST_X || 2);

const buckets = new Map(); // orgId → { tokens, lastRefill }

let redisClient = null;
let redisInitDone = false;
async function getRedis() {
  if (redisInitDone) return redisClient;
  redisInitDone = true;
  const backend = process.env.RATE_LIMIT_BACKEND;
  if (backend === 'memory') return null;
  if (backend !== 'redis' && !process.env.REDIS_HOST) return null;
  try {
    const { default: Redis } = await import('ioredis');
    redisClient = new Redis({
      host: process.env.REDIS_HOST || 'redis',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    await redisClient.connect();
  } catch (err) {
    console.warn(`[rate-limit] redis init failed → in-memory fallback: ${err.message}`);
    redisClient = null;
  }
  return redisClient;
}

// Synchronous in-memory check (fast path on cache miss / no redis).
function allowOrgRequestMemory(orgId, rpm) {
  const cap = rpm * BURST_MULTIPLIER;
  const refillPerMs = rpm / 60_000;
  const now = Date.now();
  let b = buckets.get(orgId);
  if (!b) {
    b = { tokens: cap, lastRefill: now };
    buckets.set(orgId, b);
  } else {
    const elapsed = now - b.lastRefill;
    b.tokens = Math.min(cap, b.tokens + elapsed * refillPerMs);
    b.lastRefill = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Redis fixed-window counter. Window = 60s, cap = rpm × burst.
// Fire-and-forget — if Redis is slow we don't block the request path.
function allowOrgRequestRedis(orgId, rpm) {
  const cap = rpm * BURST_MULTIPLIER;
  const window = Math.floor(Date.now() / 60_000);
  const key = `rl:${orgId}:${window}`;
  // Synchronous decision: we eagerly use in-memory, then async-fire Redis
  // to keep counters synchronised. Cross-instance enforcement happens on
  // the next request — acceptable for our 60s window.
  const localOk = allowOrgRequestMemory(orgId, rpm);
  (async () => {
    try {
      const cli = await getRedis();
      if (!cli) return;
      const n = await cli.incr(key);
      if (n === 1) await cli.expire(key, 90);
      if (n > cap) {
        // Sync local bucket down so subsequent requests reject too.
        const b = buckets.get(orgId);
        if (b) b.tokens = 0;
      }
    } catch { /* ignore */ }
  })();
  return localOk;
}

export function allowOrgRequest(orgId, { rpm = DEFAULT_RPM } = {}) {
  if (!orgId) return true;
  if (process.env.REDIS_HOST || process.env.RATE_LIMIT_BACKEND === 'redis') {
    return allowOrgRequestRedis(orgId, rpm);
  }
  return allowOrgRequestMemory(orgId, rpm);
}

export function getRateLimitStats() {
  const out = [];
  for (const [orgId, b] of buckets) {
    out.push({
      org_id: orgId,
      tokens_remaining: Math.floor(b.tokens),
      last_refill_at: new Date(b.lastRefill).toISOString(),
    });
  }
  return out;
}
