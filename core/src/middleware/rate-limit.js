/**
 * Per-org token-bucket rate limit.
 *
 * In-memory, refilled per-second from RATE_LIMIT_RPM_PER_ORG.
 * Replace with Redis-backed if running multi-instance.
 *
 * Usage:
 *   const { allowOrgRequest } = require('./middleware/rate-limit.js');
 *   if (!allowOrgRequest(orgId)) return jsonResponse(res, { error: 'rate_limited' }, 429);
 */

const DEFAULT_RPM = Number(process.env.RATE_LIMIT_RPM_PER_ORG || 120);
const BURST_MULTIPLIER = Number(process.env.RATE_LIMIT_BURST_X || 2);

const buckets = new Map(); // orgId → { tokens, lastRefill }

export function allowOrgRequest(orgId, { rpm = DEFAULT_RPM } = {}) {
  if (!orgId) return true; // unscoped requests handled elsewhere
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
