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
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ org_id: orgId, user_id: userId }),
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
