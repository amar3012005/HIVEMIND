export const HIVE_HARNESS_CHAT_FLAG_KEY = 'hivemind_harness_chat_v1';
const MODES = new Set(['legacy', 'preview', 'harness']);

export async function evaluateHarnessChatFlag({
  endpoint,
  secret,
  orgId,
  userId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2000,
} = {}) {
  const legacy = { mode: 'legacy', flagReceipt: { key: HIVE_HARNESS_CHAT_FLAG_KEY, variation: 'legacy' } };
  if (!endpoint || !secret || typeof fetchImpl !== 'function') return legacy;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(endpoint);
    url.searchParams.set('org_id', orgId);
    url.searchParams.set('user_id', userId);
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    if (!response.ok) return legacy;
    const payload = await response.json();
    if (payload?.key !== HIVE_HARNESS_CHAT_FLAG_KEY || payload?.source !== 'cloudflare-flagship'
        || !MODES.has(payload?.variation)) return legacy;
    return {
      mode: payload.variation,
      flagReceipt: {
        key: HIVE_HARNESS_CHAT_FLAG_KEY,
        variation: payload.variation,
        ...(payload.evaluation_id ? { evaluation_id: payload.evaluation_id } : {}),
      },
    };
  } catch {
    return legacy;
  } finally {
    clearTimeout(timer);
  }
}
