import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { authorizeLeaseOperation, verifyLicenseLease } from '../lib/license-lease.mjs';

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

test('offline signed lease stays locally verifiable and becomes safe read-only after expiry', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const lease = { installation_id: 'installation-1', expires_at: '2030-01-01T00:00:00Z', features: ['memory'] };
  const signature = crypto.sign(null, Buffer.from(canonicalize(lease)), privateKey).toString('base64');
  const state = verifyLicenseLease({ lease, signature, publicKey, installationId: 'installation-1' });
  assert.equal(state.mode, 'full');
  assert.equal(authorizeLeaseOperation(state, 'ingest'), true);
  const expiredLease = { ...lease, expires_at: '2020-01-01T00:00:00Z' };
  const expiredSignature = crypto.sign(null, Buffer.from(canonicalize(expiredLease)), privateKey).toString('base64');
  const expired = verifyLicenseLease({ lease: expiredLease, signature: expiredSignature, publicKey, installationId: 'installation-1' });
  assert.equal(expired.mode, 'read_only');
  assert.equal(authorizeLeaseOperation(expired, 'export'), true);
  assert.throws(() => authorizeLeaseOperation(expired, 'ingest'), /read-only/);
});
