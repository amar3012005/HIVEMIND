import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';

// Store wiring for HIVEMIND_RLS_TENANT_CONTEXT: flag off issues exactly the
// pre-existing statements on the root client; flag on runs each routed group
// in a transaction whose first statement sets the tenant context.
const ORG = '11111111-1111-4111-8111-111111111111', USER = '22222222-2222-4222-8222-222222222222';
function client(calls) {
  const mk = (tag) => ({
    $executeRaw(s, ...v) { calls.push([tag, 'set', s.join('?'), v]); return 1; },
    $executeRawUnsafe(sql, ...v) { calls.push([tag, 'execUnsafe', sql, v]); return 1; },
    $queryRawUnsafe(sql, ...v) { calls.push([tag, 'query', sql, v]); return [{ id: 'm1', content: 'x', fts_score: 1, scope: 'organization' }]; },
    memory: { findMany: async () => { calls.push([tag, 'findMany']); return []; }, count: async () => { calls.push([tag, 'count']); return 0; }, findFirst: async () => { calls.push([tag, 'findFirst']); return null; } },
  });
  const root = mk('root');
  root.$transaction = async (fn, opts) => { calls.push(['root', 'tx', opts]); return fn(mk('tx')); };
  return root;
}
const restore = process.env.HIVEMIND_RLS_TENANT_CONTEXT;
test.after(() => { if (restore === undefined) delete process.env.HIVEMIND_RLS_TENANT_CONTEXT; else process.env.HIVEMIND_RLS_TENANT_CONTEXT = restore; });

for (const flag of [undefined, 'true']) {
  test(`searchMemories flag=${flag}`, async () => {
    if (flag) process.env.HIVEMIND_RLS_TENANT_CONTEXT = flag; else delete process.env.HIVEMIND_RLS_TENANT_CONTEXT;
    const calls = []; const store = new PrismaGraphStore(client(calls));
    const r = await store.searchMemories({ query: 'solvis launch', user_id: USER, org_id: ORG, scope: 'organization' });
    assert.equal(r.length, 1);
    const q = calls.find((c) => c[1] === 'query');
    assert.match(q[2], /m\.scope <> 'personal' OR m\.user_id = \$4::uuid/);
    if (!flag) { assert.equal(q[0], 'root'); assert.ok(!calls.some((c) => c[1] === 'tx' || c[1] === 'set')); }
    else { assert.deepEqual(calls.map((c) => c[0] + ':' + c[1]), ['root:tx', 'tx:set', 'tx:query']); assert.deepEqual(calls[1][3], [ORG, USER]); }
  });
  test(`listMemories + advisoryLock flag=${flag}`, async () => {
    if (flag) process.env.HIVEMIND_RLS_TENANT_CONTEXT = flag; else delete process.env.HIVEMIND_RLS_TENANT_CONTEXT;
    const calls = []; const store = new PrismaGraphStore(client(calls));
    await store.listMemories({ user_id: USER, org_id: ORG });
    await store.advisoryLock(USER, async (s) => s.getMemoryScoped('id1', { user_id: USER, org_id: ORG }), ORG);
    const seq = calls.map((c) => c[0] + ':' + c[1]);
    if (!flag) assert.deepEqual(seq, ['root:findMany', 'root:count', 'root:tx', 'tx:execUnsafe', 'tx:findFirst']);
    else assert.deepEqual(seq, ['root:tx', 'tx:set', 'tx:findMany', 'tx:count', 'root:tx', 'tx:set', 'tx:execUnsafe', 'tx:set', 'tx:findFirst']);
  });
}
