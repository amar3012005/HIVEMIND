import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeAttentionBridge } from '../../src/connectors/composio/runtime-attention-bridge.js';
const env = { HIVEMIND_RUNTIME_ATTENTION_URL: 'https://runner.example/internal/hivemind/runtime-attention', HIVE_HARNESS_RUNNER_SERVICE_SECRET: 'test-only-service-token-32-characters' };
const row = { id: 'event', org_id: 'org', user_id: 'user', relevance_decision: { runtimeAttention: { targetSessionId: 'native-room' } } };
test('missing configuration is off and malformed URL cannot redirect credentials', () => {
  assert.equal(createRuntimeAttentionBridge({ env: {} }), undefined);
  assert.equal(createRuntimeAttentionBridge({ env: { ...env, HIVEMIND_RUNTIME_ATTENTION_URL: 'https://runner.example/wrong' } }), undefined);
  assert.equal(createRuntimeAttentionBridge({ env: { ...env, HIVEMIND_RUNTIME_ATTENTION_URL: 'invalid' } }), undefined);
});
test('context and deliver carry only owner-scoped event identity, never event supplied endpoints', async () => {
  const calls = [];
  const bridge = createRuntimeAttentionBridge({ env, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(calls.length === 1 ? { consent: { enabled: true }, snapshot: { revision: 'receipt' } } : { status: 'accepted', reused: true, eventId: 'event', targetSessionId: 'native-room' }));
  } });
  assert.deepEqual(await bridge.readConsent(row), { enabled: true });
  assert.deepEqual(await bridge.readSnapshot(row), { revision: 'receipt' });
  assert.deepEqual(await bridge.deliver(row), { status: 'accepted', reused: true, eventId: 'event', targetSessionId: 'native-room' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), { operation: 'context', eventId: 'event', orgId: 'org', userId: 'user' });
});
test('nonreceipt and unknown transport outcomes remain unconfirmed', async () => {
  for (const fetchImpl of [async () => new Response(JSON.stringify({ status: 'queued' })), async () => { throw Error('network failure'); }]) {
    const bridge = createRuntimeAttentionBridge({ env, fetchImpl });
    await assert.rejects(() => bridge.deliver(row));
  }
});
