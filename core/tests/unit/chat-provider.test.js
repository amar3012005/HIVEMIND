import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chatCompletionFetch,
  chatCompletionStream,
  DEFAULT_CHAT_PLANNER_MODEL,
  DEFAULT_CHAT_SYNTHESIS_MODEL,
  DEFAULT_HQ_AWAKENING_MODEL,
  DEFAULT_HQ_DISPATCH_MODEL,
  resolveChatCompletionRoute,
} from '../../src/llm/chat-provider.js';

test('chat model policy uses Gemini Flash-Lite planning and Cerebras 120B synthesis', () => {
  assert.equal(DEFAULT_CHAT_PLANNER_MODEL, 'google/gemini-2.5-flash-lite');
  assert.equal(DEFAULT_CHAT_SYNTHESIS_MODEL, 'cerebras/gpt-oss-120b');
});

test('HQ bounded language tasks use DeepSeek without changing Room synthesis policy', () => {
  assert.equal(DEFAULT_HQ_AWAKENING_MODEL, 'deepseek/deepseek-v4-flash-0731');
  assert.equal(DEFAULT_HQ_DISPATCH_MODEL, 'deepseek/deepseek-v4-flash-0731');
  assert.equal(DEFAULT_CHAT_SYNTHESIS_MODEL, 'cerebras/gpt-oss-120b');
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
