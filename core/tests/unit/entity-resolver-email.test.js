import test from 'node:test';
import assert from 'node:assert/strict';
import { EntityResolver } from '../../src/memory/entity-resolver.js';

test('email lookup is normalized, organization-scoped, and deterministic across duplicates', async () => {
  let query;
  const prisma = {
    canonicalEntity: {
      findFirst: async (args) => { query = args; return { id: 'oldest-rama' }; },
    },
  };
  const resolver = new EntityResolver({ prisma });

  const found = await resolver.findByEmail({ organizationId: 'org-a', email: '  Rama@Example.Test  ' });

  assert.equal(found.id, 'oldest-rama');
  assert.deepEqual(query, {
    where: { organizationId: 'org-a', primaryEmail: 'rama@example.test' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
});

test('entity enrichment keeps source name and normalized email searchable as aliases', async () => {
  const updates = [];
  const prisma = {
    canonicalEntity: {
      findUnique: async () => ({
        id: 'rama-canonical', aliases: ['Rama'], emailDomains: [],
        externalRefs: {}, primaryEmail: null,
      }),
      update: async (args) => { updates.push(args); return args; },
    },
  };
  const resolver = new EntityResolver({ prisma });

  await resolver._enrichEntity('rama-canonical', {
    name: 'Rama Santhoshi', email: ' Rama@Example.Test ', domain: 'example.test', externalRefs: {},
  });

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].data.aliases, ['Rama', 'Rama Santhoshi', 'rama@example.test']);
  assert.equal(updates[0].data.primaryEmail, 'rama@example.test');
  assert.deepEqual(updates[0].data.emailDomains, ['example.test']);
});

test('an email lookup never broadens beyond the authenticated organization', async () => {
  const calls = [];
  const resolver = new EntityResolver({ prisma: {
    canonicalEntity: { findFirst: async (args) => { calls.push(args); return null; } },
  } });

  await resolver.findByEmail({ organizationId: 'org-a', email: 'person@example.test' });
  assert.equal(calls[0].where.organizationId, 'org-a');
  assert.equal(calls[0].where.primaryEmail, 'person@example.test');
});
