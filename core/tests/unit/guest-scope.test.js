import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedMemoryWhere } from '../../src/memory/prisma-graph-store.js';

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

test('guest with no projects sees only personal', () => {
  const w = scopedMemoryWhere({
    user_id: USER, org_id: ORG,
    access_context: { projectIds: [], teamIds: [], orgRole: 'guest' },
  });
  assert.deepEqual(tierScopes(w), ['personal'], 'guest with no project = personal only');
});
