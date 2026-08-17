import test from 'node:test';
import assert from 'node:assert/strict';

import { matchesMemoryAccess } from '../../src/memory/memory-access.js';

const context = { orgRole: 'member', projectIds: ['project-a'], teamIds: ['team-a'], crossProject: true };

test('personal memories require exact ownership in every field shape', () => {
  assert.equal(matchesMemoryAccess(
    { scope: 'personal', user_id: 'owner', org_id: 'org' },
    { userId: 'owner', orgId: 'org', accessContext: context },
  ), true);
  assert.equal(matchesMemoryAccess(
    { scope: 'personal', userId: 'owner', orgId: 'org' },
    { userId: 'outsider', orgId: 'org', accessContext: context },
  ), false);
});

test('organization, team, and project tiers require their respective grants', () => {
  assert.equal(matchesMemoryAccess(
    { scope: 'organization', org_id: 'org' },
    { userId: 'member', orgId: 'org', accessContext: context },
  ), true);
  assert.equal(matchesMemoryAccess(
    { scope: 'team', primary_team_id: 'team-a' },
    { userId: 'member', orgId: 'org', accessContext: context },
  ), true);
  assert.equal(matchesMemoryAccess(
    { scope: 'team', primary_team_id: 'team-b' },
    { userId: 'member', orgId: 'org', accessContext: context },
  ), false);
  assert.equal(matchesMemoryAccess(
    { scope: 'project', project_ids: ['project-a'] },
    { userId: 'member', orgId: 'org', accessContext: context },
  ), true);
  assert.equal(matchesMemoryAccess(
    { scope: 'project', project_id: 'project-b' },
    { userId: 'member', orgId: 'org', accessContext: context },
  ), false);
});

test('guest and disabled cross-project contexts reject cross-project synthesis', () => {
  const memory = { scope: 'organization', org_id: 'org', tags: ['scope:cross-project'] };
  assert.equal(matchesMemoryAccess(memory, {
    userId: 'guest', orgId: 'org', accessContext: { ...context, orgRole: 'guest' },
  }), false);
  assert.equal(matchesMemoryAccess(memory, {
    userId: 'member', orgId: 'org', accessContext: { ...context, crossProject: false },
  }), false);
});
