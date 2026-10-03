import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRoute } from '../../src/knowledge/enterprise/litellm-client.js';
import { gatewayFirstFetch } from '../../src/llm/cloudflare-gateway.js';

test('GPT OSS ingestion uses OpenRouter on Cloudflare instead of the direct Groq account', async () => {
  const values = { CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'token',
    CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS: 'managed-openrouter' };
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    const route = pickRoute('openai/gpt-oss-120b');
    assert.equal(route.provider, 'openrouter');
    assert.ok(!route.base.includes('api.groq.com'));
    let actual;
    await gatewayFirstFetch(`${route.base}/chat/completions`, { headers: { Authorization: 'Bearer direct-key' } },
      { fetchImpl: async (url, init) => { actual = { url, init }; return new Response('{}'); } });
    assert.match(actual.url, /gateway\.ai\.cloudflare\.com\/v1\/account\/gateway\/openrouter\/chat\/completions/);
    assert.equal(actual.init.headers.get('authorization'), null);
    assert.equal(actual.init.headers.get('cf-aig-byok-alias'), 'managed-openrouter');
    assert.equal(pickRoute('google/gemini-2.5-flash-lite').provider, 'cf-gateway-compat');
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
