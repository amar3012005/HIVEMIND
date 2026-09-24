import test from 'node:test';
import assert from 'node:assert/strict';
import { findEntities, normalizeEntityScope, rankEntityMatches, resolveAuthorizedEntityIds } from '../../src/memory/entity-discovery.js';

const ENTITIES = [
  { id: '2', canonicalName: 'Uwe Berger', entityType: 'person', aliases: ['Uwe'], mentionCount: 4, lastSeenAt: '2026-09-10T00:00:00Z' },
  { id: '1', canonicalName: 'Uwe Bross', entityType: 'person', aliases: [], mentionCount: 10, lastSeenAt: '2026-09-11T00:00:00Z' },
  { id: '3', canonicalName: 'Uwe GmbH', entityType: 'organization', aliases: [], mentionCount: 12, lastSeenAt: '2026-09-12T00:00:00Z' },
];

test('entity finder returns deterministic prefix matches without a vector query', () => {
  const matches = rankEntityMatches(ENTITIES, 'Uwe', 12);
  assert.deepEqual(matches.map((match) => match.canonical_name), ['Uwe Berger', 'Uwe GmbH', 'Uwe Bross']);
  assert.ok(matches.every((match) => match.match === 'canonical_prefix' || match.match === 'alias_exact'));
});

test('entity finder gives exact aliases priority over prefix matches', () => {
  const matches = rankEntityMatches(ENTITIES, 'Uwe', 12);
  assert.equal(matches.find((match) => match.canonical_name === 'Uwe Berger').match, 'alias_exact');
  assert.equal(matches[0].canonical_name, 'Uwe Berger');
});

test('entity finder caps output and exposes only safe discovery fields', () => {
  const match = rankEntityMatches(ENTITIES, 'Bross', 1)[0];
  assert.deepEqual(Object.keys(match).sort(), ['aliases', 'canonical_name', 'entity_id', 'entity_ids', 'entity_type', 'last_seen_at', 'match', 'mention_count']);
  assert.deepEqual(match.entity_ids, ['1']);
});

test('entity finder tolerates bounded spelling mistakes', () => {
  const matches = rankEntityMatches(ENTITIES, 'Bergr', 12);
  assert.equal(matches[0].canonical_name, 'Uwe Berger');
  assert.equal(matches[0].match, 'fuzzy');
});

test('entity finder merges canonical, legacy and tag identities by normalized name', async () => {
  const prisma = {
    entity: { findMany: async () => [{
      id: 'legacy-solvispia', canonicalName: 'SolvisPia', entityType: 'product',
      aliases: ['Pia'], mentionCount: 2, lastSeenAt: '2026-09-10T00:00:00Z',
    }] },
    canonicalEntity: { findMany: async () => [{
      id: 'canonical-solvispia', canonicalName: 'SolvisPia', entityKind: 'product',
      aliases: ['Solvis Pia'], updatedAt: '2026-09-12T00:00:00Z',
    }] },
    memoryEntityLink: { findMany: async () => [{ entityId: 'canonical-solvispia', memoryId: 'memory-1' }] },
    memory: { findMany: async () => [] },
  };
  const memoryStore = {
    listMemories: async () => ({ memories: [{
      id: 'memory-1', scope: 'organization', created_at: '2026-09-12T00:00:00Z', tags: ['entity:solvispia'],
    }] }),
  };
  const result = await findEntities({
    prisma, memoryStore, orgId: 'org', userId: 'user', query: 'SolvisPia', accessContext: { orgRole: 'owner' },
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].entity_id, 'canonical-solvispia');
  assert.deepEqual(result.matches[0].aliases.sort(), ['Pia', 'Solvis Pia']);
});

test('duplicate canonical IDs remain one chooser identity with all verified IDs', async () => {
  const canonicalRows = [
    { id: 'rama-a', canonicalName: 'Rama Santhoshi', normalizedName: 'rama santhoshi', entityKind: 'person', aliases: ['Rama'], primaryEmail: 'rama@example.test', updatedAt: '2026-09-12T00:00:00Z' },
    { id: 'rama-b', canonicalName: 'Rama Santhoshi', normalizedName: 'rama santhoshi', entityKind: 'person', aliases: ['Rama'], primaryEmail: 'rama@example.test', updatedAt: '2026-09-11T00:00:00Z' },
  ];
  const prisma = {
    entity: { findMany: async () => [] },
    canonicalEntity: { findMany: async ({ where }) => {
      assert.equal(where.organizationId, 'org-a');
      return canonicalRows.filter((row) => !where.id || where.id.in.includes(row.id));
    } },
    memoryEntityLink: { findMany: async ({ where }) => canonicalRows
      .filter((row) => !where.entityId?.in || where.entityId.in.includes(row.id))
      .map((row) => ({ entityId: row.id, memoryId: `memory-${row.id}` })) },
    memory: { findMany: async () => [] },
  };
  const memoryStore = {
    listMemories: async () => ({ memories: canonicalRows.map((row) => ({
      id: `memory-${row.id}`, scope: 'organization', org_id: 'org-a', created_at: row.updatedAt,
    })) }),
  };
  const found = await findEntities({ prisma, memoryStore, orgId: 'org-a', userId: 'user-a', query: 'Rama Santhoshi', accessContext: { orgRole: 'owner' } });
  assert.equal(found.matches.length, 1);
  assert.deepEqual(found.matches[0].entity_ids.sort(), ['rama-a', 'rama-b']);
  assert.ok(found.matches[0].aliases.includes('Rama'));

  const selected = await resolveAuthorizedEntityIds({
    prisma, memoryStore, orgId: 'org-a', userId: 'user-a', entityIds: ['rama-a'], accessContext: { orgRole: 'owner' },
  });
  assert.equal(selected.entities.length, 1);
  assert.deepEqual(selected.entities[0].entityIds.sort(), ['rama-a', 'rama-b']);
  assert.deepEqual(selected.entities[0].canonicalEntityIds.sort(), ['rama-a', 'rama-b']);
});

test('different names are linked only by exact verified primary email, never substring', async () => {
  const canonicalRows = [
    { id: 'rama-short', canonicalName: 'Rama', normalizedName: 'rama', entityKind: 'person', aliases: [], primaryEmail: 'rama@example.test', updatedAt: '2026-09-12T00:00:00Z' },
    { id: 'rama-full', canonicalName: 'Rama Santhoshi', normalizedName: 'rama santhoshi', entityKind: 'person', aliases: ['Chennarapu Ramasantoshi'], primaryEmail: 'rama@example.test', updatedAt: '2026-09-11T00:00:00Z' },
    { id: 'other-rama', canonicalName: 'Rama Sharma', normalizedName: 'rama sharma', entityKind: 'person', aliases: [], primaryEmail: 'other@example.test', updatedAt: '2026-09-10T00:00:00Z' },
  ];
  const prisma = {
    entity: { findMany: async () => [] },
    canonicalEntity: { findMany: async ({ where }) => canonicalRows.filter((row) => {
      if (where.id) return where.id.in.includes(row.id);
      if (where.OR) return where.OR.some((filter) => filter.primaryEmail
        ? row.primaryEmail === filter.primaryEmail
        : row.canonicalName.toLocaleLowerCase() === filter.canonicalName.equals.toLocaleLowerCase());
      return true;
    }) },
    memoryEntityLink: { findMany: async ({ where }) => canonicalRows
      .filter((row) => where.entityId.in.includes(row.id))
      .map((row) => ({ entityId: row.id, memoryId: `memory-${row.id}` })) },
    memory: { findMany: async () => [] },
  };
  const memoryStore = { listMemories: async () => ({ memories: canonicalRows.map((row) => ({
    id: `memory-${row.id}`, org_id: 'org-a', scope: 'organization', created_at: row.updatedAt,
  })) }) };
  const selected = await resolveAuthorizedEntityIds({
    prisma, memoryStore, orgId: 'org-a', userId: 'user-a', entityIds: ['rama-short'], accessContext: { orgRole: 'owner' },
  });
  assert.equal(selected.entities.length, 1);
  assert.deepEqual(selected.entities[0].entityIds.sort(), ['rama-full', 'rama-short']);
  assert.ok(selected.entities[0].aliases.includes('Chennarapu Ramasantoshi'));
});

test('indexed tenant entity lookup accepts exact primary-email aliases and returns authorized canonical ID', async () => {
  const calls = [];
  const prisma = {
    $queryRawUnsafe: async (sql, ...params) => {
      calls.push({ sql, params });
      return [{
        id: 'rama-email-id', canonicalName: 'Rama Santhoshi', entityType: 'person',
        aliases: ['Rama'], primaryEmail: 'rama@example.test', mentionCount: 2,
        lastSeenAt: '2026-09-12T00:00:00Z',
      }];
    },
    entity: { findMany: async () => [] },
    canonicalEntity: { findMany: async () => [] },
    memoryEntityLink: { findMany: async () => [] },
    memory: { findMany: async () => [] },
  };
  const result = await findEntities({
    prisma,
    memoryStore: { listMemories: async () => ({ memories: [] }) },
    orgId: 'org-a', userId: 'user-a', query: 'rama@example.test',
    accessContext: { orgRole: 'owner' }, recallQualityMode: 'on',
  });
  assert.equal(result.matches[0].entity_id, 'rama-email-id');
  assert.ok(result.matches[0].aliases.includes('rama@example.test'));
  assert.match(calls[0].sql, /lower\(trim\(entity\.primary_email\)\)/);
  assert.deepEqual(calls[0].params.slice(0, 2), ['org-a', 'user-a']);
  assert.equal(calls[0].params[12], 'rama@example.test');
});

test('entity finder includes active workspace members as person identities', async () => {
  const prisma = {
    entity: { findMany: async () => [] },
    canonicalEntity: { findMany: async () => [] },
    memoryEntityLink: { findMany: async () => [] },
    memory: { findMany: async () => [] },
    userOrganization: { findMany: async () => [{
      userId: 'amar-id', role: 'owner', joinedAt: '2026-09-01T00:00:00Z',
      user: { displayName: 'Amar', email: 'amar@example.com', updatedAt: '2026-09-12T00:00:00Z' },
    }] },
  };
  const memoryStore = { listMemories: async () => ({ memories: [] }) };
  const result = await findEntities({ prisma, memoryStore, orgId: 'org', userId: 'amar-id', query: 'AMAR' });
  assert.equal(result.matches[0].entity_id, 'member:amar-id');
  assert.equal(result.matches[0].canonical_name, 'Amar');
  assert.equal(result.matches[0].entity_type, 'person');
});

test('agent-backed memories expose only authorized entity tags and revalidate issued tag ids', async () => {
  const prisma = {
    entity: { findMany: async () => [] },
    canonicalEntity: { findMany: async () => [] },
    memoryEntityLink: { findMany: async () => [] },
    memory: { findMany: async () => [] },
  };
  const memoryStore = {
    listMemories: async () => ({ memories: [
      { id: 'allowed', created_at: '2026-09-12T00:00:00Z', tags: ['entity:uwe-berger'] },
      { id: 'other', created_at: '2026-09-11T00:00:00Z', tags: ['entity:uwe-bross'] },
    ] }),
  };
  const scope = { prisma, memoryStore, orgId: 'org', userId: 'user', accessContext: {} };
  const found = await findEntities({ ...scope, query: 'Uwe' });
  assert.deepEqual(found.matches.map((match) => match.entity_id), ['tag:uwe-berger', 'tag:uwe-bross']);

  const selected = await resolveAuthorizedEntityIds({ ...scope, entityIds: ['tag:uwe-berger'] });
  assert.deepEqual(selected.entities, [{ id: 'tag:uwe-berger', entityIds: ['tag:uwe-berger'], canonicalEntityIds: [], canonicalName: 'Uwe Berger', aliases: [], primaryEmail: null }]);
});

test('canonical entity resolution never expands an explicit selection to all tenant tags', async () => {
  const prisma = {
    entity: { findMany: async () => [{
      id: 'canonical-uwe', canonicalName: 'Uwe Berger', entityType: 'person',
      aliases: [], mentionCount: 1, lastSeenAt: '2026-09-12T00:00:00Z',
    }] },
    canonicalEntity: { findMany: async () => [] },
    memoryEntityLink: { findMany: async () => [] },
    memory: { findMany: async () => [] },
  };
  const memoryStore = {
    listMemories: async () => ({ memories: [
      { id: 'uwe', created_at: '2026-09-12T00:00:00Z', tags: ['entity:uwe-berger'] },
      { id: 'other', created_at: '2026-09-11T00:00:00Z', tags: ['entity:uwe-bross'] },
    ] }),
  };
  const selected = await resolveAuthorizedEntityIds({
    prisma, memoryStore, orgId: 'org', userId: 'user', entityIds: ['canonical-uwe'], accessContext: {},
  });
  assert.deepEqual(selected.entities, [{ id: 'canonical-uwe', entityIds: ['canonical-uwe'], canonicalEntityIds: [], canonicalName: 'Uwe Berger', aliases: [], primaryEmail: null }]);
});

test('entity finder keeps omitted scope global and passes an explicit scope as a hard inventory boundary', async () => {
  const calls = [];
  const prisma = {
    entity: { findMany: async () => [] },
    canonicalEntity: { findMany: async () => [] },
    memoryEntityLink: { findMany: async () => [] },
    memory: { findMany: async () => [] },
  };
  const memoryStore = {
    listMemories: async (args) => {
      calls.push(args.scope);
      return { memories: [
        { id: 'personal', user_id: 'user', scope: 'personal', created_at: '2026-09-12T00:00:00Z', tags: ['entity:uwe-berger'] },
        { id: 'org', scope: 'organization', created_at: '2026-09-11T00:00:00Z', tags: ['entity:uwe-bross'] },
      ] };
    },
  };
  const input = { prisma, memoryStore, orgId: 'org', userId: 'user', accessContext: {}, query: 'Uwe' };
  const global = await findEntities(input);
  const personal = await findEntities({ ...input, scope: 'personal' });

  assert.deepEqual(global.matches.map((match) => match.entity_id), ['tag:uwe-berger', 'tag:uwe-bross']);
  assert.deepEqual(personal.matches.map((match) => match.entity_id), ['tag:uwe-berger']);
  assert.ok(calls.includes('all'));
  assert.ok(calls.includes('tier:personal'));
});

test('entity finder fails closed for an invalid supplied scope', async () => {
  assert.deepEqual(normalizeEntityScope(), { scopeFilter: null, error: null });
  assert.deepEqual(normalizeEntityScope('team'), { scopeFilter: 'team', error: null });
  const result = await findEntities({ prisma: {}, orgId: 'org', userId: 'user', query: 'Uwe', scope: 'all' });
  assert.equal(result.error, 'invalid_scope');
  assert.deepEqual(result.matches, []);
});

test('entity finder keeps tag-backed discovery available when an optional registry is unavailable', async () => {
  const prisma = {
    entity: { findMany: async () => { throw new Error('legacy_registry_unavailable'); } },
    canonicalEntity: { findMany: async () => { throw new Error('canonical_registry_unavailable'); } },
    memoryEntityLink: { findMany: async () => [] },
    memory: { findMany: async () => [] },
    userOrganization: { findMany: async () => [] },
  };
  const memoryStore = {
    listMemories: async () => ({ memories: [
      { id: 'm1', scope: 'organization', created_at: '2026-09-21T00:00:00Z', tags: ['entity:singulance'] },
    ] }),
  };
  const result = await findEntities({ prisma, memoryStore, orgId: 'org', userId: 'user', query: 'Singulance', accessContext: { orgRole: 'owner' } });
  assert.equal(result.degraded, null);
  assert.deepEqual(result.matches.map(match => match.entity_id), ['tag:singulance']);
});
