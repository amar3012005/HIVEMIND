const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CEREBRAS_CHAT_URL = 'https://api.cerebras.ai/v1/chat/completions';
const OPENROUTER_CHAT_URL = `${(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions`;
import { cloudflareGatewayEnabled, gatewayByokAlias, gatewayCompatUrl, gatewayRequestHeaders } from './cloudflare-gateway.js';

export const DEFAULT_CHAT_PLANNER_MODEL = 'google/gemini-2.5-flash-lite';
export const DEFAULT_CHAT_SYNTHESIS_MODEL = 'openai/gpt-oss-20b:nitro';
export const DEFAULT_CHAT_CANDIDATE_SYNTHESIS_MODEL = 'nvidia/nemotron-3.5-lightning:nitro';
export const DEFAULT_HQ_AWAKENING_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const DEFAULT_HQ_DISPATCH_MODEL = 'deepseek/deepseek-v4-flash-0731';

const LEGACY_SYNTHESIS_DEFAULTS = new Set([
  'gpt-oss-120b',
  'openai/gpt-oss-120b',
]);

export function resolveChatSynthesisModel(selectedModel) {
  const requested = typeof selectedModel === 'string' ? selectedModel.trim() : '';
  if (!requested || LEGACY_SYNTHESIS_DEFAULTS.has(requested)) {
    const configured = String(process.env.HIVEMIND_AGENT_FINAL_MODEL || '').trim();
    return configured && !LEGACY_SYNTHESIS_DEFAULTS.has(configured)
      ? configured
      : DEFAULT_CHAT_SYNTHESIS_MODEL;
  }
  return requested;
}

export function resolveChatCompletionRoute(model, { fallbackApiKey } = {}) {
  const requested = String(model || '').trim();
  if (!requested) throw new Error('chat_model_required');
  const gatewayOpenRouter = cloudflareGatewayEnabled() && gatewayByokAlias('openrouter');
  const openRouterApiKey = gatewayOpenRouter ? '' : process.env.OPENROUTER_API_KEY;
  const openRouterUsable = Boolean(gatewayOpenRouter || openRouterApiKey);
  const dynamicRoute = String(process.env.CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE || '').trim();
  if (cloudflareGatewayEnabled() && dynamicRoute) {
    return { provider: 'cloudflare-dynamic', url: gatewayCompatUrl(), apiKey: '', wireModel: `dynamic/${dynamicRoute}`, providerPolicy: null };
  }

  if (requested.startsWith('cerebras/')) {
    const wireModel = requested.slice('cerebras/'.length);
    // In Gateway mode, a direct Cerebras key is intentionally stripped. Only
    // select Cerebras when its Gateway BYOK alias exists; otherwise use the
    // configured OpenRouter BYOK path immediately instead of paying for a
    // guaranteed 400 followed by replay.
    const cerebrasUsable = process.env.CEREBRAS_API_KEY
      && (!cloudflareGatewayEnabled() || gatewayByokAlias('cerebras'));
    if (cerebrasUsable) {
      return {
        provider: 'cerebras',
        url: process.env.CEREBRAS_BASE_URL
          ? `${process.env.CEREBRAS_BASE_URL.replace(/\/+$/, '')}/chat/completions`
          : CEREBRAS_CHAT_URL,
        apiKey: process.env.CEREBRAS_API_KEY,
        wireModel,
        providerPolicy: null,
      };
    }
    if (openRouterUsable) {
      return {
        provider: 'openrouter:gpt-oss',
        url: OPENROUTER_CHAT_URL,
        apiKey: openRouterApiKey,
        wireModel: wireModel === 'gpt-oss-120b' ? 'openai/gpt-oss-120b' : wireModel,
        providerPolicy: {
          // sort:'throughput' makes OpenRouter pick the FASTEST backend for
          // gpt-oss-120b (measured: Cerebras/Groq ~0.5-0.9s) instead of its
          // default routing, which landed on DekaLLM/WandB/Parasail at
          // 7-15s — THE dominant chat-latency cause. allow_fallbacks stays
          // true so a fast-provider 429/outage still routes around rather
          // than failing the turn. Override the sort via
          // OPENROUTER_GPT_OSS_SORT (e.g. 'latency') without a code change.
          sort: process.env.OPENROUTER_GPT_OSS_SORT || 'throughput',
          allow_fallbacks: true,
          require_parameters: true,
          data_collection: 'deny',
        },
      };
    }
    throw new Error('chat_provider_not_configured:cerebras');
  }

  if (requested.startsWith('google/')) {
    if (!openRouterUsable) throw new Error('chat_provider_not_configured:openrouter');
    return {
      provider: 'openrouter:google',
      url: OPENROUTER_CHAT_URL,
      apiKey: openRouterApiKey,
      wireModel: requested,
      providerPolicy: {
        // Same throughput routing for the Gemini planner — its default
        // routing also drifted to slow backends.
        sort: process.env.OPENROUTER_GOOGLE_SORT || 'throughput',
        allow_fallbacks: true,
        require_parameters: true,
        data_collection: 'deny',
      },
    };
  }

  if (requested.startsWith('deepseek/')) {
    if (!openRouterUsable) throw new Error('chat_provider_not_configured:openrouter');
    return {
      provider: 'openrouter:deepseek',
      url: OPENROUTER_CHAT_URL,
      apiKey: openRouterApiKey,
      wireModel: requested,
      providerPolicy: {
        sort: process.env.OPENROUTER_DEEPSEEK_SORT || 'throughput',
        allow_fallbacks: true,
        require_parameters: true,
        data_collection: 'deny',
      },
    };
  }

  if (requested.startsWith('nvidia/')) {
    if (!openRouterUsable) throw new Error('chat_provider_not_configured:openrouter');
    return {
      provider: 'openrouter:nvidia',
      url: OPENROUTER_CHAT_URL,
      apiKey: openRouterApiKey,
      wireModel: requested,
      providerPolicy: {
        // Nemotron Lightning currently has a very small provider pool. Keep
        // the benchmarked providers explicit so a global ignore list tuned
        // for unrelated models can never leave it with zero eligible hosts.
        order: ['DeepInfra', 'CoreWeave'],
        allow_fallbacks: true,
        require_parameters: true,
        data_collection: 'deny',
      },
    };
  }

  if (requested.startsWith('openai/')) {
    if (!openRouterUsable) throw new Error('chat_provider_not_configured:openrouter');
    return {
      provider: 'openrouter:openai',
      url: OPENROUTER_CHAT_URL,
      apiKey: openRouterApiKey,
      wireModel: requested,
      // The :nitro model variant owns fastest-provider selection. Do not add
      // a manual provider order/sort here: that would override the variant's
      // routing and reduce prompt-cache stickiness.
      providerPolicy: {
        allow_fallbacks: true,
        require_parameters: true,
        data_collection: 'deny',
      },
    };
  }

  if (!fallbackApiKey) throw new Error('chat_provider_not_configured:groq');
  return {
    provider: 'groq',
    url: process.env.GROQ_BASE_URL
      ? `${process.env.GROQ_BASE_URL.replace(/\/+$/, '')}/chat/completions`
      : GROQ_CHAT_URL,
    apiKey: fallbackApiKey,
    wireModel: requested,
    providerPolicy: null,
  };
}

export function resolveGatewayLegacyTextProvider(model) {
  if (!cloudflareGatewayEnabled()) return null;
  const route = resolveChatCompletionRoute(`cerebras/${String(model || '').replace(/^.*\//, '')}`);
  const openRouter = route.provider.startsWith('openrouter:');
  return {
    name: openRouter ? 'openrouter' : 'cerebras',
    url: route.url,
    key: route.apiKey,
    model: route.wireModel,
    supportsProviderPrefs: openRouter,
    headers: openRouter
      ? { 'HTTP-Referer': 'https://singulancelabs.com', 'X-Title': 'SINGULANCE HIVEMIND' }
      : {},
  };
}

function prepareOpenRouterBody(body, route) {
  if (body.max_completion_tokens != null) {
    if (body.max_tokens == null) body.max_tokens = body.max_completion_tokens;
    delete body.max_completion_tokens;
  }
  // OpenRouter's GPT-OSS tool routes reject parallel_tool_calls under
  // require_parameters, even when the value is false. Omitting it preserves
  // the requested sequential behavior and keeps Nitro provider selection valid.
  delete body.parallel_tool_calls;
  if (Array.isArray(body.tools) && body.tools.length
      && /^openai\/gpt-oss-/i.test(route.wireModel)
      && body.reasoning_effort == null) {
    body.reasoning_effort = 'low';
  }
  const callerProviderPolicy = body.provider || {};
  body.provider = { ...(route.providerPolicy || {}), ...callerProviderPolicy };
  if (Array.isArray(callerProviderPolicy.order) && callerProviderPolicy.order.length) {
    delete body.provider.sort;
  }
  return body;
}

export async function chatCompletionFetch(model, options = {}, { fallbackApiKey, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('chat_fetch_unavailable');
  const route = resolveChatCompletionRoute(model, { fallbackApiKey });
  let body;
  try {
    body = options.body ? JSON.parse(options.body) : {};
  } catch {
    throw new Error('chat_request_body_invalid');
  }
  body.model = route.wireModel;
  if (route.provider.startsWith('openrouter:')) {
    // Internal callers may narrow a model to workload-specific providers.
    // Merge instead of replacing so final synthesis can use its benchmarked
    // order without changing other DeepSeek workloads such as HQ dispatch.
    prepareOpenRouterBody(body, route);
  } else {
    // Cerebras prompt caching is automatic exact-prefix matching. Its API does
    // not require (or document) OpenRouter's sticky-routing cache key.
    delete body.prompt_cache_key;
  }

  const requestHeaders = {
    ...(options.headers || {}),
    'Content-Type': 'application/json',
    ...(route.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {}),
    ...(route.provider.startsWith('openrouter:') ? {
      'HTTP-Referer': 'https://singulancelabs.com',
      'X-Title': 'SINGULANCE HIVEMIND',
    } : {}),
  };
  return fetchImpl(route.url, {
    ...options,
    headers: route.provider === 'cloudflare-dynamic'
      ? gatewayRequestHeaders(requestHeaders)
      : requestHeaders,
    body: JSON.stringify(body),
  });
}

function parseSseFrame(frame) {
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch { return null; }
}

export async function chatCompletionStream(model, options = {}, {
  fallbackApiKey,
  fetchImpl = globalThis.fetch,
  onContent = null,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('chat_fetch_unavailable');
  const route = resolveChatCompletionRoute(model, { fallbackApiKey });
  let body;
  try {
    body = options.body ? JSON.parse(options.body) : {};
  } catch {
    throw new Error('chat_request_body_invalid');
  }
  body.model = route.wireModel;
  body.stream = true;
  body.stream_options = { ...(body.stream_options || {}), include_usage: true };
  if (route.provider.startsWith('openrouter:')) {
    prepareOpenRouterBody(body, route);
  }

  const requestHeaders = {
    ...(options.headers || {}),
    'Content-Type': 'application/json',
    ...(route.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {}),
    ...(route.provider.startsWith('openrouter:') ? {
      'HTTP-Referer': 'https://singulancelabs.com',
      'X-Title': 'SINGULANCE HIVEMIND',
    } : {}),
  };
  const response = await fetchImpl(route.url, {
    ...options,
    headers: route.provider === 'cloudflare-dynamic'
      ? gatewayRequestHeaders(requestHeaders)
      : requestHeaders,
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body?.getReader) {
    const errorText = await response.text().catch(() => '');
    return {
      ok: response.ok,
      status: response.status,
      content: '',
      usage: {},
      provider: null,
      model: route.wireModel,
      error: errorText.slice(0, 400),
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = {};
  let provider = null;
  let finishReason = null;
  const consume = async (frame) => {
    const payload = parseSseFrame(frame);
    if (!payload) return;
    const delta = String(payload?.choices?.[0]?.delta?.content || '');
    if (delta) {
      content += delta;
      if (onContent) await onContent(delta, { content, payload });
    }
    if (payload.usage) usage = payload.usage;
    if (payload.provider) provider = payload.provider;
    if (payload?.choices?.[0]?.finish_reason) finishReason = payload.choices[0].finish_reason;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) await consume(frame);
    if (done) break;
  }
  if (buffer.trim()) await consume(buffer);
  return { ok: true, status: response.status, content, usage, provider, model: route.wireModel, finish_reason: finishReason };
}
