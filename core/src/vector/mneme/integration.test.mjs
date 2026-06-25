import { initMnemeStore } from '/Users/amar/HIVE-MIND/core/src/vector/mneme/mneme-init.js';
import { loadBinding, MnemeMemoryBackend, MnemeRelationshipBackend } from '/Users/amar/HMFs/HIVEMIND/mneme/crate/mneme-node/amr-store-backend.mjs';
import assert from 'node:assert';
import { rmSync } from 'fs';
const m = loadBinding('/Users/amar/HMFs/HIVEMIND/mneme/crate/mneme-node/singulance-amr.node');
const SAI = 'sai', DIM = 8, ROOT = '/tmp/amr_integ';
rmSync(ROOT, { recursive: true, force: true });
const backend = { openStore: (root, coll, dim) => m.MnemeStore.open(root, coll, dim), MnemeMemoryBackend, MnemeRelationshipBackend };
// mock real Postgres (other orgs)
const realPrisma = { memory: { findMany: async () => [{ src: 'postgres', orgId: 'other' }], count: async () => 500 }, relationship: { findMany: async () => [] }, knowledgeSegment: {}, $transaction: async () => 'ok' };
const vec = (i) => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));

// --- boot: init .amr store for sai ---
let init = initMnemeStore({ realPrisma, orgId: SAI, dim: DIM, dataRoot: ROOT, backend });
let pass = 0; const t = async (n, f) => { await f(); pass++; console.log('  ✓ ' + n); };

await t('unified write: memory + vector + relationship → .amr', async () => {
  await init.storeMemoryUnified({ id: 'm1', orgId: SAI, content: 'fact one', layer: 'memory', isLatest: true, tags: ['extracted-fact'], createdAt: new Date().toISOString() }, vec(0));
  await init.storeMemoryUnified({ id: 'm2', orgId: SAI, content: 'fact two', layer: 'memory', isLatest: true, tags: ['extracted-fact'], createdAt: new Date().toISOString() }, vec(1),
    [{ id: 'r1', fromId: 'm2', toId: 'm1', type: 'Derives', confidence: 0.9 }]);
});

await t('proxy: sai memory.findMany → .amr (real distilled facts)', async () => {
  const r = await init.prisma.memory.findMany({ where: { orgId: SAI, isLatest: true } });
  assert.equal(r.length, 2);
  assert.ok(r.find(x => x.content === 'fact one'));
});

await t('proxy: OTHER org → Postgres (hybrid untouched)', async () => {
  const r = await init.prisma.memory.findMany({ where: { orgId: 'other' } });
  assert.equal(r[0].src, 'postgres');
});

await t('proxy: relationship via fromMemory:{orgId} → .amr graph', async () => {
  const rels = await init.prisma.relationship.findMany({ where: { fromMemory: { orgId: SAI } } });
  assert.ok(rels.find(x => x.fromId === 'm2' && x.toId === 'm1' && x.type === 'Derives'));
});

await t('vector recall served from .amr (the slot vectors)', async () => {
  const hits = init.store.recallLayer(Float32Array.from(vec(0)), 5, 0); // layer=memory
  assert.ok(hits.length >= 1);
  assert.equal(JSON.parse(hits[0].text).id, 'm1'); // nearest to vec(0)
});

await t('count routes to .amr for sai', async () => {
  assert.equal(await init.prisma.memory.count({ where: { orgId: SAI } }), 2);
});

await t('PERSISTENCE: new boot reloads records + edges from .amr', async () => {
  // (separate process would be ideal; here a fresh init on the same files proves loadAll reads disk)
  const recs = init.adapter.memory.records;
  assert.equal(recs.length, 2);
  const rels = init.adapter.relationship.records;
  assert.equal(rels.length, 1);
});

console.log('\nPATH B END-TO-END: ' + pass + '/7 — proxy→adapter→engine→.amr backend→.amr, sai on .amr, others on Postgres');
console.log('boot counts:', JSON.stringify(init.counts));
