import test from 'node:test';
import assert from 'node:assert/strict';
import { findEntities, rankEntityMatches, resolveAuthorizedEntityIds } from '../../src/memory/entity-discovery.js';

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
  assert.deepEqual(Object.keys(match).sort(), ['aliases', 'canonical_name', 'entity_id', 'entity_type', 'last_seen_at', 'match', 'mention_count']);
});

test('indexed resource links bound entity discovery and stable-id revalidation to authorized scope', async () => {
  const calls = [];
  const rows = [
    { id: 'uwe-berger', canonicalName: 'Uwe Berger', entityKind: 'person', aliases: ['Uwe'],
      searchTerms: ['uwe', 'berger'], updatedAt: '2026-09-12T00:00:00Z',
      resourceLinks: [{ knownAt: '2026-09-12T00:00:00Z' }] },
    { id: 'uwe-bross', canonicalName: 'Uwe Bross', entityKind: 'person', aliases: [],
      searchTerms: ['uwe', 'bross'], updatedAt: '2026-09-11T00:00:00Z',
      resourceLinks: [{ knownAt: '2026-09-11T00:00:00Z' }] },
  ];
  const prisma = {
    resourceEntityLink: {},
    canonicalEntity: {
      findMany: async (args) => {
        calls.push(args);
        const ids = args.where.id?.in;
        return ids ? rows.filter((row) => ids.includes(row.id)) : rows;
      },
    },
  };
  const scope = { prisma, orgId: 'org', userId: 'user', accessContext: { projectIds: ['project-1'] } };
  const found = await findEntities({ ...scope, query: 'Uwe', scope: { type: 'project', id: 'project-1' } });
  assert.deepEqual(found.matches.map((match) => match.entity_id), ['uwe-berger', 'uwe-bross']);
  assert.equal(calls[0].take, 48, 'bounded indexed candidate query, never a memory scan');
  assert.deepEqual(calls[0].where.resourceLinks.some,
    { organizationId: 'org', scopeType: 'project', scopeId: 'project-1' });

  const selected = await resolveAuthorizedEntityIds({ ...scope, entityIds: ['uwe-berger'] });
  assert.deepEqual(selected.entities, [{ id: 'uwe-berger', canonicalName: 'Uwe Berger' }]);
});
