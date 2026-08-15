const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CEREBRAS_CHAT_URL = 'https://api.cerebras.ai/v1/chat/completions';
const OPENROUTER_CHAT_URL = `${(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions`;

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

  if (requested.startsWith('cerebras/')) {
    const wireModel = requested.slice('cerebras/'.length);
    if (process.env.CEREBRAS_API_KEY) {
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
    if (process.env.OPENROUTER_API_KEY) {
      return {
        provider: 'openrouter:gpt-oss',
        url: OPENROUTER_CHAT_URL,
        apiKey: process.env.OPENROUTER_API_KEY,
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
    if (!process.env.OPENROUTER_API_KEY) throw new Error('chat_provider_not_configured:openrouter');
    return {
      provider: 'openrouter:google',
      url: OPENROUTER_CHAT_URL,
      apiKey: process.env.OPENROUTER_API_KEY,
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
    if (!process.env.OPENROUTER_API_KEY) throw new Error('chat_provider_not_configured:openrouter');
    return {
      provider: 'openrouter:deepseek',
      url: OPENROUTER_CHAT_URL,
      apiKey: process.env.OPENROUTER_API_KEY,
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
    if (!process.env.OPENROUTER_API_KEY) throw new Error('chat_provider_not_configured:openrouter');
    return {
      provider: 'openrouter:nvidia',
      url: OPENROUTER_CHAT_URL,
      apiKey: process.env.OPENROUTER_API_KEY,
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
    if (!process.env.OPENROUTER_API_KEY) throw new Error('chat_provider_not_configured:openrouter');
    return {
      provider: 'openrouter:openai',
      url: OPENROUTER_CHAT_URL,
      apiKey: process.env.OPENROUTER_API_KEY,
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
    if (body.max_completion_tokens != null) {
      if (body.max_tokens == null) body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
    }
    // Internal callers may narrow a model to workload-specific providers.
    // Merge instead of replacing so final synthesis can use its benchmarked
    // order without changing other DeepSeek workloads such as HQ dispatch.
    const callerProviderPolicy = body.provider || {};
    body.provider = { ...(route.providerPolicy || {}), ...callerProviderPolicy };
    if (Array.isArray(callerProviderPolicy.order) && callerProviderPolicy.order.length) {
      delete body.provider.sort;
    }
  } else {
    // Cerebras prompt caching is automatic exact-prefix matching. Its API does
    // not require (or document) OpenRouter's sticky-routing cache key.
    delete body.prompt_cache_key;
  }

  return fetchImpl(route.url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${route.apiKey}`,
      ...(route.provider.startsWith('openrouter:') ? {
        'HTTP-Referer': 'https://singulancelabs.com',
        'X-Title': 'SINGULANCE HIVEMIND',
      } : {}),
    },
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
    if (body.max_completion_tokens != null) {
      if (body.max_tokens == null) body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
    }
    body.provider = route.providerPolicy;
  }

  const response = await fetchImpl(route.url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${route.apiKey}`,
      ...(route.provider.startsWith('openrouter:') ? {
        'HTTP-Referer': 'https://singulancelabs.com',
        'X-Title': 'SINGULANCE HIVEMIND',
      } : {}),
    },
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
