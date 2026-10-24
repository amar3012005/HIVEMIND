import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  OPEN_DOT_MODEL_RELAY_HEADERS as H,
  OPEN_DOT_MODEL_RELAY_PATH,
  signOpenDotModelRelayRequest,
  verifyOpenDotModelRelayRequest,
} from '../../src/employees/open-dot-model-relay-auth.js';
import { handleHarnessChatBootstrapRoute } from '../../src/routes/harness-chat.js';

const relaySecret = 'open-dot-model-relay-secret-at-least-32-bytes';
const bridgeToken = 'open-dot-runtime-bridge-token-at-least-32-bytes';
const env = { OPEN_DOT_MODEL_RELAY_SECRET: relaySecret, OPEN_DOT_RUNTIME_BRIDGE_TOKEN: bridgeToken };
const nowMs = 1_800_000_000_000;
const body = Buffer.from(JSON.stringify({ request_id: 'model-attempt-1', messages: [{ role: 'user', content: 'hi' }] }));

function signed({ secret = relaySecret, at = nowMs, nonce = randomUUID(), method = 'POST', payload = body } = {}) {
  const timestamp = String(Math.floor(at / 1000));
  return { [H.timestamp]: timestamp, [H.nonce]: nonce,
    [H.signature]: signOpenDotModelRelayRequest(secret, { method, timestamp, nonce, body: payload }) };
}
/** Independent restatement of Open Dot's `signBridgeRequest` canonical string. */
function openDotSignature(secret, { timestamp, nonce, payload = body }) {
  const canonical = ['POST', OPEN_DOT_MODEL_RELAY_PATH, timestamp, nonce, createHash('sha256').update(payload).digest('hex')].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}
function memoryRedis() {
  const keys = new Map();
  return { keys, set: async (key, value, _ex, _ttl, nx) => {
    assert.equal(nx, 'NX');
    if (keys.has(key)) return null;
    keys.set(key, value); return 'OK';
  } };
}
const verify = (headers, overrides = {}) => verifyOpenDotModelRelayRequest({ headers, method: 'POST', body, env, nowMs, ...overrides });

test('a signed relay request verifies once with the dedicated secret', async () => {
  const redis = memoryRedis();
  const headers = signed();
  assert.deepEqual(await verify(headers, { loadRedis: async () => redis }), { ok: true, scheme: 'hmac' });
  assert.deepEqual(await verify(headers, { loadRedis: async () => redis }), { ok: false, reason: 'replayed_nonce' });
});

test('signed requests reject a changed body, method, secret, stale timestamp or malformed nonce', async () => {
  assert.equal((await verify(signed({ payload: Buffer.from('{}') }))).reason, 'invalid_signature');
  assert.equal((await verify(signed({ method: 'PUT' }))).reason, 'invalid_signature');
  assert.equal((await verify(signed({ secret: bridgeToken }))).reason, 'invalid_signature');
  assert.equal((await verify(signed({ at: nowMs - 61_000 }))).reason, 'stale_timestamp');
  assert.equal((await verify(signed({ at: nowMs + 61_000 }))).reason, 'stale_timestamp');
  assert.equal((await verify(signed({ at: nowMs - 59_000 }))).ok, true);
  assert.equal((await verify(signed({ nonce: 'not-a-uuid-nonce-value' }))).reason, 'invalid_nonce');
  assert.equal((await verify(signed({ nonce: randomUUID().toUpperCase() }))).reason, 'invalid_nonce');
});

test('a signed request never falls back to the legacy bearer', async () => {
  const headers = { ...signed(), [H.signature]: '0'.repeat(64), authorization: `Bearer ${bridgeToken}` };
  assert.deepEqual(await verify(headers), { ok: false, reason: 'invalid_signature' });
  const unconfigured = await verify(signed(), { env: { OPEN_DOT_RUNTIME_BRIDGE_TOKEN: bridgeToken, OPEN_DOT_MODEL_RELAY_SECRET: 'too-short' } });
  assert.deepEqual(unconfigured, { ok: false, reason: 'relay_secret_unconfigured' });
});

test('an unsigned request is refused, including the shared bridge bearer', async () => {
  let redisLoads = 0;
  const loadRedis = async () => { redisLoads++; return null; };
  assert.deepEqual(await verify({ authorization: `Bearer ${bridgeToken}` }, { loadRedis }), { ok: false, reason: 'unauthorized' });
  assert.equal(redisLoads, 0);
  assert.equal((await verify({ authorization: `Bearer ${relaySecret}` })).ok, false);
  assert.equal((await verify({})).ok, false);
});

test('the signing input matches Open Dot bridge signatures byte for byte', async () => {
  const timestamp = String(Math.floor(nowMs / 1000)), nonce = randomUUID();
  const headers = { [H.timestamp]: timestamp, [H.nonce]: nonce, [H.signature]: openDotSignature(relaySecret, { timestamp, nonce }) };
  assert.equal(headers[H.signature], signOpenDotModelRelayRequest(relaySecret, { method: 'post', timestamp, nonce, body }));
  assert.deepEqual(await verify(headers), { ok: true, scheme: 'hmac' });
});

test('without Redis a nonce is single-use within the process', async () => {
  const headers = signed();
  assert.equal((await verify(headers)).ok, true);
  assert.equal((await verify(headers)).reason, 'replayed_nonce');
});

function routeRequest(headers, payload = body) {
  return { method: 'POST', headers, async *[Symbol.asyncIterator]() { yield payload; } };
}
async function callRoute(headers, routeEnv = env) {
  const res = {};
  await handleHarnessChatBootstrapRoute({
    req: routeRequest(headers), res, pathname: OPEN_DOT_MODEL_RELAY_PATH, prisma: {},
    parseBody: async () => { throw new Error('the relay route reads the raw body itself'); },
    jsonResponse: (r, b, status = 200) => Object.assign(r, { body: b, status }),
    getRedis: async () => null, env: routeEnv, fetchImpl: async () => { throw new Error('no upstream in this test'); },
  });
  return res;
}

test('relay route rejects unsigned, bearer-only or wrongly signed requests and admits signed ones', async () => {
  const realNowSigned = () => signed({ at: Date.now() });
  assert.equal((await callRoute({})).status, 401);
  assert.equal((await callRoute({ authorization: `Bearer ${bridgeToken}` })).status, 401);
  assert.equal((await callRoute({ ...realNowSigned(), [H.signature]: 'a'.repeat(64) })).status, 401);
  for (const headers of [realNowSigned()]) {
    const res = await callRoute(headers);
    // Authenticated requests reach relay validation, which rejects this minimal body.
    assert.equal(res.status, 400);
    assert.equal(res.body?.error, 'invalid_open_dot_model_request');
  }
});
