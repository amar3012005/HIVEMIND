const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CEREBRAS_CHAT_URL = 'https://api.cerebras.ai/v1/chat/completions';
const OPENROUTER_CHAT_URL = `${(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions`;
import { cloudflareGatewayEnabled, gatewayByokAlias, gatewayCompatUrl, gatewayProviderUrl, gatewayRequestHeaders, isGatewayUrl } from './cloudflare-gateway.js';
import { recordAiUsage, resolveAiModelPolicy } from './ai-governance.js';

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

export function resolveChatCompletionRoute(model, { fallbackApiKey, concreteGatewayModel = false } = {}) {
  const requested = String(model || '').trim();
  if (!requested) throw new Error('chat_model_required');
  const gatewayOpenRouter = cloudflareGatewayEnabled() && gatewayByokAlias('openrouter');
  const openRouterApiKey = gatewayOpenRouter ? '' : process.env.OPENROUTER_API_KEY;
  const openRouterUsable = Boolean(gatewayOpenRouter || openRouterApiKey);
  const dynamicRoute = String(process.env.CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE || '').trim();
  if (cloudflareGatewayEnabled() && dynamicRoute && !concreteGatewayModel) {
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
        url: gatewayOpenRouter ? gatewayProviderUrl('openrouter', OPENROUTER_CHAT_URL) : OPENROUTER_CHAT_URL,
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
      url: gatewayOpenRouter ? gatewayProviderUrl('openrouter', OPENROUTER_CHAT_URL) : OPENROUTER_CHAT_URL,
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
      url: gatewayOpenRouter ? gatewayProviderUrl('openrouter', OPENROUTER_CHAT_URL) : OPENROUTER_CHAT_URL,
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
      url: gatewayOpenRouter ? gatewayProviderUrl('openrouter', OPENROUTER_CHAT_URL) : OPENROUTER_CHAT_URL,
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
      url: gatewayOpenRouter ? gatewayProviderUrl('openrouter', OPENROUTER_CHAT_URL) : OPENROUTER_CHAT_URL,
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
  // A caller can decide its request shape before policy resolution. Once an
  // admin policy upgrades that request from GPT-OSS to a non-reasoning model
  // such as GPT-4.1, carrying the stale GPT-OSS-only parameter makes
  // OpenRouter reject every provider with a misleading "no endpoints" 404.
  // Only GPT-OSS receives this compatibility parameter.
  if (!/^openai\/gpt-oss-/i.test(route.wireModel)) delete body.reasoning_effort;
  const callerProviderPolicy = body.provider || {};
  body.provider = { ...(route.providerPolicy || {}), ...callerProviderPolicy };
  if (Array.isArray(callerProviderPolicy.order) && callerProviderPolicy.order.length) {
    delete body.provider.sort;
  }
  return body;
}

export function shouldPolicyFallbackStatus(status) {
  // 404 here is OpenRouter's provider-capability response, not a missing API
  // route. It is safe to move to the policy's independently configured model.
  return [404, 408, 429, 500, 502, 503, 504].includes(Number(status));
}

function inferUseCase(model, explicit) {
  if (explicit) return explicit;
  if (model === DEFAULT_CHAT_PLANNER_MODEL) return 'chat_planner';
  if (model === DEFAULT_CHAT_SYNTHESIS_MODEL || model === DEFAULT_CHAT_CANDIDATE_SYNTHESIS_MODEL) return 'chat_synthesis';
  if (model === DEFAULT_HQ_DISPATCH_MODEL || model === DEFAULT_HQ_AWAKENING_MODEL) return 'hq_dispatch';
  return 'general';
}

async function meterCompletionResponse(response, context) {
  try {
    const json = await response.clone().json();
    await recordAiUsage({ ...context, usage: json?.usage || {}, servedModel: json?.model || context.requestedModel,
      provider: json?.provider || response.headers.get('cf-aig-provider') || 'unknown',
      gatewayRequestId: response.headers.get('cf-aig-log-id') || response.headers.get('cf-ray'), status: response.ok ? 'completed' : 'failed' });
  } catch { /* metering must never affect inference */ }
}

export async function chatCompletionFetch(model, options = {}, { fallbackApiKey, fetchImpl = globalThis.fetch, useCase = null, traceId = null } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('chat_fetch_unavailable');
  const policy = await resolveAiModelPolicy(inferUseCase(model, useCase), model);
  const route = resolveChatCompletionRoute(policy.primary, { fallbackApiKey, concreteGatewayModel: policy.source === 'admin' });
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
  let response = await fetchImpl(route.url, {
    ...options,
    headers: route.provider === 'cloudflare-dynamic' || isGatewayUrl(route.url)
      ? gatewayRequestHeaders(requestHeaders, route.provider.startsWith('openrouter:') ? 'openrouter' : undefined)
      : requestHeaders,
    body: JSON.stringify(body),
  });
  void meterCompletionResponse(response, { requestedModel: policy.primary, useCase: policy.useCase, traceId });
  if (!response.ok && policy.source === 'admin' && policy.secondary && shouldPolicyFallbackStatus(response.status) && !options.signal?.aborted) {
    const fallbackRoute = resolveChatCompletionRoute(policy.secondary, { fallbackApiKey, concreteGatewayModel: policy.source === 'admin' });
    let fallbackBody = options.body ? JSON.parse(options.body) : {};
    fallbackBody.model = fallbackRoute.wireModel;
    if (fallbackRoute.provider.startsWith('openrouter:')) prepareOpenRouterBody(fallbackBody, fallbackRoute);
    const fallbackHeaders = {
      ...(options.headers || {}), 'Content-Type': 'application/json',
      ...(fallbackRoute.apiKey ? { Authorization: `Bearer ${fallbackRoute.apiKey}` } : {}),
      ...(fallbackRoute.provider.startsWith('openrouter:') ? { 'HTTP-Referer': 'https://singulancelabs.com', 'X-Title': 'SINGULANCE HIVEMIND' } : {}),
    };
    response = await fetchImpl(fallbackRoute.url, { ...options,
      headers: fallbackRoute.provider === 'cloudflare-dynamic' || isGatewayUrl(fallbackRoute.url)
        ? gatewayRequestHeaders(fallbackHeaders, fallbackRoute.provider.startsWith('openrouter:') ? 'openrouter' : undefined) : fallbackHeaders,
      body: JSON.stringify(fallbackBody) });
    void meterCompletionResponse(response, { requestedModel: policy.secondary, useCase: policy.useCase, traceId });
  }
  return response;
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
  useCase = null,
  traceId = null,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('chat_fetch_unavailable');
  const policy = await resolveAiModelPolicy(inferUseCase(model, useCase), model);
  let route = resolveChatCompletionRoute(policy.primary, { fallbackApiKey, concreteGatewayModel: policy.source === 'admin' });
  let sourceBody;
  try {
    sourceBody = options.body ? JSON.parse(options.body) : {};
  } catch {
    throw new Error('chat_request_body_invalid');
  }
  const requestFor = (selectedRoute) => {
    const body = { ...sourceBody, model: selectedRoute.wireModel, stream: true,
      stream_options: { ...(sourceBody.stream_options || {}), include_usage: true } };
    if (selectedRoute.provider.startsWith('openrouter:')) prepareOpenRouterBody(body, selectedRoute);
    const headers = {
      ...(options.headers || {}), 'Content-Type': 'application/json',
      ...(selectedRoute.apiKey ? { Authorization: `Bearer ${selectedRoute.apiKey}` } : {}),
      ...(selectedRoute.provider.startsWith('openrouter:') ? { 'HTTP-Referer': 'https://singulancelabs.com', 'X-Title': 'SINGULANCE HIVEMIND' } : {}),
    };
    return {
      ...options,
      headers: selectedRoute.provider === 'cloudflare-dynamic' || isGatewayUrl(selectedRoute.url)
        ? gatewayRequestHeaders(headers, selectedRoute.provider.startsWith('openrouter:') ? 'openrouter' : undefined)
        : headers,
      body: JSON.stringify(body),
    };
  };
  let response = await fetchImpl(route.url, requestFor(route));
  let selectedModel = policy.primary;
  if (!response.ok && policy.source === 'admin' && policy.secondary && shouldPolicyFallbackStatus(response.status) && !options.signal?.aborted) {
    route = resolveChatCompletionRoute(policy.secondary, { fallbackApiKey, concreteGatewayModel: true });
    selectedModel = policy.secondary;
    response = await fetchImpl(route.url, requestFor(route));
  }
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
  void recordAiUsage({ usage, requestedModel: selectedModel, servedModel: route.wireModel,
    provider: provider || response.headers.get('cf-aig-provider') || 'unknown', useCase: policy.useCase, traceId,
    gatewayRequestId: response.headers.get('cf-aig-log-id') || response.headers.get('cf-ray') });
  return { ok: true, status: response.status, content, usage, provider, model: route.wireModel, finish_reason: finishReason };
}
