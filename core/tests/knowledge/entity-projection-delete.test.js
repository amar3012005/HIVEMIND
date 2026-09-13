import assert from 'node:assert/strict';
import test from 'node:test';
import { purgeEntityResourceProjections } from '../../src/knowledge/entity-projection-delete.js';

function makePrisma() {
  const calls = [];
  const tx = {
    resourceEntityLink: {
      findMany: async (query) => { calls.push(['resource.find', query]); return [{ entityId: 'entity-a' }]; },
      deleteMany: async (query) => { calls.push(['resource.delete', query]); return { count: 3 }; },
    },
    memoryEntityLink: {
      findMany: async (query) => { calls.push(['memory.find', query]); return [{ entityId: 'entity-b' }]; },
      deleteMany: async (query) => { calls.push(['memory.delete', query]); return { count: 2 }; },
    },
    entityExtractionReceipt: {
      deleteMany: async (query) => { calls.push(['receipt.delete', query]); return { count: 4 }; },
    },
    canonicalEntity: {
      deleteMany: async (query) => { calls.push(['entity.delete', query]); return { count: 1 }; },
    },
  };
  return {
    calls,
    $transaction: async (fn) => fn(tx),
  };
}

test('purges document, segment, and memory entity projections tenant-scoped', async () => {
  const prisma = makePrisma();
  const result = await purgeEntityResourceProjections({
    prisma,
    organizationId: 'org-1',
    resources: [
      { resourceType: 'document', resourceId: 'doc-1' },
      { resourceType: 'segment', resourceId: 'segment-1' },
      { resourceType: 'memory', resourceId: 'memory-1' },
      { resourceType: 'memory', resourceId: 'memory-1' },
    ],
  });

  assert.deepEqual(result, {
    resources: 3,
    resourceLinks: 3,
    memoryLinks: 2,
    receipts: 4,
    entities: 1,
  });
  const resourceDelete = prisma.calls.find(([kind]) => kind === 'resource.delete')[1].where;
  assert.equal(resourceDelete.organizationId, 'org-1');
  assert.deepEqual(resourceDelete.OR, [
    { resourceType: 'document', resourceId: 'doc-1' },
    { resourceType: 'segment', resourceId: 'segment-1' },
    { resourceType: 'memory', resourceId: 'memory-1' },
  ]);
  assert.deepEqual(
    prisma.calls.find(([kind]) => kind === 'memory.delete')[1].where,
    { memoryId: { in: ['memory-1'] } },
  );
  const entityDelete = prisma.calls.find(([kind]) => kind === 'entity.delete')[1].where;
  assert.equal(entityDelete.organizationId, 'org-1');
  assert.deepEqual(entityDelete.id.in.sort(), ['entity-a', 'entity-b']);
  assert.deepEqual(entityDelete.resourceLinks, { none: {} });
  assert.deepEqual(entityDelete.memoryLinks, { none: {} });
  assert.deepEqual(entityDelete.subjectClaims, { none: {} });
  assert.deepEqual(entityDelete.objectClaims, { none: {} });
});

test('does nothing when no valid resources are supplied', async () => {
  let transacted = false;
  const result = await purgeEntityResourceProjections({
    prisma: { $transaction: async () => { transacted = true; } },
    organizationId: 'org-1',
    resources: [{ resourceType: '', resourceId: 'missing-type' }],
  });
  assert.equal(transacted, false);
  assert.deepEqual(result, { resources: 0, resourceLinks: 0, memoryLinks: 0, receipts: 0, entities: 0 });
});

test('runs inside an existing Prisma transaction without nesting another transaction', async () => {
  const prisma = makePrisma();
  const tx = await prisma.$transaction(async (client) => client);
  assert.equal(typeof tx.$transaction, 'undefined');
  const result = await purgeEntityResourceProjections({
    prisma: tx,
    organizationId: 'org-1',
    resources: [{ resourceType: 'memory', resourceId: 'memory-1' }],
  });
  assert.equal(result.resources, 1);
  assert.equal(result.resourceLinks, 3);
  assert.equal(result.receipts, 4);
});
