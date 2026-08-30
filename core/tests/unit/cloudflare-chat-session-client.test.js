import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareChatSessionClient } from '../../src/agent/v2/cloudflare-chat-session-client.js';

async function withEnv(values, fn) {
  const prior = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await fn(); } finally { for (const [key, value] of Object.entries(prior)) value == null ? delete process.env[key] : process.env[key] = value; }
}

test('flag evaluation is fail-closed and accepts only known modes', async () => withEnv({
  DURABLE_CHAT_AGENT_ENABLED: 'true', CLOUDFLARE_CHAT_AGENT_URL: 'https://chat.example', CLOUDFLARE_CHAT_AGENT_SECRET: 'secret',
}, async () => {
  const good = new CloudflareChatSessionClient({ fetchImpl: async () => Response.json({ mode: 'session' }) });
  const unknown = new CloudflareChatSessionClient({ fetchImpl: async () => Response.json({ mode: 'surprise' }) });
  const failed = new CloudflareChatSessionClient({ fetchImpl: async () => { throw new Error('offline'); }, logger: { warn() {} } });
  assert.equal(await good.modeFor({ orgId: 'o', userId: 'u' }), 'session');
  assert.equal(await unknown.modeFor({ orgId: 'o', userId: 'u' }), 'off');
  assert.equal(await failed.modeFor({ orgId: 'o', userId: 'u' }), 'off');
}));

test('environment kill switch avoids any Cloudflare request', async () => withEnv({ DURABLE_CHAT_AGENT_ENABLED: 'false' }, async () => {
  let called = false;
  const client = new CloudflareChatSessionClient({ fetchImpl: async () => { called = true; return Response.json({ mode: 'full' }); } });
  assert.equal(await client.modeFor({ orgId: 'o', userId: 'u' }), 'off');
  assert.equal(called, false);
}));
