import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareChatSessionClient, nativeOrchestratorFor } from '../../src/agent/v2/cloudflare-chat-session-client.js';

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

test('native meta admission fails closed and flag off preserves Native V2', async () => withEnv({
  DURABLE_CHAT_AGENT_ENABLED: 'true', CLOUDFLARE_CHAT_AGENT_URL: 'https://chat.example', CLOUDFLARE_CHAT_AGENT_SECRET: 'secret',
}, async () => {
  const enabled = new CloudflareChatSessionClient({ fetchImpl: async () => Response.json({ mode: 'session', native_meta_mode: 'native-meta-v1' }) });
  const disabled = new CloudflareChatSessionClient({ fetchImpl: async () => Response.json({ mode: 'off', native_meta_mode: 'off' }) });
  const invalid = new CloudflareChatSessionClient({ fetchImpl: async () => Response.json({ mode: 'unexpected', native_meta_mode: 'unexpected' }) });
  assert.equal(await enabled.nativeMetaModeFor({ orgId: 'o', userId: 'u' }), 'native-meta-v1');
  assert.equal(await disabled.nativeMetaModeFor({ orgId: 'o', userId: 'u' }), 'off');
  assert.equal(await invalid.nativeMetaModeFor({ orgId: 'o', userId: 'u' }), 'off');
  assert.equal(nativeOrchestratorFor({ useTools: false, nativeMetaMode: 'off' }), 'v2');
  assert.equal(nativeOrchestratorFor({ useTools: false, nativeMetaMode: 'native-meta-v1' }), 'meta-v1');
  assert.equal(nativeOrchestratorFor({ useTools: true, nativeMetaMode: 'native-meta-v1' }), null);
}));
