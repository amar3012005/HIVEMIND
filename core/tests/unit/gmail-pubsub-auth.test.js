import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyPubSubAuth, resetGoogleCertsCache } from '../../src/connectors/providers/gmail/gmail-watch.js';

const audience = 'https://core.example.test/api/connectors/gmail/pubsub-webhook';
const serviceAccount = 'pubsub-push@fixture-project.iam.gserviceaccount.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-kid', alg: 'RS256', use: 'sig' };
const now = Date.parse('2026-10-24T12:00:00Z');
const seconds = Math.floor(now / 1000);
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(claims = {}, { key = privateKey, header = {} } = {}) {
  const head = b64({ alg: 'RS256', kid: 'fixture-kid', typ: 'JWT', ...header });
  const body = b64({ iss: 'https://accounts.google.com', aud: audience, exp: seconds + 600, iat: seconds - 10,
    email: serviceAccount, email_verified: true, ...claims });
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `Bearer ${head}.${body}.${signature}`;
}
let certFetches = 0;
const fetchImpl = async () => { certFetches += 1; return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'public, max-age=3600' } }); };
const verify = (header, options = {}) => verifyPubSubAuth(header, audience, { fetchImpl, now, expectedEmail: serviceAccount, ...options });

test.beforeEach(() => { resetGoogleCertsCache(); certFetches = 0; });

test('an unsigned token with correct claims is rejected', async () => {
  const [head, body] = token().slice(7).split('.');
  assert.equal(await verify(`Bearer ${head}.${body}.`), false);
  const none = `${b64({ alg: 'none', kid: 'fixture-kid' })}.${body}.`;
  assert.equal(await verify(`Bearer ${none}`), false);
});

test('a token signed by a key Google did not publish is rejected', async () => {
  assert.equal(await verify(token({}, { key: other.privateKey })), false);
  assert.equal(await verify(token({}, { header: { kid: 'unknown' } })), false);
});

test('wrong issuer, audience, expiry, or service account is rejected', async () => {
  assert.equal(await verify(token({ iss: 'https://evil.example' })), false);
  assert.equal(await verify(token({ aud: 'https://evil.example/hook' })), false);
  assert.equal(await verify(token({ exp: seconds - 3600 })), false);
  assert.equal(await verify(token({ email: 'attacker@evil.example' })), false);
  assert.equal(await verify(token({ email_verified: false })), false);
  assert.equal(await verify('Basic abc'), false);
});

test('a Google-signed Pub/Sub token is accepted and the keys are cached', async () => {
  assert.equal(await verify(token()), true);
  assert.equal(await verify(token({ iss: 'accounts.google.com' })), true);
  assert.equal(await verifyPubSubAuth(token({ email: 'any@x.test' }), audience, { fetchImpl, now }), true);
  assert.equal(certFetches, 1);
});

test('unavailable signing keys fail closed', async () => {
  const failing = async () => new Response('down', { status: 503 });
  assert.equal(await verifyPubSubAuth(token(), audience, { fetchImpl: failing, now }), false);
});
