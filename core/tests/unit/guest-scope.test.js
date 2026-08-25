import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaGraphStore, scopedMemoryWhere } from '../../src/memory/prisma-graph-store.js';

const USER = 'u-1', ORG = 'o-1', PROJ = 'p-1';

function tierScopes(where) {
  return (where.OR || []).map(t => t.scope).filter(Boolean);
}

test('member gets the org-wide tier', () => {
  const w = scopedMemoryWhere({
    user_id: USER, org_id: ORG,
    access_context: { projectIds: [PROJ], teamIds: [], orgRole: 'member' },
  });
  assert.ok(tierScopes(w).includes('organization'), 'member must see org tier');
  assert.equal(w.NOT, undefined, 'member has no cross-project exclusion');
});

test('guest is denied the org-wide tier', () => {
  const w = scopedMemoryWhere({
    user_id: USER, org_id: ORG,
    access_context: { projectIds: [PROJ], teamIds: [], orgRole: 'guest' },
  });
  assert.ok(!tierScopes(w).includes('organization'), 'guest must NOT see org tier');
  assert.ok(tierScopes(w).includes('personal'), 'guest still sees personal');
  assert.ok(tierScopes(w).includes('project'), 'guest still sees invited project');
});

test('guest is denied cross-project syntheses (M2b)', () => {
  const w = scopedMemoryWhere({
    user_id: USER, org_id: ORG,
    access_context: { projectIds: [PROJ], teamIds: [], orgRole: 'guest' },
  });
  assert.deepEqual(w.NOT, { tags: { has: 'scope:cross-project' } }, 'guest excludes cross-project tag');
});

test('member with org cross_project OFF: org tier kept, cross-project excluded (M2b)', () => {
  const w = scopedMemoryWhere({
    user_id: USER, org_id: ORG,
    access_context: { projectIds: [PROJ], teamIds: [], orgRole: 'member', crossProject: false },
  });
  assert.ok(tierScopes(w).includes('organization'), 'member still sees org tier');
  assert.deepEqual(w.NOT, { tags: { has: 'scope:cross-project' } }, 'cross-project excluded when org disabled it');
});

test('member with cross_project ON sees cross-project (no NOT filter)', () => {
  const w = scopedMemoryWhere({
    user_id: USER, org_id: ORG,
    access_context: { projectIds: [PROJ], teamIds: [], orgRole: 'member', crossProject: true },
  });
  assert.equal(w.NOT, undefined, 'no cross-project exclusion when enabled');
});

test('owner_only restricts to the caller\'s own rows (KB past-docs)', () => {
  const w = scopedMemoryWhere({
    user_id: USER, org_id: ORG, owner_only: true,
    access_context: { projectIds: [PROJ], teamIds: [], orgRole: 'member' },
  });
  assert.equal(w.userId, USER, 'owner_only pins userId on the base');
  assert.ok((w.OR || []).length > 0, 'still intersects with visible tiers');
});

test('without owner_only the base does not pin userId', () => {
  const w = scopedMemoryWhere({
    user_id: USER, org_id: ORG,
    access_context: { projectIds: [PROJ], teamIds: [], orgRole: 'member' },
  });
  assert.equal(w.userId, undefined, 'no userId pin by default');
});

test('guest with no projects sees only personal', () => {
  const w = scopedMemoryWhere({
    user_id: USER, org_id: ORG,
    access_context: { projectIds: [], teamIds: [], orgRole: 'guest' },
  });
  assert.deepEqual(tierScopes(w), ['personal'], 'guest with no project = personal only');
});

test('missing access context falls back to caller-owned personal rows', () => {
  const w = scopedMemoryWhere({ user_id: USER, org_id: ORG });
  assert.equal(w.userId, USER);
  assert.equal(w.OR, undefined);
});

test('guest cannot widen an explicit organization tier request', () => {
  const w = scopedMemoryWhere({
    user_id: USER, org_id: ORG, scope: 'tier:organization',
    access_context: { projectIds: [PROJ], teamIds: [], orgRole: 'guest' },
  });
  assert.deepEqual(w.id, { in: [] }, 'the tier selector is not an authorization grant');
});

test('central inventory combines access tiers and hidden-tag visibility instead of replacing either OR', async () => {
  let listWhere = null;
  let countWhere = null;
  const store = new PrismaGraphStore({
    memory: {
      async findMany({ where }) { listWhere = where; return []; },
      async count({ where }) { countWhere = where; return 0; },
    },
  });

  await store.listMemories({
    user_id: USER,
    org_id: ORG,
    access_context: { projectIds: [PROJ], teamIds: [], orgRole: 'guest' },
  });

  for (const where of [listWhere, countWhere]) {
    assert.ok(where.OR.some((tier) => tier.scope === 'personal'));
    assert.ok(where.OR.some((tier) => tier.scope === 'project'));
    assert.ok(!where.OR.some((tier) => tier.scope === 'organization'));
    assert.ok(where.AND?.[0]?.OR?.some((condition) => condition.NOT?.tags?.hasSome?.includes('tara-turn')),
      'hidden tag exclusion must narrow, not overwrite, the access tiers');
    assert.equal(Object.hasOwn(where, 'layer'), false, 'Prisma Memory has no layer field');
  }
});
