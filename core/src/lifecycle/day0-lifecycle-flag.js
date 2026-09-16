import { resolvePublicFrontendBaseUrl } from '../public-frontend-url.js';

export const DAY0_LIFECYCLE_FLAG_KEY = 'day0-lifecycle';

// Flagship is the sole Day-0 rollout authority. The edge evaluates the flag
// against the authenticated org/user supplied by Core and fails closed.
export async function isDayZeroLifecycleEnabled({
  orgId,
  userId,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2000,
} = {}) {
  const secret = String(env.HIVE_HARNESS_EDGE_EVAL_SECRET || '').trim();
  if (!orgId || !userId || !secret || typeof fetchImpl !== 'function') return false;
  const endpoint = `${resolvePublicFrontendBaseUrl(env.HIVEMIND_PUBLIC_ORIGIN || env.HIVEMIND_FRONTEND_URL)}/__hivemind/feature-flags/day0-lifecycle`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ org_id: orgId, user_id: userId }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.key === DAY0_LIFECYCLE_FLAG_KEY
      && payload?.source === 'cloudflare-flagship'
      && payload?.enabled === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
