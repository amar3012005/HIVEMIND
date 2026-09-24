import { resolvePublicFrontendBaseUrl } from '../public-frontend-url.js';

// One Flagship switch owns every deterministic stage before the company is
// fully activated.  The dedicated edge endpoint remains stable so callers do
// not need to know rollout-provider details.
export const DAY0_LIFECYCLE_FLAG_KEY = 'pre_onboarding_lifecycle_v1';
export const DAY0_REPORT_EDITORIAL_FLAG_KEY = 'day0_report_editorial_v1';

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
  const endpoint = `${resolvePublicFrontendBaseUrl(env.HIVEMIND_PUBLIC_ORIGIN || env.HIVEMIND_FRONTEND_URL)}/__hivemind/feature-flags/day0-onboarding`;
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

/**
 * The report layout has its own tenant-scoped Flagship decision. A missing,
 * malformed, or unavailable receipt preserves the current PDF renderer.
 */
export async function isDayZeroEditorialReportEnabled({
  orgId,
  userId,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2000,
} = {}) {
  const secret = String(env.HIVE_HARNESS_EDGE_EVAL_SECRET || '').trim();
  if (!orgId || !userId || !secret || typeof fetchImpl !== 'function') return false;
  const endpoint = `${resolvePublicFrontendBaseUrl(env.HIVEMIND_PUBLIC_ORIGIN || env.HIVEMIND_FRONTEND_URL)}/__hivemind/feature-flags/day0-onboarding`;
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
      && payload?.report_flag_key === DAY0_REPORT_EDITORIAL_FLAG_KEY
      && payload?.report_editorial_enabled === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
