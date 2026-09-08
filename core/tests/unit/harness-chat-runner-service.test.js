import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyHarnessRunnerServiceToken } from '../../src/harness-chat/runner-service-token.js';
import { handleHarnessChatBootstrapRoute } from '../../src/routes/harness-chat.js';

const secret = 'runner-service-secret-that-is-at-least-32-bytes';
const userId = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';
const orgId = '67503d34-97e9-49a8-8c52-8ee30cc7603e';

function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy', sub: userId,
    org_id: orgId, profile: 'hivemind-chat', iat: now, exp: now + 30, jti: crypto.randomUUID(), ...overrides };
  const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
}

test('runner service token is short-lived, signed and tenant scoped', () => {
  assert.deepEqual(verifyHarnessRunnerServiceToken(token(), { secret }).sub, userId);
  assert.throws(() => verifyHarnessRunnerServiceToken(`${token()}x`, { secret }), /invalid_runner_service_signature/);
  assert.throws(() => verifyHarnessRunnerServiceToken(token({ exp: Math.floor(Date.now() / 1000) + 31 }), { secret }), /expired_runner_service_token/);
});

test('scoped proxy forwards only allowlisted operation with server-derived tenant', async () => {
  const res = {};
  const calls = [];
  const handled = await handleHarnessChatBootstrapRoute({
    req: { method: 'GET', headers: { authorization: `Bearer ${token()}` } }, res,
    pathname: '/internal/v1/harness-chat/core/api/profile',
    prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) } },
    parseBody: async () => ({}), jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    redisConfig: { coreApiBaseUrl: 'http://core.test' },
    env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, profile: { user_id: userId, org_id: orgId } }));
    },
  });
  assert.equal(handled, true); assert.equal(res.status, 200);
  assert.equal(calls[0].url, 'http://core.test/api/profile');
  assert.equal(calls[0].init.headers['x-hm-user-id'], userId);
  assert.equal(calls[0].init.headers['x-hm-org-id'], orgId);
  assert.ok(!calls[0].init.headers.authorization.includes(secret));
});

test('scoped proxy rejects invalid token before tenant lookup', async () => {
  const res = {};
  const handled = await handleHarnessChatBootstrapRoute({
    req: { method: 'POST', headers: { authorization: 'Bearer invalid' } }, res,
    pathname: '/internal/v1/harness-chat/core/api/recall',
    prisma: new Proxy({}, { get() { throw new Error('must not query'); } }),
    parseBody: async () => ({}), jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    redisConfig: {}, env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret }, fetchImpl: fetch,
  });
  assert.equal(handled, true); assert.equal(res.status, 401);
});
