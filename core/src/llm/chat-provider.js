const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CEREBRAS_CHAT_URL = 'https://api.cerebras.ai/v1/chat/completions';
const OPENROUTER_CHAT_URL = `${(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions`;

export const DEFAULT_CHAT_PLANNER_MODEL = 'google/gemini-2.5-flash-lite';
export const DEFAULT_CHAT_SYNTHESIS_MODEL = 'cerebras/gpt-oss-120b';

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
          // Keep the model fixed while allowing OpenRouter to route around a
          // transient Cerebras outage. Requiring one provider turned a 429
          // into a platform-wide chat failure despite compatible capacity.
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
    body.provider = route.providerPolicy;
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
