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

test('bootstrap ignores client-supplied tenant ids and uses the session only', async () => {
  const res = responseCapture();
  const attacker = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const redisValues = new Map();
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST' }, res, pathname: '/v1/harness-chat/bootstrap',
    prisma: { userOrganization: { findUnique: async ({ where }) => (
      where.userId_orgId.userId === userId && where.userId_orgId.orgId === orgId ? { userId, isActive: true } : null
    ) } },
    requireSession: async () => ({ session: { orgId, userId } }),
    parseBody: async () => ({ user_id: attacker, org_id: attacker }),
    jsonResponse,
    env: {
      HIVE_HARNESS_TICKET_SECRET: 'test-harness-ticket-secret-at-least-32-bytes',
      HIVE_HARNESS_EDGE_EVAL_SECRET: 'test-edge-secret',
      HIVE_HARNESS_FLAG_URL: 'https://edge.example/flag',
    },
    fetchImpl: async () => new Response(JSON.stringify({
      key: 'hivemind_harness_chat_v1', source: 'cloudflare-flagship', variation: 'harness',
    })),
    getRedis: async () => ({ set: async (key, value) => { redisValues.set(key, value); return 'OK'; } }),
  });
  assert.equal(res.status, 200);
  const payload = JSON.parse(Buffer.from(res.json.ticket.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.sub, userId);
  assert.equal(payload.org_id, orgId);
});

test('bootstrap denies inactive membership with a secret-free diagnostic', async () => {
  const res = responseCapture();
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST' }, res, pathname: '/v1/harness-chat/bootstrap',
    prisma: { userOrganization: { findUnique: async () => ({ userId, isActive: false }) } },
    requireSession: async () => ({ session: { orgId, userId } }),
    parseBody: async () => ({}), jsonResponse,
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.diagnostic, 'membership_denied');
  assert.equal(JSON.stringify(res.json).includes('test-harness'), false);
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
