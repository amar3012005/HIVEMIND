import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_EDGE_CAPABILITIES, containsContentBearingFields, validateEntitlement, validateLifecycleEvent } from '../src/contract.js';

const org = '11111111-1111-4111-8111-111111111111';
describe('edge control-plane contract', () => {
  it('makes every capability opt-in', () => {
    const entitlement = validateEntitlement({ version: 1, organization_id: org, issued_at: '2026-09-06T00:00:00.000Z', expires_at: '2026-10-06T00:00:00.000Z', nonce: 'abcdefghijklmnop', flags: { cloudflare_edge: true } }, new Date('2026-09-07T00:00:00.000Z'));
    assert.equal(entitlement.flags.cloudflare_edge, true);
    assert.equal(entitlement.flags.cloudflare_ai_gateway, false);
    assert.equal(DEFAULT_EDGE_CAPABILITIES.cloudflare_tunnel, false);
  });

  it('rejects lifecycle content before it can enter a Queue', () => {
    assert.equal(containsContentBearingFields({ prompt: 'secret' }), true);
    assert.throws(() => validateLifecycleEvent({ organization_id: org, installation_id: 'engine-box-1', event: 'ready', memory: 'forbidden' }));
    assert.equal(validateLifecycleEvent({ organization_id: org, installation_id: 'engine-box-1', event: 'ready', state: 'ready' }).state, 'ready');
  });
});
