import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createSealedCredential, hashApiKey, mapOidcRoles, verifyApiKey, verifyOidcJwt, verifySealedCredential } from '../lib/identity.mjs';

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('OIDC groups map to the highest tenant-local role', () => {
  assert.deepEqual(mapOidcRoles(['engineering', 'auditors'], { user: ['engineering'], auditor: ['auditors'], admin: ['admins'] }), ['auditor', 'user']);
});

test('locally verified RS256 OIDC claims require issuer, audience, expiry and signature', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const header = encode({ alg: 'RS256', kid: 'key-1', typ: 'JWT' });
  const payload = encode({ iss: 'https://id.example', aud: 'engine-box', sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 60 });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  const claims = verifyOidcJwt({ token: `${header}.${payload}.${signature}`, issuer: 'https://id.example', audience: 'engine-box', jwks: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1' }] } });
  assert.equal(claims.sub, 'user-1');
  assert.throws(() => verifyOidcJwt({ token: `${header}.${payload}.${signature}`, issuer: 'https://other.example', audience: 'engine-box', jwks: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1' }] } }), /issuer/);
});

test('break-glass and machine secrets are stored as verifiable hashes only', () => {
  const credential = createSealedCredential();
  assert.equal(verifySealedCredential(credential.secret, credential.sealed), true);
  assert.equal(verifySealedCredential('wrong', credential.sealed), false);
  const stored = hashApiKey('hmk_local_test');
  assert.equal(verifyApiKey('hmk_local_test', stored), true);
  assert.equal(verifyApiKey('wrong', stored), false);
});
