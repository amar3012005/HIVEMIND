import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  decodeChangeCursor, encodeChangeCursor, mergeChangePage, readChangeRequest,
  workspaceNotificationChanges, employeeRosterChanges,
} from '../../src/workspace/change-feed.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('cursors round trip and refuse text the server did not issue', () => {
  const cursor = encodeChangeCursor({ xid: '812', id: 'a-1' });
  assert.deepEqual(decodeChangeCursor(cursor), { xid: '812', id: 'a-1' });
  assert.deepEqual(decodeChangeCursor(encodeChangeCursor({ xid: '5', id: null })), { xid: '5', id: null });
  assert.deepEqual(decodeChangeCursor('start'), { xid: '0', id: null });
  assert.deepEqual(decodeChangeCursor(''), { xid: '0', id: null });
  assert.equal(decodeChangeCursor('now'), 'now');
  for (const bad of ['not a cursor', '!!', 'a'.repeat(401), Buffer.from('{"v":2,"x":"1","i":null}').toString('base64url'),
    Buffer.from('{"v":1,"x":"-1","i":null}').toString('base64url'), Buffer.from('{"v":1,"x":"1","i":7}').toString('base64url'), Buffer.from('nonsense').toString('base64url')]) {
    assert.equal(decodeChangeCursor(bad), null, bad);
  }
});

test('requests: default limit 100, 1 to 200 allowed, anything else is refused', () => {
  const ask = query => readChangeRequest(new URL(`http://x/v1/y?${query}`));
  assert.deepEqual(ask('since=start'), { cursor: { xid: '0', id: null }, limit: 100 });
  assert.equal(ask('since=start&limit=200').limit, 200);
  assert.equal(ask('since=start&limit=1').limit, 1);
  for (const bad of ['limit=0', 'limit=201', 'limit=-1', 'limit=1.5', 'limit=x', 'limit=']) assert.equal(ask(`since=start&${bad}`).error, 'Invalid limit', bad);
  assert.equal(ask('since=junk!').error, 'Invalid cursor');
});

test('a page interleaves rows and tombstones by revision, resumes after its last entry, and orders revisions above 2^53', () => {
  const row = (id, rev) => ({ id, feed_revision: String(rev) });
  const page = mergeChangePage([row('b', 10), row('a', 12)], [row('c', 11), row('d', 12)], 3, '99');
  assert.deepEqual(page.rows.map(r => r.id), ['b', 'a']);
  assert.deepEqual(page.tombstones.map(r => r.id), ['c']);
  assert.equal(page.hasMore, true);
  assert.deepEqual(decodeChangeCursor(page.nextCursor), { xid: '12', id: 'a' });
  const done = mergeChangePage([row('a', 3)], [], 5, '99');
  assert.equal(done.hasMore, false);
  assert.deepEqual(decodeChangeCursor(done.nextCursor), { xid: '99', id: null });
  const big = mergeChangePage([row('x', '9007199254740993'), row('y', '9007199254740992')], [], 5, '9007199254740999');
  assert.deepEqual(big.rows.map(r => r.id), ['y', 'x']);
});

function fakePrisma(handlers) {
  const calls = [];
  return {
    calls,
    $queryRawUnsafe: async (sql, ...args) => {
      calls.push({ sql, args });
      if (/pg_snapshot_xmin/.test(sql)) return [{ horizon: '500' }];
      return handlers(sql, args);
    },
    workspaceNotification: { count: async arg => { calls.push({ count: arg }); return 2; } },
  };
}

test('notification feed binds the caller organization and person on every read and keeps the bell filter', async () => {
  const prisma = fakePrisma(() => [
    { id: 'n1', org_id: 'org-1', user_id: 'user-1', type: 'runtime.attention', title: 'T', body: null, resource_type: null, resource_id: null, data: {}, dedupe_key: 'k', read_at: null, created_at: new Date('2026-10-31T10:00:00Z'), feed_revision: '7' },
  ]);
  const out = await workspaceNotificationChanges(prisma, { orgId: 'org-1', userId: 'user-1', cursor: { xid: '0', id: null }, limit: 50 });
  const query = prisma.calls.find(call => /workspace_notifications/.test(call.sql || ''));
  assert.deepEqual(query.args.slice(0, 2), ['org-1', 'user-1']);
  assert.match(query.sql, /n\.org_id = \$1::uuid AND n\.user_id = \$2::uuid/);
  assert.match(query.sql, /n\.type LIKE 'lifecycle\.%' OR n\.type = 'runtime\.attention'/);
  assert.match(query.sql, /n\.change_xid < \$5::text::xid8/);
  assert.equal(query.args[5], 51);
  assert.deepEqual(out.items.map(item => [item.id, item.revision, item.readAt]), [['n1', '7', null]]);
  assert.equal(out.items[0].createdAt, '2026-10-31T10:00:00.000Z');
  assert.deepEqual([out.deleted, out.unread, out.has_more], [[], 2, false]);
  assert.deepEqual(decodeChangeCursor(out.next_cursor), { xid: '500', id: null });
  const head = await workspaceNotificationChanges(fakePrisma(() => { throw new Error('no rows read for since=now'); }), { orgId: 'o', userId: 'u', cursor: 'now', limit: 5 });
  assert.deepEqual([head.items, head.deleted, head.has_more], [[], [], false]);
  assert.deepEqual(decodeChangeCursor(head.next_cursor), { xid: '500', id: null });
});

test('roster feed scopes by organization, applies the visibility rule, and reports archived and removed employees as deleted', async () => {
  const prisma = fakePrisma(sql => /digital_employee_tombstones/.test(sql)
    ? [{ id: 'gone', deleted_at: new Date('2026-10-31T09:00:00Z'), feed_revision: '9' }]
    : [{ id: 'e1', archived_at: null, feed_revision: '8' }, { id: 'e2', archived_at: new Date('2026-10-31T08:00:00Z'), feed_revision: '10' }]);
  let loaded;
  const out = await employeeRosterChanges(prisma, {
    orgId: 'org-1', userId: 'user-1', teamIds: ['t1'], isOrgAdmin: false, cursor: { xid: '0', id: null }, limit: 10,
    load: async ids => { loaded = ids; return [{ id: 'e1', name: 'Ada' }]; },
  });
  const rosterQuery = prisma.calls.find(call => /hivemind\.digital_employees/.test(call.sql || ''));
  assert.deepEqual(rosterQuery.args.slice(0, 4), ['org-1', false, ['t1'], 'user-1']);
  assert.match(rosterQuery.sql, /e\.org_id = \$1::uuid/);
  assert.match(rosterQuery.sql, /e\.scope = 'organization'.*e\.team_id = ANY\(\$3::text\[\]::uuid\[\]\).*e\.created_by = \$4::uuid/);
  assert.deepEqual(prisma.calls.find(call => /tombstones/.test(call.sql || '')).args[0], 'org-1');
  assert.deepEqual(loaded, ['e1']);
  assert.deepEqual(out.items.map(item => [item.id, item.name, item.revision]), [['e1', 'Ada', '8']]);
  assert.deepEqual(out.deleted.map(item => [item.id, item.reason, item.revision]), [['gone', 'removed', '9'], ['e2', 'archived', '10']]);
});

test('Control routes pass the caller session, not request input, as the scope', async () => {
  const source = await read('../../src/control-plane-server.js');
  const bell = source.slice(source.indexOf("pathname === '/v1/workspace/notifications' && req.method === 'GET'"), source.indexOf('// Explicit per-user consent'));
  assert.match(bell, /workspaceNotificationChanges\(prisma, \{ orgId: current\.session\.orgId, userId: current\.session\.userId, \.\.\.request \}\)/);
  const roster = source.slice(source.indexOf("pathname === '/v1/employees' && req.method === 'GET'"), source.indexOf('// POST /v1/service/open-dot/lifecycle-notice'));
  assert.match(roster, /employeeRosterChanges\(prisma, \{\s+orgId, userId: current\.session\.userId, teamIds,/);
  assert.match(roster, /store\.listByIds\(\{ orgId, ids \}\)/);
  assert.match(roster, /const orgId = current\.session\.orgId;/);
});

test('the migration is additive, idempotent and leaves no residue when a company is removed; the Prisma schema matches', async () => {
  const [migration, schema] = await Promise.all([
    read('../../prisma/migrations/20261031100000_sync_change_feed/migration.sql'), read('../../prisma/schema.prisma'),
  ]);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE hivemind/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS change_xid xid8 NOT NULL DEFAULT '0'::xid8/);
  assert.equal((migration.match(/ADD COLUMN IF NOT EXISTS change_xid/g) || []).length, 2);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS hivemind\.digital_employee_tombstones/);
  assert.equal((migration.match(/DROP TRIGGER IF EXISTS/g) || []).length, (migration.match(/CREATE TRIGGER/g) || []).length);
  assert.match(migration, /IF EXISTS \(SELECT 1 FROM hivemind\.organizations WHERE id = OLD\.org_id\)/);
  assert.match(migration, /CREATE TRIGGER digital_employees_tombstone AFTER DELETE/);
  assert.equal((schema.match(/changeXid\s+Unsupported\("xid8"\) @default\(dbgenerated\("'0'::xid8"\)\) @map\("change_xid"\)/g) || []).length, 2);
});
