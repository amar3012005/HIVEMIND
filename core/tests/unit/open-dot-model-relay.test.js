import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mintOpenDotModelToken, validateOpenDotModelRequest, relayOpenDotModelStream } from '../../src/employees/open-dot-model-relay.js';

const user = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';
const org = '67503d34-97e9-49a8-8c52-8ee30cc7603e';
const employee = '64f5568b-4d6a-4ae1-9a33-48cb2909d59b';
const body = () => ({ organization_id: org, user_id: user, employee_id: employee,
  dot_id: 'dot_verified', session_id: 'conv_verified', request_id: 'model-attempt-1',
  provider: 'cloudflare-workers-ai', model: '@cf/zai-org/glm-5.3-flash', messages: [{ role: 'user', content: 'Reply once' }], max_tokens: 8192 });
const env = { HIVE_HARNESS_RUNNER_SERVICE_SECRET: 'test-existing-runner-service-secret-at-least32' };
const db = (overrides = {}) => ({ userOrganization: { findUnique: async () => ({ role: 'owner', isActive: true }) },
  digitalEmployee: { findFirst: async () => ({ id: employee, orgId: org, createdBy: user, status: 'active',
    policyRules: { open_dot_employee: { version: 1, execution_backend: 'open-dot', state: 'bound', dot_id: 'dot_verified' },
      native_lifecycle: { version: 1, phase: 'active' } }, ...overrides }) } });
function response() {
  const res = new EventEmitter(); res.chunks = []; res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  res.write = chunk => { res.chunks.push(String(chunk)); return true; };
  res.end = () => { res.writableEnded = true; };
  return res;
}

test('model grant binds exact body, tenant and fixed native route with thirty-second audience', () => {
  const input = body(); validateOpenDotModelRequest(input);
  const token = mintOpenDotModelToken(input, env.HIVE_HARNESS_RUNNER_SERVICE_SECRET, 100_000);
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  assert.equal(claims.aud, 'hivemind-open-dot-model-broker');
  assert.equal(claims.exp - claims.iat, 30);
  assert.equal(claims.sub, user); assert.equal(claims.employee_id, employee);
  assert.equal(claims.body_sha256, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
  const fallback = { ...input, provider: 'openai-codex', model: 'gpt-6-luna', request_id: 'fallback-2',
    fallback_from: { provider: input.provider, model: input.model, request_id: input.request_id,
      failure_code: 'provider_unavailable', output_started: false } };
  validateOpenDotModelRequest(fallback);
  assert.throws(() => validateOpenDotModelRequest({ ...fallback, fallback_from: undefined }));
  assert.throws(() => validateOpenDotModelRequest({ ...fallback, fallback_from: { ...fallback.fallback_from, output_started: true } }));
  for (const bad of [{ ...input, provider: 'arbitrary' }, { ...input, max_tokens: 8193 }, { ...input, endpoint: 'http://elsewhere' },
    { ...input, messages: [] }, { ...input, stream: false }]) assert.throws(() => validateOpenDotModelRequest(bad));
});

test('relay validates canonical binding and streams without exposing OAuth or changing sessions', async () => {
  const req = new EventEmitter(), res = response(); let calls = 0;
  await relayOpenDotModelStream(db(), req, res, body(), { env, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, 'http://harness-runner:3080/internal/hivemind/open-dot/model/stream');
    assert.equal(init.redirect, 'error'); assert.equal(init.signal.aborted, false);
    assert.match(init.headers.authorization, /^Bearer /);
    return new Response('data: {"choices":[{"delta":{"content":"Ready"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  assert.equal(calls, 1); assert.equal(res.status, 200); assert.equal(res.writableEnded, true);
  assert.match(res.chunks.join(''), /Ready/); assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});

test('wrong employee dot ownership and inactive membership cannot invoke model', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; assert.fail('unauthorized call'); };
  await assert.rejects(relayOpenDotModelStream(db({ archivedAt: new Date() }), new EventEmitter(), response(), body(), { env, fetchImpl }));
  await assert.rejects(relayOpenDotModelStream(db(), new EventEmitter(), response(), { ...body(), dot_id: 'dot_other' }, { env, fetchImpl }));
  const inactive = db(); inactive.userOrganization.findUnique = async () => ({ isActive: false });
  await assert.rejects(relayOpenDotModelStream(inactive, new EventEmitter(), response(), body(), { env, fetchImpl }));
  assert.equal(calls, 0);
});

test('client disconnect cancels upstream and no new model attempt is started', async () => {
  const req = new EventEmitter(), res = response(); let calls = 0, signal;
  await assert.rejects(relayOpenDotModelStream(db(), req, res, body(), { env, fetchImpl: async (_url, init) => {
    calls++; signal = init.signal; res.destroyed = true; res.emit('close'); signal.throwIfAborted();
  } }));
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
  assert.equal(res.headersSent, undefined); assert.equal(res.listenerCount('close'), 0);
});
