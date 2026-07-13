import test from 'node:test';
import assert from 'node:assert/strict';
import { EntityResolver, normalizeEntityName, verifiedIdentityKey } from '../../src/memory/entity-resolver.js';

test('entity identity normalization is Unicode-stable without language-specific suffix rules', () => {
  assert.equal(normalizeEntityName('  ＡＣＭＥ GmbH  '), 'acme gmbh');
  assert.equal(normalizeEntityName('東京  研究所'), '東京 研究所');
  assert.equal(verifiedIdentityKey({ email: ' User@Example.COM ' }), 'email:user@example.com');
  assert.equal(verifiedIdentityKey({ externalRefs: { salesforce: 'A-42' } }), 'external:salesforce:A-42');
});

test('email domain and name matches enter review instead of auto-linking', async () => {
  const linked = [];
  const reviews = [];
  const prisma = {
    canonicalEntity: {
      findMany: async ({ where }) => where.emailDomains
        ? [{ id: 'entity-1', canonicalName: 'Acme', emailDomains: ['example.com'] }]
        : [],
    },
    entityReviewCandidate: {
      create: async ({ data }) => { reviews.push(data); return { id: 'review-1' }; },
    },
    memoryEntityLink: {
      upsert: async ({ create }) => linked.push(create),
    },
  };
  const resolver = new EntityResolver({ prisma });
  const result = await resolver.resolveAndLink({
    memoryId: 'memory-1',
    organizationId: 'org-1',
    candidates: [{ name: 'Acme', kind: 'company', emailDomain: 'example.com' }],
  });

  assert.equal(result[0].action, 'review');
  assert.equal(reviews.length, 1);
  assert.equal(linked.length, 0);
});

test('verified email remains an automatic identity signal', async () => {
  const linked = [];
  const existing = {
    id: 'entity-1', aliases: [], emailDomains: [], externalRefs: {}, primaryEmail: 'person@example.com',
  };
  const prisma = {
    canonicalEntity: {
      findFirst: async () => existing,
      findUnique: async () => existing,
      update: async () => existing,
    },
    memoryEntityLink: { upsert: async ({ create }) => linked.push(create) },
  };
  const resolver = new EntityResolver({ prisma });
  const result = await resolver.resolveAndLink({
    memoryId: 'memory-1', organizationId: 'org-1',
    candidates: [{ name: 'Person', kind: 'person', email: 'Person@Example.com' }],
  });
  assert.equal(result[0].action, 'linked');
  assert.equal(linked.length, 1);
});

test('canonical entity merge rejects cross-tenant ids before modifying links', async () => {
  let writes = 0;
  const tx = {
    canonicalEntity: {
      findUnique: async ({ where }) => ({ id: where.id, organizationId: where.id === 'src' ? 'org-1' : 'org-2' }),
    },
    $executeRawUnsafe: async () => { writes += 1; },
  };
  const resolver = new EntityResolver({ prisma: { $transaction: (fn) => fn(tx) } });
  await assert.rejects(() => resolver.mergeEntities({ srcId: 'src', dstId: 'dst' }), /Tenant scope violation/);
  assert.equal(writes, 0);
});
