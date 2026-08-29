import test from 'node:test';
import assert from 'node:assert/strict';
import { persistCanonicalLinks } from '../../src/memory/canonical-entity-persister.js';
import { EntityResolver } from '../../src/memory/entity-resolver.js';

// Minimal fake prisma implementing exactly what EntityResolver +
// persistCanonicalLinks touch. In-memory registry keyed by canonicalName.
function makePrisma({ existing = [], reviewMatch = null } = {}) {
  const entities = [...existing];
  const links = [];
  const reviews = [];
  let idSeq = 1;
  return {
    entities, links, reviews,
    externalRef: { findFirst: async () => null },
    canonicalEntity: {
      findFirst: async ({ where }) => entities.find((e) => {
        if (e.organizationId !== where.organizationId) return false;
        if (where.normalizedName?.in) return where.normalizedName.in.includes(e.normalizedName);
        return false;
      }) || null,
      findMany: async ({ where }) => entities.filter((e) => {
        if (e.organizationId !== where.organizationId) return false;
        if (where.entityKind?.in && !where.entityKind.in.includes(e.entityKind)) return false;
        if (typeof where.entityKind === 'string' && e.entityKind !== where.entityKind) return false;
        if (where.OR) {
          return where.OR.some((cond) => {
            if (cond.canonicalName?.equals) return e.canonicalName.toLowerCase() === cond.canonicalName.equals.toLowerCase();
            if (cond.aliases?.has) return (e.aliases || []).includes(cond.aliases.has);
            return false;
          });
        }
        return true;
      }),
      create: async ({ data }) => { const row = { id: `ce-${idSeq++}`, ...data }; entities.push(row); return row; },
      update: async ({ where, data }) => {
        const e = entities.find((x) => x.id === where.id); Object.assign(e, data); return e;
      },
      findUnique: async ({ where }) => entities.find((x) => x.id === where.id) || null,
    },
    memoryEntityLink: {
      upsert: async ({ create }) => { links.push(create); return create; },
      findFirst: async () => null,
    },
    entityReviewCandidate: {
      create: async ({ data }) => { const row = { id: `rev-${idSeq++}`, ...data }; reviews.push(row); return row; },
    },
  };
}

const ORG = 'org-1';

test('creates one canonical entity per unique name and links every memory', async () => {
  const prisma = makePrisma();
  const out = await persistCanonicalLinks({
    prisma, organizationId: ORG, logger: { warn() {}, info() {} },
    items: [
      { memoryId: 'm1', entities: ['SOLVIS', 'SolvisMax'] },
      { memoryId: 'm2', entities: ['SOLVIS'] },        // same entity, different doc/fact
      { memoryId: 'm3', entities: ['solvis'] },        // case variant → same slug
    ],
  });
  assert.equal(prisma.entities.length, 2, 'SOLVIS + SolvisMax only — no duplicates');
  assert.equal(out.created, 2);
  const solvisId = prisma.entities.find((e) => e.canonicalName === 'SOLVIS').id;
  const solvisLinks = prisma.links.filter((l) => l.entityId === solvisId).map((l) => l.memoryId).sort();
  assert.deepEqual(solvisLinks, ['m1', 'm2', 'm3']);
});

test('reuses an existing exact canonical entity instead of creating', async () => {
  const prisma = makePrisma({
    existing: [{ id: 'ce-solvis', organizationId: ORG, entityKind: 'entity', canonicalName: 'SOLVIS', aliases: ['SOLVIS'] }],
  });
  const out = await persistCanonicalLinks({
    prisma, organizationId: ORG, logger: { warn() {}, info() {} },
    items: [{ memoryId: 'm9', entities: ['SOLVIS'] }],
  });
  assert.equal(out.created, 0, 'no new entity');
  assert.equal(prisma.entities.length, 1);
  assert.equal(prisma.links[0].entityId, 'ce-solvis');
  assert.equal(prisma.links[0].memoryId, 'm9');
});

test('junk/generic names never become canonical entities', async () => {
  const prisma = makePrisma();
  await persistCanonicalLinks({
    prisma, organizationId: ORG, logger: { warn() {}, info() {} },
    items: [{ memoryId: 'm1', entities: ['test', 'foo', '  ', 'x'] }],
  });
  assert.equal(prisma.entities.length, 0);
  assert.equal(prisma.links.length, 0);
});

test('kill switch CANONICAL_ENTITY_PERSIST=false is a no-op', async () => {
  process.env.CANONICAL_ENTITY_PERSIST = 'false';
  try {
    const prisma = makePrisma();
    const out = await persistCanonicalLinks({
      prisma, organizationId: ORG,
      items: [{ memoryId: 'm1', entities: ['SOLVIS'] }],
    });
    assert.equal(prisma.entities.length, 0);
    assert.deepEqual(out, { linked: 0, created: 0, review: 0, skipped: 0, projectionFailed: 0 });
  } finally { delete process.env.CANONICAL_ENTITY_PERSIST; }
});

test('storage failure on one name never throws and continues the batch', async () => {
  const prisma = makePrisma();
  const origCreate = prisma.canonicalEntity.create;
  let first = true;
  prisma.canonicalEntity.create = async (args) => {
    if (first) { first = false; throw new Error('db down'); }
    return origCreate(args);
  };
  const out = await persistCanonicalLinks({
    prisma, organizationId: ORG, logger: { warn() {}, info() {} },
    items: [{ memoryId: 'm1', entities: ['Alpha Corp', 'Beta GmbH'] }],
  });
  assert.equal(out.skipped >= 1, true);
  assert.equal(prisma.entities.length, 1, 'second name still persisted');
});

test('missing prisma models → safe no-op', async () => {
  const out = await persistCanonicalLinks({
    prisma: {}, organizationId: ORG,
    items: [{ memoryId: 'm1', entities: ['SOLVIS'] }],
  });
  assert.deepEqual(out, { linked: 0, created: 0, review: 0, skipped: 0, projectionFailed: 0 });
});

test('remote resolution can create a canonical entity without a central memory FK link', async () => {
  const prisma = makePrisma();
  const resolver = new EntityResolver({ prisma });
  const results = await resolver.resolveAndLink({
    memoryId: 'remote-memory-not-in-postgres',
    organizationId: ORG,
    linkMemory: false,
    candidates: [{ name: 'Paolo Rossi', kind: 'person' }],
  });
  assert.equal(results[0].action, 'created');
  assert.equal(prisma.entities.length, 1);
  assert.equal(prisma.links.length, 0, 'remote memory must not create a central FK link');
});
