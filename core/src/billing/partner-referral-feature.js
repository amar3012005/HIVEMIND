const DEFAULT_FLAG_URL = 'https://admin.hivemind.singulancelabs.com/__hivemind/feature-flags/partner-referrals';
const FLAG_KEY = 'partner_referrals_v1';
const DEFAULT_CACHE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 2_000;

let cachedEvaluation = null;
let pendingEvaluation = null;

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function resetPartnerReferralFlagCache() {
  cachedEvaluation = null;
  pendingEvaluation = null;
}

async function fetchFlag(endpoint, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return false;

    const payload = await response.json();
    return payload?.key === FLAG_KEY
      && payload?.source === 'cloudflare-flagship'
      && payload?.enabled === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function partnerReferralsEnabled(env = process.env, options = {}) {
  const endpoint = String(env?.CLOUDFLARE_FEATURE_FLAGS_URL || DEFAULT_FLAG_URL).trim();
  if (!endpoint) return false;

  const now = options.now?.() ?? Date.now();
  const cacheMs = boundedNumber(env?.PARTNER_REFERRALS_FLAG_CACHE_MS, DEFAULT_CACHE_MS, 0, 60_000);
  const timeoutMs = boundedNumber(env?.PARTNER_REFERRALS_FLAG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 10_000);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return false;

  if (cachedEvaluation?.endpoint === endpoint && cachedEvaluation.expiresAt > now) {
    return cachedEvaluation.value;
  }

  if (!pendingEvaluation) {
    pendingEvaluation = fetchFlag(endpoint, fetchImpl, timeoutMs)
      .then((value) => {
        cachedEvaluation = { endpoint, value, expiresAt: now + cacheMs };
        return value;
      })
      .finally(() => {
        pendingEvaluation = null;
      });
  }

  return pendingEvaluation;
}
