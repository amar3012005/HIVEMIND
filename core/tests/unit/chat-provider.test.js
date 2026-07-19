import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chatCompletionFetch,
  DEFAULT_CHAT_PLANNER_MODEL,
  DEFAULT_CHAT_SYNTHESIS_MODEL,
  resolveChatCompletionRoute,
} from '../../src/llm/chat-provider.js';

test('chat model policy uses Gemini Flash-Lite planning and Cerebras 120B synthesis', () => {
  assert.equal(DEFAULT_CHAT_PLANNER_MODEL, 'google/gemini-2.5-flash-lite');
  assert.equal(DEFAULT_CHAT_SYNTHESIS_MODEL, 'cerebras/gpt-oss-120b');
});

test('Cerebras synthesis is pinned through OpenRouter when no direct key exists', () => {
  const priorOpenRouter = process.env.OPENROUTER_API_KEY;
  const priorCerebras = process.env.CEREBRAS_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  delete process.env.CEREBRAS_API_KEY;
  try {
    const route = resolveChatCompletionRoute('cerebras/gpt-oss-120b');
    assert.equal(route.provider, 'openrouter:cerebras');
    assert.equal(route.wireModel, 'openai/gpt-oss-120b');
    assert.deepEqual(route.providerPolicy.only, ['cerebras']);
    assert.equal(route.providerPolicy.allow_fallbacks, false);
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
