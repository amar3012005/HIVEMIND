// Two guarantees: (1) multi-org routing — the driver sends each .amr org's traffic to its OWN
// adapter, others to Postgres; (2) conformance — the adapter answers the real query shapes the app
// issues with Prisma-correct results. Run: node core/src/vector/mneme/driver-conformance.test.mjs
import { makeMnemePrisma, orgOf } from './prisma-proxy.js';
import { makeMnemeAdapter } from './prisma-adapter.js';
import assert from 'node:assert';
let pass = 0; const t = async (n, f) => { await f(); pass++; console.log('  ✓ ' + n); };

// ---------- 1. MULTI-ORG routing (mock adapters) ----------
const calls = [];
const mk = (src) => ({ findMany: async (a) => (calls.push([src, 'findMany', orgOf(a)]), [{ src }]), create: async (a) => (calls.push([src, 'create']), { src }), count: async () => 0, upsert: async () => ({ src }) });
const real = { memory: mk('pg'), relationship: mk('pg'), sourceMetadata: mk('pg'), knowledgeSegment: mk('pg'), user: mk('pg'), $transaction: async (f) => (typeof f === 'function' ? f(real) : 'b') };
const adA = { memory: { ...mk('amrA'), byId: new Map([['mA', { id: 'mA', orgId: 'A' }]]) }, relationship: mk('amrA'), sourceMetadata: mk('amrA') };
const adB = { memory: { ...mk('amrB'), byId: new Map([['mB', { id: 'mB', orgId: 'B' }]]) }, relationship: mk('amrB'), sourceMetadata: mk('amrB') };
const proxy = makeMnemePrisma(real, { isAmrOrg: (o) => o === 'A' || o === 'B', getAdapter: (o) => (o === 'A' ? adA : o === 'B' ? adB : null), getAllAdapters: () => [adA, adB] });

await t('org A memory → adapter A', async () => assert.equal((await proxy.memory.findMany({ where: { orgId: 'A' } }))[0].src, 'amrA'));
await t('org B memory → adapter B', async () => assert.equal((await proxy.memory.findMany({ where: { orgId: 'B' } }))[0].src, 'amrB'));
await t('org C (not .amr) → Postgres', async () => assert.equal((await proxy.memory.findMany({ where: { orgId: 'C' } }))[0].src, 'pg'));
await t('FK-child by memoryId in A → adapter A (no org on op)', async () => assert.equal((await proxy.sourceMetadata.findMany({ where: { memoryId: 'mA' } }))[0].src, 'amrA'));
await t('FK-child by memoryId in B → adapter B', async () => assert.equal((await proxy.sourceMetadata.findMany({ where: { memoryId: 'mB' } }))[0].src, 'amrB'));
await t('FK-child unknown memoryId → Postgres', async () => assert.equal((await proxy.sourceMetadata.findMany({ where: { memoryId: 'zzz' } }))[0].src, 'pg'));
await t('non-routed model (user) → Postgres', async () => assert.equal((await proxy.user.findMany())[0].src, 'pg'));

// ---------- 2. CONFORMANCE: adapter ≡ Prisma semantics on real shapes ----------
const now = Date.now();
const recs = [
  { id: 'm1', orgId: 'O', userId: 'u1', content: 'a', tags: ['extracted-fact', 'entity:x'], memoryType: 'fact', isLatest: true, deletedAt: null, createdAt: new Date(now - 3000), layer: 'memory', project: 'p1', scope: 'project', confidence: 0.9 },
  { id: 'm2', orgId: 'O', userId: 'u1', content: 'b', tags: ['promoted-from-segment'], memoryType: 'fact', isLatest: true, deletedAt: null, createdAt: new Date(now - 2000), layer: 'evidence', project: 'p1', scope: 'project', confidence: 0.5 },
  { id: 'm3', orgId: 'O', userId: 'u2', content: 'c', tags: ['extracted-fact'], memoryType: 'fact', isLatest: false, deletedAt: null, createdAt: new Date(now - 1000), layer: 'memory', project: 'p2', scope: 'org', confidence: 0.8 },
];
const db = makeMnemeAdapter({ memories: recs.map((r) => ({ ...r })) });
const M = db.memory;
await t('CONF findMany org+isLatest+deletedAt null + orderBy desc + take', async () => {
  const r = await M.findMany({ where: { orgId: 'O', isLatest: true, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 10 });
  assert.deepEqual(r.map((x) => x.id), ['m2', 'm1']);
});
await t('CONF count by org', async () => assert.equal(await M.count({ where: { orgId: 'O' } }), 3));
await t('CONF tags hasSome (entity)', async () => assert.deepEqual((await M.findMany({ where: { tags: { hasSome: ['entity:x'] } } })).map((x) => x.id), ['m1']));
await t('CONF project-scope filter', async () => assert.deepEqual((await M.findMany({ where: { orgId: 'O', project: 'p1' } })).map((x) => x.id).sort(), ['m1', 'm2']));
await t('CONF NOT layer evidence', async () => assert.deepEqual((await M.findMany({ where: { orgId: 'O', NOT: { layer: 'evidence' } } })).map((x) => x.id).sort(), ['m1', 'm3']));
await t('CONF groupBy layer', async () => { const g = await M.groupBy({ by: ['layer'], where: { orgId: 'O' }, _count: true }); assert.equal(g.find((x) => x.layer === 'memory')._count, 2); });
await t('CONF findUnique by id', async () => assert.equal((await M.findUnique({ where: { id: 'm3' } })).content, 'c'));
await t('CONF createdAt gt (temporal)', async () => assert.deepEqual((await M.findMany({ where: { orgId: 'O', createdAt: { gt: new Date(now - 1500) } } })).map((x) => x.id), ['m3']));

// ---------- 3. FAIL-LOUD: unsupported shape throws (never silent-wrong) ----------
await t('FAIL-LOUD unsupported operator throws', async () => {
  await assert.rejects(() => M.findMany({ where: { content: { mode: 'insensitive', search: 'x' } } }), /unsupported operator/);
});

console.log(`\ndriver + conformance: ${pass}/${pass} — multi-org routing + Prisma-semantics parity + fail-loud`);
