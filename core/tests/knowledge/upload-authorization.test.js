import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeKnowledgeScope } from '../../src/knowledge/upload-authorization.js';

const member = { role: 'member', roles: [] };
function prisma({ membership = member, team = null, projects = [] } = {}) {
  return {
    userOrganization: { findFirst: async () => membership },
    team: { findFirst: async () => team },
    project: { findMany: async () => projects },
  };
}

test('requires active organization membership without leaking existence', async () => {
  const result = await authorizeKnowledgeScope({ prisma: prisma({ membership: null }), userId: 'u', orgId: 'o', targetScope: 'personal' });
  assert.deepEqual(result, { ok: false, status: 404, code: 'scope_not_found' });
});

test('member cannot create organization-wide upload', async () => {
  const result = await authorizeKnowledgeScope({ prisma: prisma(), userId: 'u', orgId: 'o', targetScope: 'organization' });
  assert.equal(result.status, 403);
});

test('guessed team and project ids fail with indistinguishable 404', async () => {
  const team = await authorizeKnowledgeScope({ prisma: prisma(), userId: 'u', orgId: 'o', targetScope: 'team', primaryTeamId: 'other' });
  const project = await authorizeKnowledgeScope({ prisma: prisma(), userId: 'u', orgId: 'o', targetScope: 'project', projectIds: ['other'] });
  assert.equal(team.status, 404);
  assert.equal(project.status, 404);
});

test('admin may use an organization scope', async () => {
  const result = await authorizeKnowledgeScope({ prisma: prisma({ membership: { role: 'admin', roles: [] } }), userId: 'u', orgId: 'o', targetScope: 'organization' });
  assert.equal(result.ok, true);
  assert.equal(result.scopeKey, 'organization:o');
});
