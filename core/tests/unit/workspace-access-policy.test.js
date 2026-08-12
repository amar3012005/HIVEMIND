import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveOrganizationMembership,
  isOrganizationAdmin,
  requireSameOrganizationMember,
} from '../../src/workspace/access-policy.js';

function prismaFor(membership, capture = null) {
  return {
    userOrganization: {
      findUnique: async (query) => {
        if (capture) capture.query = query;
        return membership;
      },
    },
  };
}

test('only active organization memberships satisfy workspace access', async () => {
  assert.equal(await getActiveOrganizationMembership(prismaFor({ isActive: false }), { orgId: 'org', userId: 'user' }), null);
  assert.deepEqual(await getActiveOrganizationMembership(prismaFor({ isActive: true, role: 'member', roles: [] }), { orgId: 'org', userId: 'user' }), { isActive: true, role: 'member', roles: [] });
});

test('workspace access resolves the canonical organization with the active membership', async () => {
  const capture = {};
  const membership = { isActive: true, role: 'owner', roles: ['org_owner'], org: { id: 'org', slug: 'workspace' } };
  const result = await getActiveOrganizationMembership(prismaFor(membership, capture), { orgId: 'org', userId: 'user' });
  assert.equal(result.org.slug, 'workspace');
  assert.deepEqual(capture.query.include, { org: true });
});

test('canonical organization admin roles are accepted', () => {
  assert.equal(isOrganizationAdmin({ role: 'member', roles: ['org_admin'] }), true);
  assert.equal(isOrganizationAdmin({ role: 'member', roles: [] }), false);
});

test('same-organization assignment fails closed', async () => {
  await assert.rejects(
    () => requireSameOrganizationMember(prismaFor(null), { orgId: 'org-a', userId: 'user-b' }),
    (error) => error.status === 404,
  );
});
