import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildFtsScopeWhere } from '../../src/memory/fts-scope-where.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const BASE = () => ['tsquery', 10];

// Evaluates the predicate against plain rows so the two-member case is checked
// as behaviour, not only as SQL text. Supports exactly the fragments the
// non-access-context branches emit.
function rowMatches(sql, params, row) {
  const p = (n) => params[n - 1];
  const orgMatch = /m\.org_id = \$(\d+)::uuid/.exec(sql);
  if (orgMatch && row.org_id !== p(Number(orgMatch[1]))) return false;
  const personalOnly = /^AND m\.user_id = \$(\d+)::uuid/.exec(sql);
  if (personalOnly) return row.user_id === p(Number(personalOnly[1]));
  const tier = /\(m\.scope <> 'personal' OR m\.user_id = \$(\d+)::uuid\)/.exec(sql);
  if (tier) return row.scope !== 'personal' || (p(Number(tier[1])) !== null && row.user_id === p(Number(tier[1])));
  return true;
}

test('non-personal keyword fallback keeps other members\' personal memories private (audit 08 F2)', () => {
  const params = BASE();
  const sql = buildFtsScopeWhere({ user_id: USER, org_id: ORG, scope: 'organization' }, params);
  assert.equal(sql, "AND m.org_id = $3::uuid AND (m.scope <> 'personal' OR m.user_id = $4::uuid)");
  assert.deepEqual(params, ['tsquery', 10, ORG, USER]);

  const other = '33333333-3333-4333-8333-333333333333';
  const rows = [
    { id: 'mine-personal', org_id: ORG, user_id: USER, scope: 'personal' },
    { id: 'other-personal', org_id: ORG, user_id: other, scope: 'personal' },
    { id: 'other-org', org_id: ORG, user_id: other, scope: 'organization' },
    { id: 'foreign-org', org_id: '44444444-4444-4444-8444-444444444444', user_id: USER, scope: 'organization' },
  ];
  assert.deepEqual(rows.filter((r) => rowMatches(sql, params, r)).map((r) => r.id), ['mine-personal', 'other-org']);
});

test('non-personal fallback without a user id matches no personal row', () => {
  const params = BASE();
  const sql = buildFtsScopeWhere({ user_id: undefined, org_id: ORG, scope: 'all' }, params);
  assert.deepEqual(params, ['tsquery', 10, ORG, null]);
  assert.equal(rowMatches(sql, params, { org_id: ORG, user_id: USER, scope: 'personal' }), false);
  assert.equal(rowMatches(sql, params, { org_id: ORG, user_id: USER, scope: 'organization' }), true);
});

test('personal scope predicate is unchanged', () => {
  const params = BASE();
  const sql = buildFtsScopeWhere({ user_id: USER, org_id: ORG, scope: 'personal' }, params);
  assert.equal(sql, 'AND m.user_id = $3::uuid AND m.org_id = $4::uuid');
  assert.deepEqual(params, ['tsquery', 10, USER, ORG]);
});

test('access-context tier predicate is unchanged', () => {
  const params = BASE();
  const sql = buildFtsScopeWhere({
    user_id: USER,
    org_id: ORG,
    access_context: { projectIds: ['p1'], teamIds: ['t1'], orgRole: 'member' },
  }, params);
  assert.equal(
    sql,
    "AND m.org_id = $7::uuid AND ((m.user_id = $3::uuid AND m.scope = 'personal') OR (m.scope = 'organization' AND m.org_id = $4::uuid) OR (m.scope = 'project' AND EXISTS (SELECT 1 FROM memory_projects mp WHERE mp.memory_id = m.id AND mp.project_id IN ($5::uuid))) OR (m.scope = 'team' AND m.primary_team_id IN ($6::uuid)))",
  );
  assert.deepEqual(params, ['tsquery', 10, USER, ORG, 'p1', 't1', ORG]);
});

test('guest access context drops the org tier and cross-project syntheses', () => {
  const params = BASE();
  const sql = buildFtsScopeWhere({
    user_id: USER, org_id: ORG, access_context: { projectIds: [], orgRole: 'guest' },
  }, params);
  assert.equal(sql, "AND m.org_id = $4::uuid AND ((m.user_id = $3::uuid AND m.scope = 'personal')) AND NOT ($5 = ANY(m.tags))");
  assert.deepEqual(params, ['tsquery', 10, USER, ORG, 'scope:cross-project']);
});

test('PrismaGraphStore keyword search uses the shared predicate', () => {
  const store = readFileSync(new URL('../../src/memory/prisma-graph-store.js', import.meta.url), 'utf8');
  assert.match(store, /buildFtsScopeWhere\(\{ user_id, org_id, scope, access_context \}, ftsParams\)/);
  assert.doesNotMatch(store, /scopeWhere = `AND m\.org_id = \$\{orgParam\}::uuid`;/);
});
