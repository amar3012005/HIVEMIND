import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chatCompletionFetch,
  chatCompletionStream,
  DEFAULT_CHAT_PLANNER_MODEL,
  DEFAULT_CHAT_CANDIDATE_SYNTHESIS_MODEL,
  DEFAULT_CHAT_SYNTHESIS_MODEL,
  DEFAULT_HQ_AWAKENING_MODEL,
  DEFAULT_HQ_DISPATCH_MODEL,
  resolveChatCompletionRoute,
  shouldPolicyFallbackStatus,
} from '../../src/llm/chat-provider.js';
import { configureAiGovernance, invalidateAiModelPolicyCache } from '../../src/llm/ai-governance.js';

test('chat model policy uses Gemini Flash-Lite planning and GPT-OSS-20B Nitro synthesis', () => {
  assert.equal(DEFAULT_CHAT_PLANNER_MODEL, 'google/gemini-2.5-flash-lite');
  assert.equal(DEFAULT_CHAT_SYNTHESIS_MODEL, 'openai/gpt-oss-20b:nitro');
});

test('HQ bounded language tasks use DeepSeek without changing Room synthesis policy', () => {
  assert.equal(DEFAULT_HQ_AWAKENING_MODEL, 'deepseek/deepseek-v4-flash-0731');
  assert.equal(DEFAULT_HQ_DISPATCH_MODEL, 'deepseek/deepseek-v4-flash-0731');
  assert.equal(DEFAULT_CHAT_SYNTHESIS_MODEL, 'openai/gpt-oss-20b:nitro');
});

test('GPT-OSS-20B Nitro final synthesis uses OpenRouter variant routing without manual provider order', () => {
  const prior = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  try {
    const route = resolveChatCompletionRoute(DEFAULT_CHAT_SYNTHESIS_MODEL);
    assert.equal(route.provider, 'openrouter:openai');
    assert.equal(route.wireModel, 'openai/gpt-oss-20b:nitro');
    assert.equal(route.providerPolicy.sort, undefined);
    assert.equal(route.providerPolicy.order, undefined);
    assert.equal(route.providerPolicy.allow_fallbacks, true);
    assert.equal(route.providerPolicy.data_collection, 'deny');
  } finally {
    if (prior == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prior;
  }
});

test('Nemotron final synthesis pins its viable providers and never inherits an ignore list', () => {
  const prior = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  try {
    const route = resolveChatCompletionRoute(DEFAULT_CHAT_CANDIDATE_SYNTHESIS_MODEL);
    assert.equal(route.provider, 'openrouter:nvidia');
    assert.deepEqual(route.providerPolicy.order, ['DeepInfra', 'CoreWeave']);
    assert.equal(route.providerPolicy.ignore, undefined);
    assert.equal(route.providerPolicy.allow_fallbacks, true);
    assert.equal(route.providerPolicy.require_parameters, true);
  } finally {
    if (prior == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prior;
  }
});

test('DeepSeek HQ requests route directly to OpenRouter throughput selection', () => {
  const prior = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  try {
    const route = resolveChatCompletionRoute(DEFAULT_HQ_DISPATCH_MODEL);
    assert.equal(route.provider, 'openrouter:deepseek');
    assert.equal(route.wireModel, DEFAULT_HQ_DISPATCH_MODEL);
    assert.equal(route.providerPolicy.sort, 'throughput');
    assert.equal(route.providerPolicy.allow_fallbacks, true);
    assert.equal(route.providerPolicy.ignore, undefined);
  } finally {
    if (prior == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prior;
  }
});

test('OpenRouter streaming accumulates content deltas and final usage', async () => {
  const prior = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"provider":"Novita","choices":[{"delta":{"content":"I am "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"ready."},"finish_reason":"stop"}],"usage":{"prompt_tokens":170,"completion_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ];
  const deltas = [];
  try {
    const result = await chatCompletionStream(DEFAULT_HQ_AWAKENING_MODEL, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Wake' }], max_completion_tokens: 140 }),
    }, {
      fetchImpl: async (_url, options) => {
        const sent = JSON.parse(options.body);
        assert.equal(sent.stream, true);
        assert.equal(sent.stream_options.include_usage, true);
        assert.equal(sent.max_tokens, 140);
        return new Response(new ReadableStream({
          start(controller) {
            chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
            controller.close();
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
      onContent: (delta) => deltas.push(delta),
    });
    assert.equal(result.content, 'I am ready.');
    assert.deepEqual(deltas, ['I am ', 'ready.']);
    assert.equal(result.provider, 'Novita');
    assert.equal(result.usage.prompt_tokens, 170);
    assert.equal(result.finish_reason, 'stop');
  } finally {
    if (prior == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prior;
  }
});

test('OpenRouter streaming preserves a bounded provider error body for diagnosis', async () => {
  const prior = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  try {
    const result = await chatCompletionStream(DEFAULT_CHAT_SYNTHESIS_MODEL, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Answer' }] }),
    }, {
      fetchImpl: async () => new Response('{"error":{"message":"unsupported reasoning parameter"}}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /unsupported reasoning parameter/);
  } finally {
    if (prior == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prior;
  }
});

test('a workload-specific DeepSeek provider order overrides sorting without affecting the shared route', async () => {
  const prior = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  try {
    await chatCompletionFetch(DEFAULT_HQ_AWAKENING_MODEL, {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Synthesize' }],
        provider: { order: ['baidu', 'digitalocean', 'streamlake'] },
      }),
    }, {
      fetchImpl: async (_url, options) => {
        const sent = JSON.parse(options.body);
        assert.deepEqual(sent.provider.order, ['baidu', 'digitalocean', 'streamlake']);
        assert.equal(sent.provider.sort, undefined);
        assert.equal(sent.provider.allow_fallbacks, true);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
  } finally {
    if (prior == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prior;
  }
});

test('GPT-OSS synthesis permits provider failover through OpenRouter when no direct Cerebras key exists', () => {
  const priorOpenRouter = process.env.OPENROUTER_API_KEY;
  const priorCerebras = process.env.CEREBRAS_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  delete process.env.CEREBRAS_API_KEY;
  try {
    const route = resolveChatCompletionRoute('cerebras/gpt-oss-120b');
    assert.equal(route.provider, 'openrouter:gpt-oss');
    assert.equal(route.wireModel, 'openai/gpt-oss-120b');
    assert.equal(route.providerPolicy.only, undefined);
    assert.equal(route.providerPolicy.allow_fallbacks, true);
    assert.equal(route.providerPolicy.data_collection, 'deny');
  } finally {
    if (priorOpenRouter == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorOpenRouter;
    if (priorCerebras == null) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = priorCerebras;
  }
});

test('policy routing removes incompatible reasoning controls before the Gateway request', async () => {
  const prior = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  try {
    await chatCompletionFetch('openai/gpt-4.1', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Answer' }], reasoning_effort: 'low', reasoning: { enabled: false } }),
    }, {
      fetchImpl: async (_url, options) => {
        const sent = JSON.parse(options.body);
        assert.equal(sent.reasoning_effort, undefined);
        assert.equal(sent.reasoning, undefined);
        return new Response('{}', { status: 200 });
      },
    });
  } finally {
    if (prior == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prior;
  }
});

test('provider capability 404 is eligible for the policy fallback', () => {
  assert.equal(shouldPolicyFallbackStatus(404), true);
  assert.equal(shouldPolicyFallbackStatus(400), false);
});

test('streaming retries the policy secondary after a provider-capability 404', async () => {
  const prior = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  configureAiGovernance({ $queryRawUnsafe: async () => [{
    use_case: 'chat_synthesis', primary_model: 'openai/gpt-4.1', secondary_model: 'openai/gpt-oss-20b:nitro', enabled: true, revision: 1,
  }] });
  invalidateAiModelPolicyCache();
  const encoder = new TextEncoder();
  const calls = [];
  try {
    const result = await chatCompletionStream(DEFAULT_CHAT_SYNTHESIS_MODEL, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Answer' }], reasoning_effort: 'low', reasoning: { enabled: false } }),
    }, {
      useCase: 'chat_synthesis',
      fetchImpl: async (_url, options) => {
        calls.push(JSON.parse(options.body));
        if (calls.length === 1) return new Response('{"error":"no eligible endpoint"}', { status: 404 });
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Recovered"},"finish_reason":"stop"}]}\n\n')); controller.close(); },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].model, 'openai/gpt-4.1');
    assert.equal(calls[0].reasoning_effort, undefined);
    assert.equal(calls[0].reasoning, undefined);
    assert.equal(calls[1].model, 'openai/gpt-oss-20b:nitro');
    assert.equal(calls[1].reasoning_effort, 'low');
    assert.equal(calls[1].reasoning, undefined);
    assert.equal(result.content, 'Recovered');
    assert.equal(result.model, 'openai/gpt-oss-20b:nitro');
  } finally {
    configureAiGovernance(null); invalidateAiModelPolicyCache();
    if (prior == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prior;
  }
});

test('Gemini planner request uses OpenRouter and preserves required tool parameters', async () => {
  const prior = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  let captured;
  try {
    const response = await chatCompletionFetch(DEFAULT_CHAT_PLANNER_MODEL, {
      method: 'POST',
      body: JSON.stringify({
        model: DEFAULT_CHAT_PLANNER_MODEL,
        messages: [{ role: 'user', content: 'plan this' }],
        tools: [{ type: 'function', function: { name: 'route_chat_turn', parameters: { type: 'object' } } }],
        max_completion_tokens: 650,
      }),
    }, {
      fetchImpl: async (url, options) => {
        captured = { url, options, body: JSON.parse(options.body) };
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(response.status, 200);
    assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(captured.body.model, 'google/gemini-2.5-flash-lite');
    assert.equal(captured.body.max_tokens, 650);
    assert.equal(captured.body.max_completion_tokens, undefined);
    assert.equal(captured.body.provider.require_parameters, true);
    assert.equal(captured.options.headers.Authorization, 'Bearer or-test');
  } finally {
    if (prior == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prior;
  }
});

test('admin model policy uses Cloudflare concrete provider route and secondary fallback', async () => {
  const prior = { enabled: process.env.CLOUDFLARE_AI_GATEWAY_ENABLED, account: process.env.CLOUDFLARE_ACCOUNT_ID,
    gateway: process.env.CLOUDFLARE_AI_GATEWAY_ID, token: process.env.CLOUDFLARE_AI_GATEWAY_TOKEN,
    alias: process.env.CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS, route: process.env.CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE };
  Object.assign(process.env, { CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_AI_GATEWAY_ID: 'gw',
    CLOUDFLARE_AI_GATEWAY_TOKEN: 'token', CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS: 'openrouter-key', CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE: 'legacy-route' });
  configureAiGovernance({ $queryRawUnsafe: async (sql) => sql.includes('ai_model_policies')
    ? [{ use_case: 'chat_planner', primary_model: 'google/gemini-2.5-flash-lite', secondary_model: 'openai/gpt-oss-20b:nitro', enabled: true, revision: 4 }]
    : [] });
  invalidateAiModelPolicyCache();
  const calls = [];
  try {
    const response = await chatCompletionFetch(DEFAULT_CHAT_PLANNER_MODEL, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'plan' }] }) }, {
      useCase: 'chat_planner', fetchImpl: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
        return new Response(calls.length === 1 ? '{"error":"busy"}' : '{"usage":{"prompt_tokens":2,"completion_tokens":1}}',
          { status: calls.length === 1 ? 503 : 200, headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/openrouter\/chat\/completions$/);
    assert.equal(calls[0].body.model, 'google/gemini-2.5-flash-lite');
    assert.equal(calls[1].body.model, 'openai/gpt-oss-20b:nitro');
    assert.equal(calls[0].headers.get('cf-aig-authorization'), 'Bearer token');
    assert.equal(calls[0].headers.get('authorization'), null);
  } finally {
    configureAiGovernance(null); invalidateAiModelPolicyCache();
    for (const [key, value] of Object.entries(prior)) { const env = ({ enabled:'CLOUDFLARE_AI_GATEWAY_ENABLED',account:'CLOUDFLARE_ACCOUNT_ID',gateway:'CLOUDFLARE_AI_GATEWAY_ID',token:'CLOUDFLARE_AI_GATEWAY_TOKEN',alias:'CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS',route:'CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE' })[key]; if (value == null) delete process.env[env]; else process.env[env] = value; }
  }
});

test('GPT-OSS Nitro tool request omits unsupported parallel flag and uses low reasoning', async () => {
  const prior = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  let captured;
  try {
    await chatCompletionFetch('openai/gpt-oss-20b:nitro', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'route this' }],
        tools: [{ type: 'function', function: { name: 'hivemind_context', parameters: { type: 'object' } } }],
        tool_choice: 'required',
        parallel_tool_calls: false,
        max_tokens: 900,
      }),
    }, {
      fetchImpl: async (_url, options) => {
        captured = JSON.parse(options.body);
        return new Response('{}', { status: 200 });
      },
    });
    assert.equal(captured.model, 'openai/gpt-oss-20b:nitro');
    assert.equal(captured.parallel_tool_calls, undefined);
    assert.equal(captured.reasoning_effort, 'low');
    assert.equal(captured.tool_choice, 'required');
    assert.equal(captured.provider.require_parameters, true);
  } finally {
    if (prior == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prior;
  }
});

test('OpenRouter preserves prompt cache keys while Cerebras relies on automatic prefix caching', async () => {
  const priorOpenRouter = process.env.OPENROUTER_API_KEY;
  const priorCerebras = process.env.CEREBRAS_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  process.env.CEREBRAS_API_KEY = 'cerebras-test';
  try {
    await chatCompletionFetch(DEFAULT_CHAT_PLANNER_MODEL, {
      method: 'POST',
      body: JSON.stringify({ messages: [], prompt_cache_key: 'hm:planner:v1' }),
    }, {
      fetchImpl: async (_url, options) => {
        assert.equal(JSON.parse(options.body).prompt_cache_key, 'hm:planner:v1');
        return new Response('{}', { status: 200 });
      },
    });
    await chatCompletionFetch('cerebras/gpt-oss-120b', {
      method: 'POST',
      body: JSON.stringify({ messages: [], prompt_cache_key: 'hm:synthesis:v1' }),
    }, {
      fetchImpl: async (_url, options) => {
        assert.equal(JSON.parse(options.body).prompt_cache_key, undefined);
        return new Response('{}', { status: 200 });
      },
    });
  } finally {
    if (priorOpenRouter == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorOpenRouter;
    if (priorCerebras == null) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = priorCerebras;
  }
});
