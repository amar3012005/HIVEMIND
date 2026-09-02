import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { canonicalizeEntitlement, resolveEntitlements, verifySignedEntitlement } from '../lib/entitlements.mjs';

function entitlement(overrides = {}) {
  return {
    version: 1,
    installation_id: 'install-123',
    expires_at: '2030-01-01T00:00:00.000Z',
    release_channel: 'stable',
    engine_box_enabled: true,
    cloudflare_management: false,
    telemetry: false,
    tunnel: false,
    automatic_updates: false,
    support_session: false,
    remote_inference: false,
    ...overrides,
  };
}

test('a remote entitlement cannot enable an opt-in capability without matching local consent', () => {
  const remote = entitlement({ remote_inference: true, tunnel: true, automatic_updates: true });
  const effective = resolveEntitlements({ entitlement: remote, localConsent: { remote_inference: true } });
  assert.equal(effective.remote_inference, true);
  assert.equal(effective.tunnel, false);
  assert.equal(effective.automatic_updates, false);
});

test('entitlements are installation-bound and offline-verifiable', () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const value = entitlement();
  const signature = crypto.sign(null, Buffer.from(canonicalizeEntitlement(value)), keys.privateKey).toString('base64');
  assert.equal(verifySignedEntitlement({ entitlement: value, signature, publicKey: keys.publicKey, installationId: 'install-123' }), true);
  assert.equal(verifySignedEntitlement({ entitlement: value, signature, publicKey: keys.publicKey, installationId: 'other-install' }), false);
});

test('unknown fields and expired entitlements are rejected rather than ignored', () => {
  assert.throws(() => resolveEntitlements({ entitlement: entitlement({ unexpected: true }) }), /unsupported field/);
  assert.throws(() => resolveEntitlements({ entitlement: entitlement({ expires_at: '2020-01-01T00:00:00.000Z' }) }), /expired/);
});
