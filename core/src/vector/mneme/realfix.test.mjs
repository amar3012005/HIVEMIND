import { makeMnemePrisma } from '/Users/amar/HIVE-MIND/core/src/vector/mneme/prisma-proxy.js';
import assert from 'node:assert';
const SAI = 'sai';
let adapter = null; // starts null (not loaded), becomes ready later
const realCalls = [], amrCalls = [];
const real = { memory: { findMany: async (a) => (realCalls.push(a), [{ src: 'pg' }]), create: async (a) => (realCalls.push(a), { src: 'pg' }) }, relationship: { findMany: async () => [{ src: 'pg' }] }, user: { findMany: async () => [{ src: 'pg-user' }] }, $transaction: async () => 'tx' };
const mockAdapter = { memory: { findMany: async (a) => (amrCalls.push(a), [{ src: 'amr' }]), create: async (a) => (amrCalls.push(a), { src: 'amr' }) }, relationship: { findMany: async () => [{ src: 'amr' }] } };

const proxy = makeMnemePrisma(real, { amrOrg: SAI, getAdapter: () => adapter });
let pass = 0; const t = async (n, f) => { await f(); pass++; console.log('  ✓ ' + n); };

// THE split-brain scenario: a module captures the client NOW, before the adapter is loaded.
const capturedEarly = proxy;

await t('stable singleton: getPrismaClient-equivalent returns same ref', () => {
  assert.strictEqual(capturedEarly, proxy);
});
await t('adapter NOT loaded yet → sai falls through to Postgres (no error, no loss)', async () => {
  const r = await capturedEarly.memory.findMany({ where: { orgId: SAI } });
  assert.equal(r[0].src, 'pg'); // graceful fallback during load window
});

// adapter finishes loading
adapter = mockAdapter;

await t('THE FIX: early-captured ref NOW routes sai → .amr (per-call, no re-capture)', async () => {
  const r = await capturedEarly.memory.findMany({ where: { orgId: SAI } });
  assert.equal(r[0].src, 'amr'); // <-- the split-brain bug is gone: same ref, now routes
});
await t('early-captured ref: sai create → .amr', async () => {
  const r = await capturedEarly.memory.create({ data: { id: 'x', orgId: SAI } });
  assert.equal(r.src, 'amr');
});
await t('early-captured ref: OTHER org → Postgres (untouched)', async () => {
  const r = await capturedEarly.memory.findMany({ where: { orgId: 'other' } });
  assert.equal(r[0].src, 'pg');
});
await t('relation filter fromMemory:{orgId:sai} → .amr', async () => {
  const r = await capturedEarly.relationship.findMany({ where: { fromMemory: { orgId: SAI } } });
  assert.equal(r[0].src, 'amr');
});
await t('non-routed model (user) + $transaction pass through', async () => {
  assert.equal((await capturedEarly.user.findMany())[0].src, 'pg-user');
  assert.equal(await capturedEarly.$transaction([]), 'tx');
});
await t('no resolvable org → Postgres (fail-safe)', async () => {
  assert.equal((await capturedEarly.memory.findMany({ where: { isLatest: true } }))[0].src, 'pg');
});

console.log(`\nREAL FIX: ${pass}/8 — early capture + lazy adapter + per-call routing. Split-brain impossible.`);
