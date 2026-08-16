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
  'CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE',
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
  assert.equal(gatewayProviderUrl('openrouter', 'https://openrouter.ai/api/v1/chat/completions'), 'https://gateway.ai.cloudflare.com/v1/account/gateway/openrouter/chat/completions');
  assert.deepEqual(gatewayHeaders('cerebras'), {
    'cf-aig-authorization': 'Bearer token', 'cf-aig-skip-cache': 'true', 'cf-aig-byok-alias': 'first',
  });
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
