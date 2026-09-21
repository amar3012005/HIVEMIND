import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAgentScopeCapabilityRoute } from '../../src/routes/agentscope-capabilities.js';

const jsonResponse = (_res, body, statusCode = 200) => ({ body, statusCode });
const baseReq = { headers: { 'x-hm-user-id': '11111111-1111-1111-1111-111111111111', 'x-hm-org-id': '22222222-2222-2222-2222-222222222222' }, method: 'POST' };

test('playbook catalog is compact until the selected playbook is requested', async () => {
  const queries = [];
  const prisma = {
    userOrganization: { findFirst: async () => ({ orgId: '22222222-2222-2222-2222-222222222222' }) },
    $queryRawUnsafe: async (sql, ...args) => { queries.push({ sql, args }); return []; },
  };
  const listed = await handleAgentScopeCapabilityRoute({ req: baseReq, res: {}, parseBody: async () => ({}), jsonResponse, prisma, pathname: '/internal/hivemind/playbooks' });
  assert.equal(listed.body.playbooks.some((item) => Object.hasOwn(item, 'instructions')), false);
  const loaded = await handleAgentScopeCapabilityRoute({ req: baseReq, res: {}, parseBody: async () => ({ id: 'global:market-research' }), jsonResponse, prisma, pathname: '/internal/hivemind/playbooks/get' });
  assert.match(loaded.body.playbook.instructions, /native Tasks/);
  assert.equal(queries.length, 0);
});

test('company context is scoped to the authenticated organization', async () => {
  let captured = null;
  const prisma = {
    userOrganization: { findFirst: async () => ({ orgId: '22222222-2222-2222-2222-222222222222' }) },
    $queryRawUnsafe: async (_sql, orgId) => { captured = orgId; return [{ company: { name: 'HIVE' } }]; },
    user: { findUnique: async () => ({ id: '11111111-1111-1111-1111-111111111111', email: 'operator@example.com', displayName: 'Operator' }) },
  };
  const result = await handleAgentScopeCapabilityRoute({ req: { ...baseReq, method: 'GET' }, res: {}, parseBody: async () => ({}), jsonResponse, prisma, pathname: '/internal/hivemind/company-context' });
  assert.equal(captured, '22222222-2222-2222-2222-222222222222');
  assert.equal(result.body.company.name, 'HIVE');
});

test('artifact registration stores immutable bytes and appends a durable WorkRun receipt', async () => {
  const calls = [];
  const prisma = {
    userOrganization: { findFirst: async () => ({ orgId: '22222222-2222-2222-2222-222222222222' }) },
    $queryRawUnsafe: async (sql, ...args) => {
      calls.push({ sql, args });
      if (sql.includes('SELECT id, room_id, turn_id, status')) return [{ id: '33333333-3333-3333-3333-333333333333', room_id: '44444444-4444-4444-4444-444444444444', turn_id: '55555555-5555-5555-5555-555555555555', status: 'running' }];
      return [{ id: '33333333-3333-3333-3333-333333333333', status: 'running' }];
    },
    sourceArtifact: {
      findFirst: async () => null,
      upsert: async ({ create }) => ({ id: '66666666-6666-6666-6666-666666666666', checksum: create.checksum, contentType: create.contentType, sizeBytes: create.sizeBytes, version: create.version, createdAt: new Date() }),
    },
  };
  const result = await handleAgentScopeCapabilityRoute({
    req: baseReq, res: {}, parseBody: async () => ({ agentscope_session_id: 'session-1', path: 'reports/brief.md', title: 'Research brief', content_type: 'text/markdown', content_base64: Buffer.from('# Brief').toString('base64') }),
    jsonResponse, prisma, pathname: '/internal/hivemind/artifacts',
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.artifact.path, 'reports/brief.md');
  assert.ok(calls.some(({ sql }) => sql.includes('result_artifact_ids')));
  assert.ok(calls.some(({ sql }) => sql.includes('SET events')));
});

test('artifact registration stores WorkRun bytes in the configured object store', async () => {
  let stored = null;
  const prisma = {
    userOrganization: { findFirst: async () => ({ orgId: '22222222-2222-2222-2222-222222222222' }) },
    $queryRawUnsafe: async (sql) => sql.includes('SELECT id, room_id, turn_id, status')
      ? [{ id: '33333333-3333-3333-3333-333333333333', room_id: '44444444-4444-4444-4444-444444444444', turn_id: '55555555-5555-5555-5555-555555555555', status: 'running' }]
      : [{ id: '33333333-3333-3333-3333-333333333333', status: 'running' }],
    sourceArtifact: { findFirst: async () => null, upsert: async ({ create }) => {
      stored = create;
      return { id: '66666666-6666-6666-6666-666666666666', checksum: create.checksum, contentType: create.contentType, sizeBytes: create.sizeBytes, version: create.version, createdAt: new Date() };
    } },
  };
  const artifactStorage = {
    configured: () => true,
    persistFile: async ({ orgId, checksum, filename, fileBuffer }) => {
      assert.equal(orgId, '22222222-2222-2222-2222-222222222222');
      assert.equal(checksum.length, 64);
      assert.match(filename, /^33333333-3333-3333-3333-333333333333-/);
      assert.equal(fileBuffer.toString(), '# Brief');
      return { objectKey: `org/${orgId}/sha256/${checksum}/brief.md`, etag: 'etag-1' };
    },
  };
  const result = await handleAgentScopeCapabilityRoute({
    req: baseReq, res: {}, parseBody: async () => ({ agentscope_session_id: 'session-1', path: 'reports/brief.md', title: 'Research brief', content_type: 'text/markdown', content_base64: Buffer.from('# Brief').toString('base64') }),
    jsonResponse, prisma, artifactStorage, pathname: '/internal/hivemind/artifacts',
  });
  assert.equal(result.statusCode, 200);
  assert.match(stored.storageLocation, /^r2:org\//);
  assert.equal(stored.payload.content_base64, undefined);
  assert.match(stored.payload.object_key, /^org\//);
  assert.equal(stored.metadata.durable_object_key, stored.payload.object_key);
  assert.match(stored.sourceId, /^workrun:44444444-4444-4444-4444-444444444444:/);
  assert.equal(stored.version, 1);
});

test('artifact registration assigns the next immutable version for changed bytes at the same room path', async () => {
  let stored = null;
  const prisma = {
    userOrganization: { findFirst: async () => ({ orgId: '22222222-2222-2222-2222-222222222222' }) },
    $queryRawUnsafe: async (sql) => sql.includes('SELECT id, room_id, turn_id, status')
      ? [{ id: '33333333-3333-3333-3333-333333333333', room_id: '44444444-4444-4444-4444-444444444444', turn_id: '55555555-5555-5555-5555-555555555555', status: 'running' }]
      : [{ id: '33333333-3333-3333-3333-333333333333', status: 'running' }],
    sourceArtifact: {
      findFirst: async () => ({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', checksum: 'different-checksum', version: 4 }),
      upsert: async ({ create }) => { stored = create; return { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', checksum: create.checksum, contentType: create.contentType, sizeBytes: create.sizeBytes, version: create.version, createdAt: new Date() }; },
    },
  };
  const result = await handleAgentScopeCapabilityRoute({
    req: baseReq, res: {}, parseBody: async () => ({ agentscope_session_id: 'session-1', path: 'reports/brief.md', title: 'Research brief', content_base64: Buffer.from('new brief').toString('base64') }),
    jsonResponse, prisma, pathname: '/internal/hivemind/artifacts',
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.artifact.version, 5);
  assert.equal(stored.version, 5);
  assert.equal(stored.metadata.previous_artifact_id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
});

test('artifact registration retains the logical path version when immutable bytes are deduplicated', async () => {
  const prisma = {
    userOrganization: { findFirst: async () => ({ orgId: '22222222-2222-2222-2222-222222222222' }) },
    $queryRawUnsafe: async (sql) => sql.includes('SELECT id, room_id, turn_id, status')
      ? [{ id: '33333333-3333-3333-3333-333333333333', room_id: '44444444-4444-4444-4444-444444444444', turn_id: '55555555-5555-5555-5555-555555555555', status: 'running' }]
      : [{ id: '33333333-3333-3333-3333-333333333333', status: 'running' }],
    sourceArtifact: {
      findFirst: async () => ({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', checksum: 'different-checksum', version: 5 }),
      // The same bytes already have an immutable receipt from another path.
      upsert: async ({ create }) => ({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', checksum: create.checksum, contentType: create.contentType, sizeBytes: create.sizeBytes, version: 1, createdAt: new Date() }),
    },
  };
  const result = await handleAgentScopeCapabilityRoute({
    req: baseReq, res: {}, parseBody: async () => ({ agentscope_session_id: 'session-1', path: 'reports/brief.md', title: 'Research brief', content_base64: Buffer.from('reused bytes').toString('base64') }),
    jsonResponse, prisma, pathname: '/internal/hivemind/artifacts',
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.artifact.version, 6);
});

test('artifact registration refuses an inline fallback when configured storage fails', async () => {
  let persisted = false;
  const prisma = {
    userOrganization: { findFirst: async () => ({ orgId: '22222222-2222-2222-2222-222222222222' }) },
    $queryRawUnsafe: async (sql) => sql.includes('SELECT id, room_id, turn_id, status') ? [{ id: '33333333-3333-3333-3333-333333333333', status: 'running' }] : [],
    sourceArtifact: { findFirst: async () => null, upsert: async () => { persisted = true; } },
  };
  const result = await handleAgentScopeCapabilityRoute({
    req: baseReq, res: {}, parseBody: async () => ({ agentscope_session_id: 'session-1', path: 'brief.md', title: 'Brief', content_base64: Buffer.from('bytes').toString('base64') }),
    jsonResponse, prisma, artifactStorage: { configured: () => true, persistFile: async () => { throw Object.assign(new Error('R2 down'), { code: 'R2_UNAVAILABLE' }); } },
    pathname: '/internal/hivemind/artifacts',
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'R2_UNAVAILABLE');
  assert.equal(persisted, false);
});

test('artifact registration rejects traversal and malformed bytes before persistence', async () => {
  let persisted = false;
  const prisma = {
    userOrganization: { findFirst: async () => ({ orgId: '22222222-2222-2222-2222-222222222222' }) },
    $queryRawUnsafe: async (sql) => sql.includes('SELECT id, room_id, turn_id, status') ? [{ id: '33333333-3333-3333-3333-333333333333', status: 'running' }] : [],
    sourceArtifact: { upsert: async () => { persisted = true; } },
  };
  const result = await handleAgentScopeCapabilityRoute({
    req: baseReq, res: {}, parseBody: async () => ({ agentscope_session_id: 'session-1', path: '../secret.txt', title: 'Nope', content_base64: 'not base64!' }),
    jsonResponse, prisma, pathname: '/internal/hivemind/artifacts',
  });
  assert.equal(result.statusCode, 400);
  assert.equal(persisted, false);
});

test('company-record context endpoints return compact, authenticated metadata only', async () => {
  const prisma = {
    userOrganization: { findFirst: async () => ({ orgId: '22222222-2222-2222-2222-222222222222' }) },
    project: { findMany: async (query) => [{ id: 'project-1', name: 'Launch', status: 'active', query }] },
  };
  const result = await handleAgentScopeCapabilityRoute({
    req: { ...baseReq, method: 'GET' }, res: {}, parseBody: async () => ({}), jsonResponse, prisma,
    pathname: '/internal/hivemind/context/projects',
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.kind, 'projects');
  assert.equal(result.body.records[0].name, 'Launch');
  assert.equal(result.body.records[0].query.where.orgId, '22222222-2222-2222-2222-222222222222');
  assert.equal(Object.hasOwn(result.body.records[0].query.select, 'payload'), false);
});

test('memory saves and web search use canonical Core paths under the resolved principal', async () => {
  const calls = [];
  const prisma = { userOrganization: { findFirst: async () => ({ orgId: '22222222-2222-2222-2222-222222222222' }) } };
  const fetchInternal = async (url, options) => {
    calls.push({ url, options });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const save = await handleAgentScopeCapabilityRoute({
    req: baseReq, res: {}, parseBody: async () => ({ title: 'Decision', content: 'Use the native Task plan.', tags: ['architecture'] }), jsonResponse, prisma, fetchInternal,
    pathname: '/internal/hivemind/memories',
  });
  const search = await handleAgentScopeCapabilityRoute({
    req: baseReq, res: {}, parseBody: async () => ({ query: 'AgentScope release notes', limit: 4 }), jsonResponse, prisma, fetchInternal,
    pathname: '/internal/hivemind/web-search',
  });
  assert.equal(save.statusCode, 200);
  assert.equal(search.statusCode, 200);
  assert.match(calls[0].url, /\/api\/ingest\/source$/);
  assert.equal(calls[0].options.userId, '11111111-1111-1111-1111-111111111111');
  assert.equal(calls[0].options.body.source.type, 'agentscope');
  assert.match(calls[1].url, /\/internal\/hyper\/web-search$/);
  assert.equal(calls[1].options.body.org_id, '22222222-2222-2222-2222-222222222222');
});

test('connected app capabilities issue scoped read grants and cannot execute writes', async () => {
  const calls = [];
  const prisma = { userOrganization: { findFirst: async () => ({ orgId: '22222222-2222-2222-2222-222222222222' }) } };
  const composio = {
    discoverGovernedSessionReads: async (orgId, options) => {
      calls.push({ kind: 'discover', orgId, options });
      return { tools: [{ name: 'GMAIL_FETCH_EMAILS', toolSlug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', sessionId: 'session-1', description: 'Fetch email', inputSchema: { type: 'object' } }] };
    },
    issueGovernedReadGrant: ({ orgId, userId, toolSlug }) => {
      calls.push({ kind: 'issue', orgId, userId, toolSlug });
      return { grantId: 'grant-1', expiresAt: 12345 };
    },
    resolveGovernedReadGrant: ({ grantId, orgId, userId, toolSlug }) => {
      calls.push({ kind: 'resolve', grantId, orgId, userId, toolSlug });
      if (toolSlug.includes('SEND')) throw new Error('governed_session_grant_scope_denied');
      return { sessionId: 'session-1' };
    },
    executeGovernedSessionRead: async (input) => { calls.push({ kind: 'execute', ...input }); return { successful: true, data: ['mail'] }; },
  };
  const tools = await handleAgentScopeCapabilityRoute({
    req: baseReq, res: {}, parseBody: async () => ({ toolkit: 'gmail', use_case: 'Find a customer email' }), jsonResponse, prisma, composio,
    pathname: '/internal/hivemind/composio/tools',
  });
  assert.equal(tools.statusCode, 200);
  assert.equal(tools.body.authority, 'read_only');
  assert.deepEqual(tools.body.tools[0].grant_id, 'grant-1');
  const executed = await handleAgentScopeCapabilityRoute({
    req: baseReq, res: {}, parseBody: async () => ({ tool_slug: 'GMAIL_FETCH_EMAILS', grant_id: 'grant-1', arguments: { query: 'invoice' } }), jsonResponse, prisma, composio,
    pathname: '/internal/hivemind/composio/execute',
  });
  assert.equal(executed.statusCode, 200);
  assert.equal(calls.find((call) => call.kind === 'execute').sessionId, 'session-1');
  const denied = await handleAgentScopeCapabilityRoute({
    req: baseReq, res: {}, parseBody: async () => ({ tool_slug: 'GMAIL_SEND_EMAIL', grant_id: 'grant-1' }), jsonResponse, prisma, composio,
    pathname: '/internal/hivemind/composio/execute',
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.some((call) => call.kind === 'execute' && call.toolSlug === 'GMAIL_SEND_EMAIL'), false);
});

test('external action preparation creates a HIVE approval draft and never invokes a provider', async () => {
  const calls = [];
  const prisma = {
    userOrganization: { findFirst: async () => ({ orgId: '22222222-2222-2222-2222-222222222222' }) },
    $queryRawUnsafe: async (sql, ...args) => {
      calls.push({ sql, args });
      if (sql.includes('SELECT id, room_id, turn_id, status')) return [{ id: '33333333-3333-3333-3333-333333333333', room_id: '44444444-4444-4444-4444-444444444444', turn_id: '55555555-5555-5555-5555-555555555555', status: 'running' }];
      return [{ id: '33333333-3333-3333-3333-333333333333', status: 'running' }];
    },
    pendingWrite: {
      findFirst: async () => null,
      create: async ({ data }) => {
        assert.equal(data.provider, 'composio');
        assert.equal(data.toolGroup, 'composio');
        assert.deepEqual(data.toolArgs, { to: 'ada@example.com', body: 'Hello' });
        return { id: '66666666-6666-6666-6666-666666666666', ...data };
      },
    },
  };
  const result = await handleAgentScopeCapabilityRoute({
    req: baseReq, res: {}, jsonResponse, prisma,
    parseBody: async () => ({ agentscope_session_id: 'session-1', provider: 'composio', tool_name: 'GMAIL_SEND_EMAIL', arguments: { to: 'ada@example.com', body: 'Hello' }, summary: 'Send the reviewed email to Ada.' }),
    pathname: '/internal/hivemind/actions/prepare',
  });
  assert.equal(result.statusCode, 202);
  assert.equal(result.body.status, 'approval_required');
  assert.equal(result.body.executed, false);
  assert.equal(calls.some(({ sql }) => sql.includes('SET events')), true);
});
