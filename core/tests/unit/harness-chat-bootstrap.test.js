import test from 'node:test';
import assert from 'node:assert/strict';
import { handleHarnessChatBootstrapRoute } from '../../src/routes/harness-chat.js';

const orgId = '67503d34-97e9-49a8-8c52-8ee30cc7603e';
const userId = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';

function responseCapture() {
  return { json: null, status: null };
}

function jsonResponse(res, body, status = 200) {
  res.json = body;
  res.status = status;
}

test('permanent session deletion is authenticated and tenant scoped', async () => {
  const res = responseCapture();
  const calls = [];
  const handled = await handleHarnessChatBootstrapRoute({
    req: { method: 'DELETE' }, res, pathname: '/v1/harness-chat/sessions/session-delete-me',
    prisma: {
      userOrganization: { findUnique: async () => ({ userId }) },
      harnessSession: { deleteMany: async (args) => { calls.push(args); return { count: 1 }; } },
    },
    requireSession: async () => ({ session: { orgId, userId } }),
    parseBody: async () => ({}), jsonResponse,
  });
  assert.equal(handled, true);
  assert.deepEqual(calls, [{ where: { id: 'session-delete-me', orgId, userId } }]);
  assert.deepEqual(res.json, { deleted: true, session_id: 'session-delete-me' });
});

test('session deletion never reports success outside the authenticated tenant', async () => {
  const res = responseCapture();
  await handleHarnessChatBootstrapRoute({
    req: { method: 'DELETE' }, res, pathname: '/v1/harness-chat/sessions/session-other-user',
    prisma: {
      userOrganization: { findUnique: async () => ({ userId }) },
      harnessSession: { deleteMany: async () => ({ count: 0 }) },
    },
    requireSession: async () => ({ session: { orgId, userId } }),
    parseBody: async () => ({}), jsonResponse,
  });
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { error: 'Session not found' });
});

test('bootstrap requires the existing authenticated control-plane session', async () => {
  const res = responseCapture();
  const handled = await handleHarnessChatBootstrapRoute({
    req: { method: 'POST' }, res, pathname: '/v1/harness-chat/bootstrap',
    requireSession: async (_req, response) => { jsonResponse(response, { error: 'Unauthorized' }, 401); return null; },
    parseBody: async () => ({}), jsonResponse,
  });
  assert.equal(handled, true);
  assert.equal(res.status, 401);
});

test('bootstrap derives tenant scope, mints admission, and never creates a session row', async () => {
  const res = responseCapture();
  const redisValues = new Map();
  const prisma = {
    userOrganization: { findUnique: async () => ({ userId }) },
    harnessSession: new Proxy({}, { get() { throw new Error('bootstrap must not access session persistence'); } }),
  };
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST' }, res, pathname: '/v1/harness-chat/bootstrap', prisma,
    requireSession: async () => ({ session: { orgId, userId } }),
    parseBody: async () => ({}), jsonResponse,
    env: {
      HIVE_HARNESS_TICKET_SECRET: 'test-harness-ticket-secret-at-least-32-bytes',
      HIVE_HARNESS_EDGE_EVAL_SECRET: 'test-edge-secret',
      HIVE_HARNESS_FLAG_URL: 'https://edge.example/flag',
    },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://edge.example/flag');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { org_id: orgId, user_id: userId });
      return new Response(JSON.stringify({ key: 'hivemind_harness_chat_v1', source: 'cloudflare-flagship', variation: 'harness', evaluation_id: 'eval-1' }));
    },
    getRedis: async () => ({
      set: async (key, value) => { redisValues.set(key, value); return 'OK'; },
    }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['embed_url', 'expires_at', 'flag_receipt', 'mode', 'ticket']);
  assert.equal(res.json.mode, 'harness');
  assert.equal(res.json.flag_receipt.evaluation_id, 'eval-1');
  assert.equal(redisValues.size, 1);
});

test('bootstrap fails closed to legacy without a ticket when edge evaluation fails', async () => {
  const res = responseCapture();
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST' }, res, pathname: '/v1/harness-chat/bootstrap',
    prisma: { userOrganization: { findUnique: async () => ({ userId }) } },
    requireSession: async () => ({ session: { orgId, userId } }), parseBody: async () => ({}), jsonResponse,
    env: { HIVE_HARNESS_EDGE_EVAL_SECRET: 'edge-secret', HIVE_HARNESS_FLAG_URL: 'https://edge.example/flag' },
    fetchImpl: async () => { throw new Error('flagship unavailable'); },
  });
  assert.deepEqual(res.json, {
    mode: 'legacy', embed_url: '/hivemind/app/chat',
    flag_receipt: { key: 'hivemind_harness_chat_v1', variation: 'legacy' },
  });
});

test('a Harness flag never becomes a legacy selection when ticket admission fails', async () => {
  const res = responseCapture();
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST' }, res, pathname: '/v1/harness-chat/bootstrap',
    prisma: { userOrganization: { findUnique: async () => ({ userId }) } },
    requireSession: async () => ({ session: { orgId, userId} }), parseBody: async () => ({}), jsonResponse,
    env: {
      HIVE_HARNESS_TICKET_SECRET: 'not-distinct-but-otherwise-long-enough-ticket-secret',
      HIVEMIND_CONTROL_PLANE_SESSION_SECRET: 'not-distinct-but-otherwise-long-enough-ticket-secret',
      HIVE_HARNESS_EDGE_EVAL_SECRET: 'edge-secret', HIVE_HARNESS_FLAG_URL: 'https://edge.example/flag',
    },
    fetchImpl: async () => new Response(JSON.stringify({
      key: 'hivemind_harness_chat_v1', source: 'cloudflare-flagship', variation: 'harness',
    })),
  });
  assert.equal(res.status, 503);
  assert.equal(res.json.code, 'harness_admission_unavailable');
  assert.equal(res.json.flag_receipt.variation, 'harness');
  assert.equal(res.json.mode, undefined);
});

test('dedicated new-session route honors a legacy feature-flag variation', async () => {
  const res = responseCapture();
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST' }, res, pathname: '/v1/harness-chat/new-session',
    prisma: { userOrganization: { findUnique: async () => ({ userId, isActive: true }) } },
    requireSession: async () => ({ session: { orgId, userId } }), parseBody: async () => ({}), jsonResponse,
    env: {
      HIVE_HARNESS_EDGE_EVAL_SECRET: 'edge-secret',
      HIVE_HARNESS_FLAG_URL: 'https://edge.example/flag',
    },
    fetchImpl: async () => new Response(JSON.stringify({
      key: 'hivemind_harness_chat_v1', source: 'cloudflare-flagship', variation: 'legacy',
    })),
  });
  assert.equal(res.json.mode, 'legacy');
  assert.equal(res.json.embed_url, '/hivemind/app/chat');
  assert.deepEqual(res.json.flag_receipt, { key: 'hivemind_harness_chat_v1', variation: 'legacy' });
});

test('retired or unknown rollout modes fail closed to the legacy orchestrator', async () => {
  const res = responseCapture();
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST' }, res, pathname: '/v1/harness-chat/new-session',
    prisma: { userOrganization: { findUnique: async () => ({ userId, isActive: true }) } },
    requireSession: async () => ({ session: { orgId, userId } }), parseBody: async () => ({}), jsonResponse,
    env: { HIVE_HARNESS_EDGE_EVAL_SECRET: 'edge-secret', HIVE_HARNESS_FLAG_URL: 'https://edge.example/flag' },
    fetchImpl: async () => new Response(JSON.stringify({
      key: 'hivemind_harness_chat_v1', source: 'cloudflare-flagship', variation: 'preview',
    })),
  });
  assert.equal(res.json.mode, 'legacy');
  assert.equal(res.json.embed_url, '/hivemind/app/chat');
  assert.equal(res.json.ticket, undefined);
});
