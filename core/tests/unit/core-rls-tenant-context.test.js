import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TENANT_CONTEXT_FLAG,
  TENANT_CONTEXT_SQL,
  applyPgTenantContext,
  isTenantContextEnabled,
  runTenantScoped,
  tenantContextValues,
  withTenant,
  withTenantPg,
} from '../../src/db/tenant-context.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ON = { [TENANT_CONTEXT_FLAG]: 'true' };
const OFF = {};

// Prisma-like client recording every call in order. `$executeRaw` is a tagged
// template, so it receives (strings, ...values).
function fakePrisma() {
  const calls = [];
  const tx = {
    $executeRaw(strings, ...values) {
      calls.push({ kind: 'executeRaw', sql: strings.join('?'), values });
      return Promise.resolve(1);
    },
    memory: { findMany: async (args) => { calls.push({ kind: 'findMany', args }); return []; } },
  };
  const prisma = {
    calls,
    tx,
    $executeRaw: tx.$executeRaw,
    memory: { findMany: async (args) => { calls.push({ kind: 'root.findMany', args }); return []; } },
    async $transaction(fn, options) {
      calls.push({ kind: 'transaction', options });
      return fn(tx);
    },
  };
  return prisma;
}

function fakePool({ failOn = null, failRollback = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (failRollback && sql === 'ROLLBACK') throw new Error('rollback failed');
      if (failOn && sql === failOn) throw new Error(`failed: ${sql}`);
      return { rows: [] };
    },
    release(err) { calls.push({ release: true, err: err ?? null }); },
  };
  const pool = {
    calls,
    connected: 0,
    async connect() { pool.connected += 1; return client; },
    async query(sql, params) { calls.push({ sql, params, viaPool: true }); return { rows: [] }; },
  };
  return pool;
}

test('flag defaults off and accepts only true/1', () => {
  assert.equal(isTenantContextEnabled({}), false);
  assert.equal(isTenantContextEnabled({ [TENANT_CONTEXT_FLAG]: 'false' }), false);
  assert.equal(isTenantContextEnabled({ [TENANT_CONTEXT_FLAG]: 'yes' }), false);
  assert.equal(isTenantContextEnabled({ [TENANT_CONTEXT_FLAG]: 'true' }), true);
  assert.equal(isTenantContextEnabled({ [TENANT_CONTEXT_FLAG]: '1' }), true);
});

test('missing principal ids become empty strings, which the policies read as unset', () => {
  assert.deepEqual(tenantContextValues({ orgId: ORG, userId: USER }), [ORG, USER]);
  assert.deepEqual(tenantContextValues({ orgId: ORG }), [ORG, '']);
  assert.deepEqual(tenantContextValues({}), ['', '']);
});

test('withTenant with the flag off runs fn on the original client and issues nothing', async () => {
  const prisma = fakePrisma();
  const result = await withTenant(prisma, { orgId: ORG, userId: USER }, async (db) => {
    assert.equal(db, prisma);
    return 'ok';
  }, { env: OFF });
  assert.equal(result, 'ok');
  assert.deepEqual(prisma.calls, []);
});

test('withTenant with the flag on sets transaction-local org and user before the work', async () => {
  const prisma = fakePrisma();
  const result = await withTenant(prisma, { orgId: ORG, userId: USER }, async (db) => {
    assert.equal(db, prisma.tx);
    await db.memory.findMany({ where: { orgId: ORG } });
    return 'scoped';
  }, { env: ON });
  assert.equal(result, 'scoped');
  assert.deepEqual(prisma.calls.map((c) => c.kind), ['transaction', 'executeRaw', 'findMany']);
  const setCall = prisma.calls[1];
  assert.match(setCall.sql, /set_config\('app\.current_org_id', \?::text, true\)/);
  assert.match(setCall.sql, /set_config\('app\.current_user_id', \?::text, true\)/);
  assert.match(setCall.sql, /set_config\('app\.hivemind_org_id', \?::text, true\)/);
  assert.match(setCall.sql, /set_config\('app\.hivemind_user_id', \?::text, true\)/);
  assert.doesNotMatch(setCall.sql, /false/i);
  assert.deepEqual(setCall.values, [ORG, USER, ORG, USER]);
  assert.deepEqual(prisma.calls[0].options, { timeout: 30000 });
});

test('withTenant honours HIVEMIND_RLS_TX_TIMEOUT_MS', async () => {
  const prisma = fakePrisma();
  await withTenant(prisma, { orgId: ORG, userId: USER }, async () => null, {
    env: { ...ON, HIVEMIND_RLS_TX_TIMEOUT_MS: '5000' },
  });
  assert.deepEqual(prisma.calls[0].options, { timeout: 5000 });
});

test('raw pg statement is parameterized and transaction-local', () => {
  assert.equal(
    TENANT_CONTEXT_SQL,
    "SELECT set_config('app.current_org_id', $1::text, true), set_config('app.current_user_id', $2::text, true), set_config('app.hivemind_org_id', $1::text, true), set_config('app.hivemind_user_id', $2::text, true)",
  );
});

test('withTenantPg with the flag off passes the pool through and never connects', async () => {
  const pool = fakePool();
  await withTenantPg(pool, { orgId: ORG, userId: USER }, async (db) => {
    assert.equal(db, pool);
    await db.query('SELECT 1');
  }, { env: OFF });
  assert.equal(pool.connected, 0);
  assert.deepEqual(pool.calls, [{ sql: 'SELECT 1', params: undefined, viaPool: true }]);
});

test('withTenantPg with the flag on runs BEGIN, set_config, work, COMMIT and releases', async () => {
  const pool = fakePool();
  const result = await withTenantPg(pool, { orgId: ORG, userId: USER }, async (db) => {
    await db.query('SELECT * FROM memories WHERE org_id = $1', [ORG]);
    return 7;
  }, { env: ON });
  assert.equal(result, 7);
  assert.deepEqual(pool.calls, [
    { sql: 'BEGIN', params: undefined },
    { sql: TENANT_CONTEXT_SQL, params: [ORG, USER] },
    { sql: 'SELECT * FROM memories WHERE org_id = $1', params: [ORG] },
    { sql: 'COMMIT', params: undefined },
    { release: true, err: null },
  ]);
});

test('withTenantPg rolls back and releases on error', async () => {
  const pool = fakePool({ failOn: 'SELECT boom' });
  await assert.rejects(
    withTenantPg(pool, { orgId: ORG, userId: USER }, (db) => db.query('SELECT boom'), { env: ON }),
    /failed: SELECT boom/,
  );
  assert.deepEqual(pool.calls.map((c) => c.sql ?? 'release'), ['BEGIN', TENANT_CONTEXT_SQL, 'SELECT boom', 'ROLLBACK', 'release']);
  assert.equal(pool.calls.at(-1).err, null);
});

test('withTenantPg destroys the connection when ROLLBACK fails', async () => {
  const pool = fakePool({ failOn: 'SELECT boom', failRollback: true });
  await assert.rejects(
    withTenantPg(pool, { orgId: ORG, userId: USER }, (db) => db.query('SELECT boom'), { env: ON }),
    /failed: SELECT boom/,
  );
  assert.match(pool.calls.at(-1).err?.message ?? '', /rollback failed/);
});

test('applyPgTenantContext sends org then user', async () => {
  const pool = fakePool();
  const client = await pool.connect();
  await applyPgTenantContext(client, { orgId: ORG, userId: USER });
  assert.deepEqual(pool.calls, [{ sql: TENANT_CONTEXT_SQL, params: [ORG, USER] }]);
});

test('runTenantScoped: flag off, no org, or non-central org issue no statement', async () => {
  for (const scope of [
    { env: OFF, ctx: { orgId: ORG, userId: USER }, routable: true },
    { env: ON, ctx: { orgId: null, userId: USER }, routable: true },
    { env: ON, ctx: { orgId: ORG, userId: USER }, routable: false },
  ]) {
    const prisma = fakePrisma();
    const db = await runTenantScoped({ client: prisma, ...scope }, async (client) => client);
    assert.equal(db, prisma);
    assert.deepEqual(prisma.calls, []);
  }
});

test('runTenantScoped inside an existing transaction sets context on it without nesting', async () => {
  const prisma = fakePrisma();
  const tx = prisma.tx;
  tx.$transaction = () => { throw new Error('must not nest'); };
  await runTenantScoped({ client: tx, inTransaction: true, ctx: { orgId: ORG, userId: USER }, env: ON }, async (db) => {
    assert.equal(db, tx);
    await db.memory.findMany({});
  });
  assert.deepEqual(prisma.calls.map((c) => c.kind), ['executeRaw', 'findMany']);
  assert.deepEqual(prisma.calls[0].values, [ORG, USER, ORG, USER]);
});

test('runTenantScoped outside a transaction opens one', async () => {
  const prisma = fakePrisma();
  await runTenantScoped({ client: prisma, ctx: { orgId: ORG, userId: USER }, env: ON }, (db) => db.memory.findMany({}));
  assert.deepEqual(prisma.calls.map((c) => c.kind), ['transaction', 'executeRaw', 'findMany']);
});

test('no Core source adopts the session-level set_app_context()', () => {
  const store = readFileSync(new URL('../../src/memory/prisma-graph-store.js', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('../../src/db/tenant-context.js', import.meta.url), 'utf8');
  assert.doesNotMatch(store, /set_app_context\s*\(/);
  assert.doesNotMatch(helper.replace(/^\s*\*.*$/gm, ''), /set_app_context\s*\(/);
  assert.doesNotMatch(helper, /set_config\([^)]*,\s*false\)/i);
});
