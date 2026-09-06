/**
 * Fail-closed gate for the use_tools:false "Enable tools for this request" HITL.
 * Cloudflare Flagship is the authoritative decision source. Any unavailable
 * or malformed evaluation keeps today's native v2 path.
 */
export const ENABLE_TOOLS_HITL_FLAGSHIP_KEY = 'enable-tools-hitl';

const DEFAULT_FLAG_URL = 'https://admin.hivemind.singulancelabs.com/__hivemind/feature-flags/enable-tools-hitl';

export async function isEnableToolsHitlEnabled(env = process.env, options = {}) {
  if (options.flagshipEnabled === true) return true;
  if (options.flagshipEnabled === false) return false;
  const endpoint = String(env?.ENABLE_TOOLS_HITL_FLAG_URL || env?.CLOUDFLARE_FEATURE_FLAGS_URL || DEFAULT_FLAG_URL).trim();
  if (!endpoint) return false;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return false;
  try {
    const response = await fetchImpl(endpoint, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs || 2000),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.key === ENABLE_TOOLS_HITL_FLAGSHIP_KEY
      && payload?.source === 'cloudflare-flagship'
      && payload?.enabled === true;
  } catch {
    return false;
  }
}
