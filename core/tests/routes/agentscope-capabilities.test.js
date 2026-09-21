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
    sourceArtifact: { upsert: async ({ create }) => ({ id: '66666666-6666-6666-6666-666666666666', checksum: create.checksum, contentType: create.contentType, sizeBytes: create.sizeBytes, createdAt: new Date() }) },
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
