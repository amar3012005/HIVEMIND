import test from 'node:test';
import assert from 'node:assert/strict';
import { hashApiKey } from '../../src/auth/api-keys.js';
import { authorizeOpenDotRecoveryRequest, OPEN_DOT_RECOVERY_SCOPE } from '../../src/auth/open-dot-recovery.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const foreignOrgId = '33333333-3333-4333-8333-333333333333';
const foreignUserId = '44444444-4444-4444-8444-444444444444';
const rawKey = 'hmk_live_open_dot_recovery_test_key';

function harness({ record: recordOverrides = {}, membership = { isActive: true, role: 'member' } } = {}) {
  const record = {
    id: 'recovery-service-key', userId, orgId, keyKind: 'service',
    scopes: [OPEN_DOT_RECOVERY_SCOPE], projectId: null, teamId: null,
    revokedAt: null, expiresAt: null,
    ...recordOverrides,
  };
  const lookups = [];
  const prisma = {
    apiKey: {
      findUnique: async ({ where }) => where.keyHash === hashApiKey(rawKey) ? record : null,
      update: async () => ({}),
    },
    userOrganization: {
      findUnique: async ({ where }) => {
        lookups.push(where.userId_orgId);
        return where.userId_orgId.userId === userId && where.userId_orgId.orgId === orgId ? membership : null;
      },
    },
  };
  return { prisma, record, lookups };
}

test('returns only the active canonical identity from a scoped persisted service key', async () => {
  const h = harness();
  const result = await authorizeOpenDotRecoveryRequest({
    prisma: h.prisma,
    authorization: `Bearer ${rawKey}`,
    // These attacker-controlled fields are deliberately not accepted as input.
    org_id: foreignOrgId,
    user_id: foreignUserId,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.principal, { orgId, userId });
  assert.deepEqual(h.lookups, [{ userId, orgId }]);
});

test('requires an organization-bound service key with the exact recovery scope', async () => {
  for (const record of [
    { keyKind: 'personal' },
    { scopes: ['mcp'] },
    { scopes: ['*'] },
    { scopes: ['*', OPEN_DOT_RECOVERY_SCOPE] },
    { projectId: 'project-1' },
    { teamId: 'team-1' },
    { orgId: null },
  ]) {
    const h = harness({ record });
    const result = await authorizeOpenDotRecoveryRequest({ prisma: h.prisma, authorization: `Bearer ${rawKey}` });
    assert.equal(result.status, 403);
    assert.equal(h.lookups.length, 0);
  }
});

test('rejects a principal resolver result that does not match the persisted key owner', async () => {
  const h = harness();
  const result = await authorizeOpenDotRecoveryRequest({
    prisma: h.prisma,
    authorization: `Bearer ${rawKey}`,
    resolveAccess: async () => ({ orgId: foreignOrgId, userId: foreignUserId, isServiceKey: true }),
  });
  assert.equal(result.status, 403);
  assert.equal(h.lookups.length, 0);
});

test('rejects revoked and expired persisted service keys', async () => {
  for (const record of [
    { revokedAt: new Date() },
    { expiresAt: new Date(Date.now() - 1000) },
  ]) {
    const h = harness({ record });
    const result = await authorizeOpenDotRecoveryRequest({ prisma: h.prisma, authorization: `Bearer ${rawKey}` });
    assert.equal(result.status, 401);
    assert.equal(h.lookups.length, 0);
  }
});

test('requires current active membership without imposing an admin role', async () => {
  for (const membership of [null, { isActive: false, role: 'owner' }]) {
    const h = harness({ membership });
    const result = await authorizeOpenDotRecoveryRequest({ prisma: h.prisma, authorization: `Bearer ${rawKey}` });
    assert.equal(result.status, 403);
  }
  const activeMember = harness({ membership: { isActive: true, role: 'member' } });
  assert.equal((await authorizeOpenDotRecoveryRequest({
    prisma: activeMember.prisma,
    authorization: `Bearer ${rawKey}`,
  })).status, 200);
});

test('rejects absent credentials and unavailable database', async () => {
  assert.equal((await authorizeOpenDotRecoveryRequest({ prisma: {}, authorization: '' })).status, 401);
  assert.equal((await authorizeOpenDotRecoveryRequest({ prisma: null, authorization: `Bearer ${rawKey}` })).status, 503);
});
