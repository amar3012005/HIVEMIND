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

test('native Harness entity lookup maps to the canonical Core route with bounded query parameters', async () => {
  const res = {};
  const calls = [];
  await handleHarnessChatBootstrapRoute({
    req: {
      method: 'GET',
      url: '/internal/v1/harness-chat/core/api/entities?q=Solvis&limit=5&ignored=never',
      headers: { authorization: `Bearer ${token()}` },
    },
    res,
    pathname: '/internal/v1/harness-chat/core/api/entities',
    prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) } },
    parseBody: async () => ({}),
    jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    redisConfig: { coreApiBaseUrl: 'http://core.test' },
    env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ matches: [{ canonical_name: 'Solvis GmbH' }] }));
    },
  });
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, 'http://core.test/api/entity-search?query=Solvis&limit=5');
  assert.equal(calls[0].init.headers['x-hm-user-id'], userId);
  assert.equal(calls[0].init.headers['x-hm-org-id'], orgId);
});

test('native Harness recall retries one bounded quick read when the primary provider times out', async () => {
  const res = {};
  const bodies = [];
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST', headers: { authorization: `Bearer ${token()}` } },
    res,
    pathname: '/internal/v1/harness-chat/core/api/recall',
    prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) } },
    parseBody: async () => ({ query_context: 'Solvis', max_memories: 15, scope_filter: 'organization' }),
    jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    redisConfig: { coreApiBaseUrl: 'http://core.test' },
    env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) throw new DOMException('The operation timed out', 'TimeoutError');
      return new Response(JSON.stringify({ results: [{ title: 'Solvis GmbH — Company profile' }], count: 1 }));
    },
  });
  assert.equal(res.status, 200);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].mode, 'quick');
  assert.equal(bodies[1].max_memories, 5);
  assert.equal(bodies[1].scope_filter, 'organization');
  assert.equal(res.body.results[0].title, 'Solvis GmbH — Company profile');
});

test('native Harness recall reports bounded unavailability without asserting empty memory', async () => {
  const res = {};
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST', headers: { authorization: `Bearer ${token()}` } },
    res,
    pathname: '/internal/v1/harness-chat/core/api/recall',
    prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) } },
    parseBody: async () => ({ query_context: 'who I am', max_memories: 5 }),
    jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    redisConfig: { coreApiBaseUrl: 'http://core.test' },
    env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret },
    fetchImpl: async () => { throw new DOMException('The operation timed out', 'TimeoutError'); },
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'memory_retrieval_timeout');
  assert.equal(res.body.retryable, true);
  assert.match(res.body.message, /No absence conclusion/);
});

test('native Harness web fallback starts and polls only tenant-scoped Core search jobs', async () => {
  const calls = [];
  for (const request of [
    { method: 'POST', pathname: '/internal/v1/harness-chat/core/api/web/search/jobs', body: { query: 'Singulance', limit: 5 } },
    { method: 'GET', pathname: '/internal/v1/harness-chat/core/api/web/jobs/123e4567-e89b-12d3-a456-426614174000' },
  ]) {
    const res = {};
    await handleHarnessChatBootstrapRoute({
      req: { method: request.method, headers: { authorization: `Bearer ${token()}` } }, res,
      pathname: request.pathname,
      prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) } },
      parseBody: async () => request.body || {},
      jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
      redisConfig: { coreApiBaseUrl: 'http://core.test' },
      env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ status: 'succeeded', results: [] }));
      },
    });
    assert.equal(res.status, 200);
  }
  assert.equal(calls[0].url, 'http://core.test/api/web/search/jobs');
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'Singulance', limit: 5 });
  assert.equal(calls[1].url, 'http://core.test/api/web/jobs/123e4567-e89b-12d3-a456-426614174000');
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.headers['x-hm-user-id'], userId);
  assert.equal(calls[1].init.headers['x-hm-org-id'], orgId);
});

test('scoped proxy forwards a save-status replay lookup without allowing other memory subroutes', async () => {
  const res = {};
  const calls = [];
  const handled = await handleHarnessChatBootstrapRoute({
    req: { method: 'GET', headers: { authorization: `Bearer ${token()}` } }, res,
    pathname: '/internal/v1/harness-chat/core/api/memories/save-status',
    prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) } },
    parseBody: async () => ({}), jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    redisConfig: { coreApiBaseUrl: 'http://core.test' }, env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ status: 'completed' }));
    },
  });
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, 'http://core.test/api/memories/save-status');
  assert.equal(calls[0].init.method, 'GET');
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

test('decision endpoint derives tenant scope and returns a non-executing selection', async () => {
  const res = {};
  const calls = [];
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST', headers: { authorization: `Bearer ${token()}` } }, res,
    pathname: '/internal/v1/harness-chat/core/decision',
    prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) } },
    parseBody: async () => ({ stage: 'capability', user_query: 'Find my last Gmail message', context: { authenticated_scope: { user_id: 'forged' } } }),
    jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    redisConfig: {}, env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret }, fetchImpl: fetch,
    decisionHandler: async (input) => {
      calls.push(input);
      return { status: 'selected', mode: 'active', stage: 'capability', selected: 'composio_search', authoritative: true };
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.selected, 'composio_search');
  assert.equal(calls[0].runtime, 'harness');
  assert.equal(calls[0].context.authenticated_scope.user_id, userId);
  assert.equal(calls[0].context.authenticated_scope.org_id, orgId);
});

test('decision endpoint converts internal failure to same-turn defer', async () => {
  const res = {};
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST', headers: { authorization: `Bearer ${token()}` } }, res,
    pathname: '/internal/v1/harness-chat/core/decision',
    prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) } },
    parseBody: async () => ({ stage: 'capability', user_query: 'hello' }),
    jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    redisConfig: {}, env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret, JEV_DECISION_GATEWAY_MODE: 'active' }, fetchImpl: fetch,
    decisionHandler: async () => { throw new Error('jev unavailable'); },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'defer');
  assert.match(res.body.reason, /jev unavailable/);
});

test('project catalog exposes only policy-authorized project labels to the ticket subject', async () => {
  const res = {};
  const calls = [];
  const handled = await handleHarnessChatBootstrapRoute({
    req: { method: 'GET', headers: { authorization: `Bearer ${token()}` } }, res,
    pathname: '/internal/v1/harness-chat/core/projects',
    prisma: {
      userOrganization: { findUnique: async () => ({ isActive: true, role: 'member' }) },
      teamMember: { findMany: async () => [] },
      $queryRawUnsafe: async (query, ...args) => {
        calls.push({ query, args });
        return [{ id: 'b79673b4-4578-4fc2-8144-05056983f4e1', org_id: orgId, team_id: null,
          name: 'Authorized project', slug: 'authorized-project', description: null, status: 'active',
          policy: 'org_visible', created_by: userId, created_at: new Date(), updated_at: new Date(),
          member_count: 1, memory_count: 0 }];
      },
    },
    parseBody: async () => ({}), jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    redisConfig: {}, env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret }, fetchImpl: fetch,
  });
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.projects, [{ id: 'b79673b4-4578-4fc2-8144-05056983f4e1', name: 'Authorized project', slug: 'authorized-project' }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /project_members/);
});

test('receipt endpoint is admitted outside the Core proxy namespace', async () => {
  const rows = new Map();
  const model = {
    findUnique: async ({ where }) => [...rows.values()].find((row) => row.sessionId === where.sessionId_callId.sessionId && row.callId === where.sessionId_callId.callId) || null,
    create: async ({ data }) => { rows.set(data.id, structuredClone(data)); return structuredClone(data); },
  };
  const res = {};
  const handled = await handleHarnessChatBootstrapRoute({
    req: { method: 'POST', headers: { authorization: `Bearer ${token()}` } }, res,
    pathname: '/internal/v1/harness-chat/receipts',
    prisma: {
      userOrganization: { findUnique: async () => ({ isActive: true }) },
      $transaction: async (action) => action({ $executeRawUnsafe: async () => [], connectedAppReceipt: model }),
    },
    parseBody: async () => ({
      session_id: 'session-12345678', call_id: 'receipt-route-test', provider: 'composio', tool: 'GMAIL_FETCH_EMAILS',
      projection_policy: 'selected-contract', allowed_fields: ['subject'], approved_projection: { subject: 'test' }, raw_receipt: { private: 'test' },
    }),
    jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    redisConfig: {}, env: {
      HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret,
      HIVE_CONNECTED_APP_RECEIPT_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    }, fetchImpl: fetch,
  });
  assert.equal(handled, true);
  assert.equal(res.status, 201);
  assert.equal(res.body.stored, true);
});

test('runner admits one actual Composio execution and makes replay idempotent', async () => {
  const calls = [];
  const creditService = { charge: async (input) => { calls.push(input); return { admitted: true, duplicate: calls.length > 1 }; } };
  const invoke = async (callId) => {
    const res = {};
    await handleHarnessChatBootstrapRoute({
      req: { method: 'POST', headers: { authorization: `Bearer ${token()}` } }, res,
      pathname: '/internal/v1/harness-chat/credit-operations',
      prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) } },
      parseBody: async () => ({ session_id: 'session-12345678', turn_id: 3, call_id: callId, kind: 'composio_execution', tool: 'GMAIL_FETCH_EMAILS' }),
      jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
      redisConfig: {}, env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret }, creditService,
    });
    return res;
  };
  assert.equal((await invoke('call-1')).status, 200);
  assert.equal((await invoke('call-1')).body.duplicate, true);
  assert.equal(calls[0].service, 'composio_tool_call');
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
  assert.match(calls[0].idempotencyKey, /^harness:[a-f0-9]{64}$/);
});

test('runner charges a no-tool Harness turn once and rejects exhausted credits', async () => {
  const res = {};
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST', headers: { authorization: `Bearer ${token()}` } }, res,
    pathname: '/internal/v1/harness-chat/credit-operations',
    prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) }, $queryRawUnsafe: async () => [] },
    parseBody: async () => ({ session_id: 'session-12345678', turn_id: 3, call_id: 'turn-3', kind: 'no_tool_turn' }),
    jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    redisConfig: {}, env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret },
    creditService: { charge: async () => ({ admitted: false }) },
  });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'credits_exhausted');
});

test('runner admits a turn without debiting and blocks exhausted credits before model dispatch', async () => {
  const calls = [];
  const invoke = async (summary) => {
    const res = {};
    await handleHarnessChatBootstrapRoute({
      req: { method: 'POST', headers: { authorization: `Bearer ${token()}` } }, res,
      pathname: '/internal/v1/harness-chat/credit-operations',
      prisma: { userOrganization: { findUnique: async () => ({ isActive: true }) } },
      parseBody: async () => ({ session_id: 'session-12345678', turn_id: 3, call_id: 'turn-3-admission', kind: 'turn_admission' }),
      jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
      redisConfig: {}, env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret },
      creditService: {
        getSummary: async () => summary,
        charge: async (...args) => { calls.push(args); return { admitted: true }; },
      },
    });
    return res;
  };

  const allowed = await invoke({ plan: 'free', included: 500, used: 499, reserved: 0, remaining: 1, unlimited: false });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.admitted, true);
  assert.equal(calls.length, 0);

  const exhausted = await invoke({ plan: 'free', included: 500, used: 500, reserved: 0, remaining: 0, unlimited: false });
  assert.equal(exhausted.status, 402);
  assert.equal(exhausted.body.code, 'plan_limit_exceeded');
  assert.equal(exhausted.body.resource, 'credits');
  assert.equal(calls.length, 0);
});

test('bootstrap surface selection is independent of credits; exhausted credits are enforced at turn admission', async () => {
  const res = {};
  const redisValues = new Map();
  const handled = await handleHarnessChatBootstrapRoute({
    req: { method: 'POST', headers: {} }, res,
    pathname: '/v1/harness-chat/bootstrap',
    requireSession: async () => ({ session: { userId, orgId } }),
    prisma: { userOrganization: { findUnique: async () => ({ userId }) } },
    parseBody: async () => ({}),
    jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    env: {
      HIVE_HARNESS_TICKET_SECRET: 'test-harness-ticket-secret-at-least-32-bytes',
      HIVE_HARNESS_EDGE_EVAL_SECRET: 'edge-secret',
      HIVE_HARNESS_FLAG_URL: 'https://edge.example/flag',
    },
    fetchImpl: async () => new Response(JSON.stringify({
      key: 'hivemind_harness_chat_v1', source: 'cloudflare-flagship', variation: 'harness',
    })),
    getRedis: async () => ({ set: async (key, value) => { redisValues.set(key, value); return 'OK'; } }),
    creditService: { getSummary: async () => ({ plan: 'free', included: 500, used: 500, reserved: 0, remaining: 0, unlimited: false }) },
  });
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'harness');
  assert.equal(typeof res.body.ticket, 'string');
  assert.equal(redisValues.size, 1);
});

test('terminal no-tool reconciliation does not debit a turn with an admitted Composio operation', async () => {
  const res = {};
  const queries = [];
  const creditService = { charge: async () => { throw new Error('must not charge'); } };
  await handleHarnessChatBootstrapRoute({
    req: { method: 'POST', headers: { authorization: `Bearer ${token()}` } }, res,
    pathname: '/internal/v1/harness-chat/credit-operations',
    prisma: {
      userOrganization: { findUnique: async () => ({ isActive: true }) },
      $queryRawUnsafe: async (query, ...args) => {
        queries.push({ query, args });
        return [{ exists: 1 }];
      },
    },
    parseBody: async () => ({ session_id: 'session-12345678', turn_id: 3, call_id: 'turn-3', kind: 'no_tool_turn' }),
    jsonResponse: (response, body, status = 200) => Object.assign(response, { body, status }),
    redisConfig: {}, env: { HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret }, creditService,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { admitted: true, duplicate: true, service: 'composio_tool_call' });
  assert.equal(queries.length, 1);
  assert.equal(queries[0].args.at(-1), '3');
});
