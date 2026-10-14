import test from 'node:test';
import assert from 'node:assert/strict';
import { TeamStore } from '../../src/teams/team-store.js';

test('personal or incomplete principals cannot query organization memberships', async () => {
  const store = new TeamStore(new Proxy({}, { get() { throw new Error('database must not be queried'); } }));
  for (const input of [{ userId: 'user', orgId: null }, { userId: 'user' }, { orgId: 'org' }]) {
    assert.deepEqual(await store.accessibleTeamIds(input), []);
    assert.deepEqual(await store.accessibleProjectIds(input), []);
  }
});
test('organization team lookup retains both tenant and user filters', async () => {
  let query;
  const store = new TeamStore({ teamMember: { findMany: async args => { query = args; return [{ teamId: 'team' }]; } } });
  assert.deepEqual(await store.accessibleTeamIds({ userId: 'user', orgId: 'org' }), ['team']);
  assert.deepEqual(query.where, { userId: 'user', team: { orgId: 'org', archivedAt: null } });
});
