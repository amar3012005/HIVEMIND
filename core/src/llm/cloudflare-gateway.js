/**
 * Cloudflare AI Gateway transport helpers.
 *
 * This module only changes the HTTP transport. Model selection, provider
 * ordering remain owned by the existing callers. While Gateway is enabled it
 * is the only transport; disabling the feature flag is the explicit direct
 * provider rollback.
 */

const stripSlash = (value) => String(value || '').replace(/\/+$/, '');

export function cloudflareGatewayConfig() {
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const gatewayId = String(process.env.CLOUDFLARE_AI_GATEWAY_ID || '').trim();
  const token = String(process.env.CLOUDFLARE_AI_GATEWAY_TOKEN || '').trim();
  const requested = String(process.env.CLOUDFLARE_AI_GATEWAY_ENABLED || '').toLowerCase() === 'true';
  return { accountId, gatewayId, token, enabled: requested && Boolean(accountId && gatewayId && token) };
}

export function cloudflareGatewayEnabled() { return cloudflareGatewayConfig().enabled; }

function byokAlias(provider) {
  let name = String(provider || '').split(':')[0].trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  name = name.replace(/^CUSTOM_/, '');
  if (name === 'XAI') name = 'GROK';
  return name ? String(process.env[`CLOUDFLARE_AI_GATEWAY_${name}_BYOK_ALIAS`] || '').trim() : '';
}

export function gatewayByokAlias(provider) { return byokAlias(provider); }

export function gatewayProviderForUrl(value) {
  let url;
  try { url = new URL(typeof value === 'string' || value instanceof URL ? String(value) : value?.url); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter';
  if (host === 'api.cerebras.ai') return 'cerebras';
  if (host === 'api.groq.com') return 'groq';
  if (host === 'api.deepgram.com') return 'deepgram';
  if (host === 'api.cartesia.ai') return 'cartesia';
  if (host === 'api.openai.com') return 'openai';
  if (host === 'api.mistral.ai') return 'mistral';
  if (host === 'api.cohere.com' || host === 'api.cohere.ai') return 'cohere';
  if (host === 'api.anthropic.com') return 'anthropic';
  if (host === 'api.together.xyz') return 'together-ai';
  if (host === 'embeddings.singulancelabs.com') {
    return String(process.env.CLOUDFLARE_AI_GATEWAY_BGE_EMBEDDINGS_PROVIDER || '').trim()
      || 'custom-bge-embeddings';
  }
  if (host === 'rerank.singulancelabs.com') {
    return String(process.env.CLOUDFLARE_AI_GATEWAY_BGE_RERANKER_PROVIDER || '').trim()
      || 'custom-bge-reranker';
  }
  // These are custom-provider routes in some accounts. They are opt-in because
  // Cloudflare requires the exact `custom-{slug}` configured in that account.
  if (host === 'api.x.ai') return String(process.env.CLOUDFLARE_AI_GATEWAY_XAI_PROVIDER || '').trim() || null;
  if (host === 'api.blaiq.ai') return String(process.env.CLOUDFLARE_AI_GATEWAY_BLAIQ_PROVIDER || '').trim() || null;
  if (host === 'api.lemonfox.ai') return String(process.env.CLOUDFLARE_AI_GATEWAY_LEMONFOX_PROVIDER || '').trim() || null;
  if (host === 'api.voyageai.com') return String(process.env.CLOUDFLARE_AI_GATEWAY_VOYAGE_PROVIDER || '').trim() || null;
  return null;
}

export function isGatewayUrl(url) {
  const base = stripSlash(process.env.CLOUDFLARE_AI_GATEWAY_BASE_URL || 'https://gateway.ai.cloudflare.com');
  return String(url || '').startsWith(`${base}/`);
}

export function gatewayProviderUrl(provider, upstreamUrl) {
  const config = cloudflareGatewayConfig();
  if (!config.enabled) return upstreamUrl;
  let upstream;
  try { upstream = new URL(upstreamUrl); } catch { return upstreamUrl; }
  const name = String(provider || '').trim().toLowerCase();
  if (!name) return upstreamUrl;
  const base = stripSlash(process.env.CLOUDFLARE_AI_GATEWAY_BASE_URL || 'https://gateway.ai.cloudflare.com');
  // Cloudflare's OpenRouter provider endpoint already owns its API version.
  const path = name === 'openrouter' ? upstream.pathname.replace(/^\/api\/v1(?=\/|$)/, '') : upstream.pathname;
  return `${base}/v1/${encodeURIComponent(config.accountId)}/${encodeURIComponent(config.gatewayId)}/${encodeURIComponent(name)}${path}${upstream.search}`;
}

/** OpenAI-compatible endpoint used by Cloudflare Dynamic Routes. */
export function gatewayCompatUrl(path = '/chat/completions') {
  const config = cloudflareGatewayConfig();
  if (!config.enabled) return null;
  const base = stripSlash(process.env.CLOUDFLARE_AI_GATEWAY_BASE_URL || 'https://gateway.ai.cloudflare.com');
  return `${base}/v1/${encodeURIComponent(config.accountId)}/${encodeURIComponent(config.gatewayId)}/compat${path}`;
}

export function gatewayHeaders(provider) {
  const { enabled, token } = cloudflareGatewayConfig();
  if (!enabled) return {};
  const alias = byokAlias(provider);
  return {
    'cf-aig-authorization': `Bearer ${token}`,
    // Chat, recall, transcription and embeddings carry tenant data; no cache until
    // a separately reviewed cache-key/isolation policy exists.
    'cf-aig-skip-cache': 'true',
    ...(alias ? { 'cf-aig-byok-alias': alias } : {}),
  };
}

export function gatewayRequestHeaders(inputHeaders = {}, provider) {
  const headers = new Headers(inputHeaders || {});
  // Stored BYOK keys are preferred. When an account has not migrated a
  // provider key yet, Cloudflare's documented provider-passthrough contract
  // accepts that provider Authorization header alongside cf-aig-authorization.
  // This still keeps AI Gateway primary without breaking provider-specific
  // workloads during key migration.
  if (!provider || byokAlias(provider)) headers.delete('authorization');
  for (const [key, value] of Object.entries(gatewayHeaders(provider))) headers.set(key, value);
  return headers;
}

function gatewayInit(init, provider) {
  return { ...(init || {}), headers: gatewayRequestHeaders(init?.headers, provider) };
}

/** Gateway only while enabled; the feature flag is the explicit direct-mode kill switch. */
export async function gatewayFirstFetch(input, init, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('gateway_fetch_unavailable');
  const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
  const provider = gatewayProviderForUrl(rawUrl);
  if (!provider || !cloudflareGatewayEnabled() || isGatewayUrl(rawUrl)) return fetchImpl(input, init);
  const gatewayUrl = gatewayProviderUrl(provider, rawUrl);
  return fetchImpl(gatewayUrl, gatewayInit(init, provider));
}
