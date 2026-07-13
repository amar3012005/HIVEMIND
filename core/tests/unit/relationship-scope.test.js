import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';

function memory(id, { org = 'org-1', user = 'user-1', scope = 'organization', projects = [], team = null } = {}) {
  return {
    id,
    org_id: org,
    user_id: user,
    scope,
    project_id: projects[0] || null,
    project_ids: projects,
    primary_team_id: team,
  };
}

function storeWith(from, to) {
  const writes = [];
  const store = new PrismaGraphStore({
    relationship: {
      upsert: async ({ create }) => {
        writes.push(create);
        return create;
      },
    },
  });
  store.getMemories = async () => new Map([[from.id, from], [to.id, to]]);
  return { store, writes };
}

test('relationship storage rejects cross-tenant endpoints before writing', async () => {
  const { store, writes } = storeWith(memory('a'), memory('b', { org: 'org-2' }));
  await assert.rejects(() => store.createRelationship({
    id: 'edge', from_id: 'a', to_id: 'b', type: 'Mentions', org_id: 'org-1',
  }), /Tenant scope violation/);
  assert.equal(writes.length, 0);
});

test('relationship storage rejects project edges without shared project access', async () => {
  const { store, writes } = storeWith(
    memory('a', { scope: 'project', projects: ['project-a'] }),
    memory('b', { scope: 'project', projects: ['project-b'] }),
  );
  await assert.rejects(() => store.createRelationship({
    id: 'edge', from_id: 'a', to_id: 'b', type: 'Extends', org_id: 'org-1',
  }), /Project scope violation/);
  assert.equal(writes.length, 0);
});

test('relationship storage accepts same-tenant endpoints with a shared project', async () => {
  const { store, writes } = storeWith(
    memory('a', { scope: 'project', projects: ['project-a'] }),
    memory('b', { scope: 'project', projects: ['project-a'] }),
  );
  await store.createRelationship({
    id: 'edge', from_id: 'a', to_id: 'b', type: 'Extends', org_id: 'org-1', confidence: 0.9,
  });
  assert.equal(writes.length, 1);
});
