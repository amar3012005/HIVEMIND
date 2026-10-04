import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRuntimeAttention } from '../../src/connectors/composio/runtime-attention.js';

const event = { id: 'event', org_id: 'org', user_id: 'user', subscription_id: 'sub', toolkit: 'slack', data: { text: 'A buyer decision changed.' } };
const consent = { enabled: true, orgId: 'org', userId: 'user', subscriptionId: 'sub' };
const snapshot = { orgId: 'org', userId: 'user', sessionId: 'native-room', revision: 'receipt', enabled: true, goals: ['Buyer validation'] };
const evaluate = (choice, overrides = {}) => assessRuntimeAttention({ event, consent, snapshot,
  provider: { decideChoice: async () => ({ choice, probability: 0.9, margin: 0.5 }) }, ...overrides });

test('default off performs no decision or delivery', async () => {
  let calls = 0;
  const result = await evaluate('wake', { consent: undefined, provider: { decideChoice: () => { calls++; } } });
  assert.equal(result.action, 'retain'); assert.equal(calls, 0);
});
test('tenant, user and subscription scope are exact', async () => {
  for (const changed of [{ org_id: 'other' }, { user_id: 'other' }, { subscription_id: 'other' }]) {
    assert.equal((await evaluate('wake', { event: { ...event, ...changed } })).reason, 'scope_mismatch');
  }
});
test('missing or foreign native snapshot cannot wake', async () => {
  assert.equal((await evaluate('wake', { snapshot: undefined })).action, 'retain');
  assert.equal((await evaluate('wake', { snapshot: { ...snapshot, userId: 'other' } })).action, 'retain');
});
test('paused Runtime can retain or notify but never be woken by a decision', async () => {
  assert.equal((await evaluate('wake', { snapshot: { ...snapshot, enabled: false } })).action, 'retain');
  assert.equal((await evaluate('notify', { snapshot: { ...snapshot, enabled: false } })).action, 'notify');
});
test('three attention choices remain distinct; notify never invokes agent delivery', async () => {
  for (const action of ['retain', 'notify', 'wake']) assert.equal((await evaluate(action)).action, action);
});
test('invalid, uncertain and failed decisions retain quietly', async () => {
  for (const decision of [{ choice: 'execute', probability: 1, margin: 1 }, { choice: 'wake', probability: 0.74, margin: 1 },
    { choice: 'wake', probability: NaN, margin: 1 }, { choice: 'wake', probability: 1, margin: 0.19 }]) {
    assert.equal((await evaluate('wake', { provider: { decideChoice: async () => decision } })).action, 'retain');
  }
  assert.equal((await evaluate('wake', { provider: { decideChoice: async () => { throw Error('offline'); } } })).reason, 'decision_unavailable');
});
test('bounded untrusted projection excludes raw credentials and provider identifiers', async () => {
  let request;
  await evaluate('wake', { event: { ...event, data: { text: 'x'.repeat(2000), api_key: 'secret' } },
    provider: { decideChoice: async value => { request = value; return { choice: 'retain', probability: 1, margin: 1 }; } } });
  assert.equal(request.state.source_is_untrusted, true);
  assert.equal(request.state.event.preview.length, 900);
  assert.ok(!JSON.stringify(request).includes('secret'));
});
