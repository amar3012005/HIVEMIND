import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudflareGatewayConfig,
  gatewayFirstFetch,
  gatewayHeaders,
  gatewayProviderForUrl,
  gatewayProviderUrl,
} from '../../src/llm/cloudflare-gateway.js';

const KEYS = [
  'CLOUDFLARE_AI_GATEWAY_ENABLED', 'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_AI_GATEWAY_ID', 'CLOUDFLARE_AI_GATEWAY_TOKEN',
  'CLOUDFLARE_AI_GATEWAY_CEREBRAS_BYOK_ALIAS',
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

test('Gateway failure retries the original request with its direct authorization', async () => withEnv({
  CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
}, async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return calls.length === 1 ? new Response('bad gateway', { status: 502 }) : new Response('ok');
  };
  const response = await gatewayFirstFetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer direct-token' }, body: JSON.stringify({ model: 'x' }),
  }, { fetchImpl });
  assert.equal(await response.text(), 'ok');
  assert.match(calls[0].url, /gateway\.ai\.cloudflare\.com/);
  assert.equal(calls[0].headers.get('authorization'), null);
  assert.equal(calls[1].url, 'https://api.cerebras.ai/v1/chat/completions');
  assert.equal(calls[1].headers.get('authorization'), 'Bearer direct-token');
}));
