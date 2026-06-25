// Local test for the .amr Prisma adapter — verifies it behaves like prisma.memory/relationship
// for the operations the pipeline uses. Run: node core/src/vector/mneme/prisma-adapter.test.mjs
import { makeMnemeAdapter } from './prisma-adapter.js';
import assert from 'node:assert';

const ORG = 'org-sai';
let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };

// backend spy: record what was persisted to ".amr"
const persisted = { inserts: [], updates: [], removes: [] };
const spyBackend = (kind) => ({
  insert: (r) => persisted.inserts.push([kind, r.id]),
  update: (id) => persisted.updates.push([kind, id]),
  remove: (id) => persisted.removes.push([kind, id]),
});

const db = makeMnemeAdapter({
  backends: { memory: spyBackend('mem'), relationship: spyBackend('rel'), knowledgeSegment: spyBackend('seg') },
});

await t('memory.create + persists to backend', async () => {
  const m = await db.memory.create({ data: { id: 'm1', orgId: ORG, userId: 'u1', content: 'fact A', tags: ['extracted-fact'], isLatest: true, deletedAt: null, createdAt: new Date(), layer: 'memory' } });
  assert.equal(m.id, 'm1');
  assert.deepEqual(persisted.inserts.at(-1), ['mem', 'm1']);
});

await t('memory.create more + findMany org-scoped latest', async () => {
  await db.memory.create({ data: { id: 'm2', orgId: ORG, userId: 'u1', content: 'evidence chunk', tags: ['promoted-from-segment'], isLatest: true, deletedAt: null, createdAt: new Date(), layer: 'evidence' } });
  await db.memory.create({ data: { id: 'm3', orgId: 'other', userId: 'u9', content: 'other org', tags: [], isLatest: true, deletedAt: null, createdAt: new Date(), layer: 'memory' } });
  const r = await db.memory.findMany({ where: { orgId: ORG, isLatest: true, deletedAt: null } });
  assert.deepEqual(r.map((x) => x.id).sort(), ['m1', 'm2']); // org isolation: m3 excluded
});

await t('memory.count', async () => {
  assert.equal(await db.memory.count({ where: { orgId: ORG } }), 2);
});

await t('memory.update {set} + persists', async () => {
  await db.memory.update({ where: { id: 'm1' }, data: { isLatest: false } });
  const m = await db.memory.findUnique({ where: { id: 'm1' } });
  assert.equal(m.isLatest, false);
  assert.deepEqual(persisted.updates.at(-1), ['mem', 'm1']);
});

await t('memory.updateMany (supersede) + count latest', async () => {
  await db.memory.updateMany({ where: { orgId: ORG, layer: 'evidence' }, data: { isLatest: false } });
  assert.equal(await db.memory.count({ where: { orgId: ORG, isLatest: true } }), 0);
});

await t('relationship.create + relation filter fromMemory:{orgId}', async () => {
  await db.relationship.create({ data: { id: 'r1', fromId: 'm1', toId: 'm2', type: 'Derives', confidence: 0.9 } });
  await db.relationship.create({ data: { id: 'r2', fromId: 'm3', toId: 'm1', type: 'Mentions', confidence: 0.8 } }); // from other-org memory
  const rels = await db.relationship.findMany({ where: { fromMemory: { orgId: ORG } } });
  assert.deepEqual(rels.map((x) => x.id), ['r1']); // r2's fromMemory is other-org → excluded
});

await t('relationship.groupBy type', async () => {
  const g = await db.relationship.groupBy({ by: ['type'], where: { fromMemory: { orgId: ORG } }, _count: true });
  assert.equal(g.find((x) => x.type === 'Derives')._count, 1);
});

await t('memory.delete + persists remove', async () => {
  await db.memory.delete({ where: { id: 'm2' } });
  assert.equal(await db.memory.findUnique({ where: { id: 'm2' } }), null);
  assert.deepEqual(persisted.removes.at(-1), ['mem', 'm2']);
});

await t('upsert: creates then updates', async () => {
  await db.memory.upsert({ where: { id: 'm9' }, create: { orgId: ORG, content: 'new', isLatest: true, deletedAt: null }, update: { content: 'x' } });
  assert.equal((await db.memory.findUnique({ where: { id: 'm9' } })).content, 'new');
  await db.memory.upsert({ where: { id: 'm9' }, create: {}, update: { content: 'updated' } });
  assert.equal((await db.memory.findUnique({ where: { id: 'm9' } })).content, 'updated');
});

console.log(`\n.amr prisma-adapter: ${pass}/9 operations PASS (create/find/count/update/updateMany/relation-filter/groupBy/delete/upsert + backend persistence)`);
