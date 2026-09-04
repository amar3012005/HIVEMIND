/**
 * Fail-closed gate for the durable Composio-session chat agent.
 * Both Core env USE_TOOLS_DURABLE_AGENT=true AND Cloudflare Flagship
 * enabled:true (source cloudflare-flagship) are required. Any other
 * combination keeps today's chat path.
 */
export const USE_TOOLS_DURABLE_AGENT_FLAG = 'USE_TOOLS_DURABLE_AGENT';
export const USE_TOOLS_DURABLE_AGENT_FLAGSHIP_KEY = 'use-tools-durable-agent';

const DEFAULT_FLAG_URL = 'https://admin.hivemind.singulancelabs.com/__hivemind/feature-flags/use-tools-durable-agent';

export function isUseToolsDurableAgentEnvEnabled(env = process.env) {
  return String(env?.USE_TOOLS_DURABLE_AGENT || '').trim() === 'true';
}

export async function isUseToolsDurableAgentEnabled(env = process.env, options = {}) {
  if (!isUseToolsDurableAgentEnvEnabled(env)) return false;
  if (options.flagshipEnabled === true) return true;
  if (options.flagshipEnabled === false) return false;
  const endpoint = String(env?.USE_TOOLS_DURABLE_AGENT_FLAG_URL || env?.CLOUDFLARE_FEATURE_FLAGS_URL || DEFAULT_FLAG_URL).trim();
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
    return payload?.key === USE_TOOLS_DURABLE_AGENT_FLAGSHIP_KEY
      && payload?.source === 'cloudflare-flagship'
      && payload?.enabled === true;
  } catch {
    return false;
  }
}
