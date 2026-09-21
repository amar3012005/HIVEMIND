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
