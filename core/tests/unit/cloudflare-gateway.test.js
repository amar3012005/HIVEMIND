import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudflareGatewayConfig,
  gatewayFirstFetch,
  gatewayHeaders,
  gatewayRequestHeaders,
  gatewayProviderForUrl,
  gatewayProviderUrl,
} from '../../src/llm/cloudflare-gateway.js';

const KEYS = [
  'CLOUDFLARE_AI_GATEWAY_ENABLED', 'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_AI_GATEWAY_ID', 'CLOUDFLARE_AI_GATEWAY_TOKEN',
  'CLOUDFLARE_AI_GATEWAY_CEREBRAS_BYOK_ALIAS',
  'CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS',
  'CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE',
  'CLOUDFLARE_AI_GATEWAY_BGE_EMBEDDINGS_PROVIDER',
  'CLOUDFLARE_AI_GATEWAY_BGE_RERANKER_PROVIDER',
];

async function withEnv(values, fn) {
  const prior = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await fn(); } finally {
    for (const key of KEYS) {
      if (prior[key] == null) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

test('Gateway is inert without its explicit complete configuration', () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: '',
}, () => {
  assert.equal(cloudflareGatewayConfig().enabled, false);
  assert.equal(gatewayProviderUrl('groq', 'https://api.groq.com/openai/v1/chat/completions'), 'https://api.groq.com/openai/v1/chat/completions');
}));

test('Text route uses Cloudflare compat dynamic routing without a provider key', async () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
  CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE: 'core-text',
}, async () => {
  const { resolveChatCompletionRoute } = await import('../../src/llm/chat-provider.js');
  const route = resolveChatCompletionRoute('anything');
  assert.equal(route.provider, 'cloudflare-dynamic');
  assert.equal(route.url, 'https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions');
  assert.equal(route.wireModel, 'dynamic/core-text');
  assert.equal(route.apiKey, '');
}));

test('Gateway maps only known provider hosts and uses provider-native paths', () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'token',
  CLOUDFLARE_AI_GATEWAY_CEREBRAS_BYOK_ALIAS: 'first',
}, () => {
  assert.equal(gatewayProviderForUrl('https://untrusted.example/v1/chat'), null);
  assert.equal(gatewayProviderForUrl('https://api.openai.com/v1/embeddings'), 'openai');
  assert.equal(gatewayProviderForUrl('https://api.mistral.ai/v1/embeddings'), 'mistral');
  assert.equal(gatewayProviderForUrl('https://api.cohere.com/v2/rerank'), 'cohere');
  assert.equal(gatewayProviderForUrl('https://api.cohere.ai/v2/rerank'), 'cohere');
  assert.equal(gatewayProviderForUrl('https://api.anthropic.com/v1/messages'), 'anthropic');
  assert.equal(gatewayProviderForUrl('https://api.together.xyz/v1/chat/completions'), 'together-ai');
  assert.equal(gatewayProviderForUrl('https://embeddings.singulancelabs.com/v1/embeddings'), 'custom-bge-embeddings');
  assert.equal(gatewayProviderForUrl('https://rerank.singulancelabs.com/api/v1/rerank'), 'custom-bge-reranker');
  assert.equal(gatewayProviderUrl('openrouter', 'https://openrouter.ai/api/v1/chat/completions'), 'https://gateway.ai.cloudflare.com/v1/account/gateway/openrouter/chat/completions');
  assert.deepEqual(gatewayHeaders('cerebras'), {
    'cf-aig-authorization': 'Bearer token', 'cf-aig-skip-cache': 'true', 'cf-aig-byok-alias': 'first',
  });
}));

test('Gateway routes embeddings and reranking without replaying upstream', async () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
}, async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response('{}');
  };
  await gatewayFirstFetch('https://api.mistral.ai/v1/embeddings', {
    method: 'POST', headers: { Authorization: 'Bearer mistral-key' },
  }, { fetchImpl });
  await gatewayFirstFetch('https://api.cohere.com/v2/rerank', {
    method: 'POST', headers: { Authorization: 'Bearer cohere-key' },
  }, { fetchImpl });
  assert.match(calls[0].url, /\/gateway\/mistral\/v1\/embeddings$/);
  assert.match(calls[1].url, /\/gateway\/cohere\/v2\/rerank$/);
  assert.equal(calls[0].headers.get('cf-aig-authorization'), 'Bearer gateway-token');
  assert.equal(calls.length, 2);
}));

test('Gateway routes Singulance BGE services through their custom providers', async () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
}, async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response('{}');
  };
  await gatewayFirstFetch('https://embeddings.singulancelabs.com/v1/embeddings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  }, { fetchImpl });
  await gatewayFirstFetch('https://rerank.singulancelabs.com/api/v1/rerank', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  }, { fetchImpl });
  assert.equal(calls[0].url, 'https://gateway.ai.cloudflare.com/v1/account/gateway/custom-bge-embeddings/v1/embeddings');
  assert.equal(calls[1].url, 'https://gateway.ai.cloudflare.com/v1/account/gateway/custom-bge-reranker/api/v1/rerank');
  assert.equal(calls[0].headers.get('cf-aig-authorization'), 'Bearer gateway-token');
  assert.equal(calls[1].headers.get('cf-aig-authorization'), 'Bearer gateway-token');
  assert.equal(calls.length, 2);
}));

test('Gateway request headers strip a prepared direct-provider credential', () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
}, () => {
  const headers = gatewayRequestHeaders({ Authorization: 'Bearer direct-secret', 'X-Trace': 'trace-1' });
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('cf-aig-authorization'), 'Bearer gateway-token');
  assert.equal(headers.get('x-trace'), 'trace-1');
}));

test('Gateway skips Cerebras without its BYOK alias and uses OpenRouter immediately', async () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
  CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE: '',
  CLOUDFLARE_AI_GATEWAY_CEREBRAS_BYOK_ALIAS: '',
  CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS: 'openrouter-alias',
}, async () => {
  const previousCerebras = process.env.CEREBRAS_API_KEY;
  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  process.env.CEREBRAS_API_KEY = 'direct-cerebras-key';
  delete process.env.OPENROUTER_API_KEY;
  try {
    const { resolveChatCompletionRoute } = await import('../../src/llm/chat-provider.js');
    const route = resolveChatCompletionRoute('cerebras/gpt-oss-120b');
    assert.equal(route.provider, 'openrouter:gpt-oss');
    assert.equal(route.wireModel, 'openai/gpt-oss-120b');
    assert.equal(route.apiKey, '');
  } finally {
    if (previousCerebras == null) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = previousCerebras;
    if (previousOpenRouter == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouter;
  }
}));

test('Legacy text router uses one Gateway-backed provider without replay', async () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
  CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE: '',
  CLOUDFLARE_AI_GATEWAY_CEREBRAS_BYOK_ALIAS: '',
  CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS: 'openrouter-alias',
}, async () => {
  const previousCerebras = process.env.CEREBRAS_API_KEY;
  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  process.env.CEREBRAS_API_KEY = 'direct-cerebras-key';
  delete process.env.OPENROUTER_API_KEY;
  try {
    const { resolveGatewayLegacyTextProvider } = await import('../../src/llm/chat-provider.js');
    const provider = resolveGatewayLegacyTextProvider('gpt-oss-120b');
    assert.equal(provider.name, 'openrouter');
    assert.equal(provider.model, 'openai/gpt-oss-120b');
    assert.equal(provider.key, '');
  } finally {
    if (previousCerebras == null) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = previousCerebras;
    if (previousOpenRouter == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouter;
  }
}));

test('Legacy text completion attaches Gateway authorization to an already-Gateway provider URL', async () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
  CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE: '',
  CLOUDFLARE_AI_GATEWAY_CEREBRAS_BYOK_ALIAS: '',
  CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS: 'openrouter-alias',
}, async () => {
  const previousCerebras = process.env.CEREBRAS_API_KEY;
  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;
  let captured = null;
  process.env.CEREBRAS_API_KEY = 'direct-cerebras-key';
  delete process.env.OPENROUTER_API_KEY;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const moduleUrl = new URL(`../../src/llm/groq-fallback.js?gateway-auth=${Date.now()}`, import.meta.url);
    const { groqFetch } = await import(moduleUrl);
    const response = await groqFetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer direct-key-must-not-leak', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'test' }] }),
    });
    assert.equal(response.ok, true);
    assert.equal(captured.url, 'https://gateway.ai.cloudflare.com/v1/account/gateway/openrouter/chat/completions');
    const headers = new Headers(captured.options.headers);
    assert.equal(headers.get('cf-aig-authorization'), 'Bearer gateway-token');
    assert.equal(headers.get('cf-aig-byok-alias'), 'openrouter-alias');
    assert.equal(headers.get('authorization'), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCerebras == null) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = previousCerebras;
    if (previousOpenRouter == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouter;
  }
}));

test('Dynamic chat route strips caller authorization for fetch', async () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
  CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE: 'core-text',
}, async () => {
  const { chatCompletionFetch } = await import('../../src/llm/chat-provider.js');
  let received;
  await chatCompletionFetch('openai/gpt-oss-20b:nitro', {
    method: 'POST', headers: { Authorization: 'Bearer direct-secret' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  }, { fetchImpl: async (_url, init) => {
    received = new Headers(init.headers);
    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  } });
  assert.equal(received.get('authorization'), null);
  assert.equal(received.get('cf-aig-authorization'), 'Bearer gateway-token');
}));

test('Dynamic chat streaming uses Gateway and emits content without a direct credential', async () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
  CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE: 'core-text',
}, async () => {
  const { chatCompletionStream } = await import('../../src/llm/chat-provider.js');
  let received;
  const chunks = [];
  const result = await chatCompletionStream('openai/gpt-oss-20b:nitro', {
    method: 'POST', headers: { Authorization: 'Bearer direct-secret' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  }, {
    onContent: (delta) => chunks.push(delta),
    fetchImpl: async (url, init) => {
      received = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
      return new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  assert.match(received.url, /gateway\.ai\.cloudflare\.com\/v1\/account\/gateway\/compat\/chat\/completions/);
  assert.equal(received.headers.get('authorization'), null);
  assert.equal(received.headers.get('cf-aig-authorization'), 'Bearer gateway-token');
  assert.equal(received.body.model, 'dynamic/core-text');
  assert.equal(received.body.stream, true);
  assert.deepEqual(chunks, ['Hello']);
  assert.equal(result.content, 'Hello');
  assert.equal(result.usage.prompt_tokens, 3);
}));

test('Gateway mode never leaks provider authorization or retries the direct provider', async () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
  CLOUDFLARE_AI_GATEWAY_CEREBRAS_BYOK_ALIAS: 'cerebras-alias',
}, async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response('bad gateway', { status: 502 });
  };
  const response = await gatewayFirstFetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer direct-token' }, body: JSON.stringify({ model: 'x' }),
  }, { fetchImpl });
  assert.equal(await response.text(), 'bad gateway');
  assert.match(calls[0].url, /gateway\.ai\.cloudflare\.com/);
  assert.equal(calls[0].headers.get('authorization'), null);
  assert.equal(calls.length, 1);
}));

test('Gateway routes multipart inference bodies once instead of bypassing', async () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
  CLOUDFLARE_AI_GATEWAY_CEREBRAS_BYOK_ALIAS: 'cerebras-alias',
}, async () => {
  const body = new FormData();
  body.append('file', new Blob(['audio']), 'audio.wav');
  let received;
  await gatewayFirstFetch('https://api.cerebras.ai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer direct-secret' }, body,
  }, { fetchImpl: async (url, init) => {
    received = { url: String(url), headers: new Headers(init.headers), body: init.body };
    return new Response('{}', { status: 200 });
  } });
  assert.match(received.url, /gateway\.ai\.cloudflare\.com/);
  assert.equal(received.headers.get('authorization'), null);
  assert.equal(received.body, body);
}));

test('Gateway uses documented provider credential passthrough when BYOK is not configured', async () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
  CLOUDFLARE_AI_GATEWAY_CEREBRAS_BYOK_ALIAS: '',
}, async () => {
  let received;
  await gatewayFirstFetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer provider-key' },
  }, { fetchImpl: async (_url, init) => {
    received = new Headers(init.headers);
    return new Response('{}');
  } });
  assert.equal(received.get('authorization'), 'Bearer provider-key');
  assert.equal(received.get('cf-aig-authorization'), 'Bearer gateway-token');
}));
