// Runs the change feed against a throwaway Postgres 13+ with the migration applied to the columns it touches.
// Skips without SYNC_PG_URL (for example postgresql://user:pass@127.0.0.1:5432/scratch; the database is rewritten).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { decodeChangeCursor, employeeRosterChanges, workspaceNotificationChanges } from '../../src/workspace/change-feed.js';

const url = process.env.SYNC_PG_URL;
const skip = url ? false : 'SYNC_PG_URL not set';
const pool = url ? new pg.Pool({ connectionString: url, max: 4 }) : null;

const prisma = {
  $queryRawUnsafe: async (sql, ...args) => (await pool.query(sql, args)).rows,
  workspaceNotification: { count: async ({ where }) => Number((await pool.query(
    "SELECT count(*) FROM hivemind.workspace_notifications WHERE org_id=$1 AND user_id=$2 AND read_at IS NULL AND (type LIKE 'lifecycle.%' OR type='runtime.attention')", [where.orgId, where.userId])).rows[0].count) },
};

async function drain(run) {
  const seen = { items: [], deleted: [] };
  let cursor = { xid: '0', id: null }, pages = 0;
  for (;;) {
    const page = await run(cursor);
    seen.items.push(...page.items); seen.deleted.push(...page.deleted); pages += 1;
    cursor = decodeChangeCursor(page.next_cursor);
    if (!page.has_more) return { ...seen, cursor, pages };
    assert.ok(pages < 50);
  }
}

test('pg: migration, notifications, roster, tombstones, horizon and isolation', { skip }, async () => {
  await pool.query(`
    DROP SCHEMA IF EXISTS hivemind CASCADE; CREATE SCHEMA hivemind;
    CREATE TABLE hivemind.organizations (id uuid PRIMARY KEY);
    CREATE TABLE hivemind.workspace_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, user_id uuid NOT NULL,
      type varchar(80) NOT NULL, title varchar(180) NOT NULL, body text, resource_type varchar(80), resource_id varchar(128),
      data jsonb NOT NULL DEFAULT '{}', dedupe_key varchar(200), read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE hivemind.digital_employees (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
      team_id uuid, scope varchar(20) NOT NULL DEFAULT 'team', created_by uuid NOT NULL, name text NOT NULL, archived_at timestamptz);
    INSERT INTO hivemind.digital_employees (org_id, created_by, name) SELECT gen_random_uuid(), gen_random_uuid(), 'x' WHERE false;`);
  const migration = await readFile(new URL('../../prisma/migrations/20261031100000_sync_change_feed/migration.sql', import.meta.url), 'utf8');
  // Rows that exist before the migration keep revision 0 and are still returned.
  const org1 = randomUUID(), org2 = randomUUID(), user1 = randomUUID(), user2 = randomUUID(), user3 = randomUUID(), team = randomUUID();
  await pool.query('INSERT INTO hivemind.organizations VALUES ($1),($2)', [org1, org2]);
  const old = (await pool.query("INSERT INTO hivemind.workspace_notifications (org_id,user_id,type,title) VALUES ($1,$2,'runtime.attention','before') RETURNING id", [org1, user1])).rows[0].id;
  await pool.query(migration);
  await pool.query(migration); // idempotent

  const bell = (org, user, limit = 100) => cursor => workspaceNotificationChanges(prisma, { orgId: org, userId: user, cursor, limit });
  const ids = rows => rows.map(row => row.id).sort();

  let all = await drain(bell(org1, user1));
  assert.deepEqual(ids(all.items), [old]);
  assert.equal(all.items[0].revision, '0');

  const insert = (org, user, type, title) => pool.query('INSERT INTO hivemind.workspace_notifications (org_id,user_id,type,title) VALUES ($1,$2,$3,$4) RETURNING id', [org, user, type, title]).then(r => r.rows[0].id);
  const mine = [old];
  for (let i = 0; i < 5; i += 1) mine.push(await insert(org1, user1, i % 2 ? 'lifecycle.email.sent' : 'runtime.attention', 'n' + i));
  const generic = await insert(org1, user1, 'workspace.update', 'generic is not in the bell');
  const otherPerson = await insert(org1, user2, 'runtime.attention', 'other person');
  const otherOrg = await insert(org2, user1, 'runtime.attention', 'other company');

  all = await drain(bell(org1, user1, 2));
  assert.deepEqual(ids(all.items), mine.sort());
  assert.ok(all.pages >= 3);
  for (const forbidden of [generic, otherPerson, otherOrg]) assert.ok(!all.items.some(item => item.id === forbidden));
  assert.deepEqual((await drain(bell(org2, user1))).items.map(item => item.id), [otherOrg]);
  assert.deepEqual((await drain(bell(org1, user3))).items, []);

  // Reading a notification changes it once, with a larger revision.
  const before = all.items.find(item => item.id === mine[1]);
  const settled = all.cursor;
  await pool.query('UPDATE hivemind.workspace_notifications SET read_at = now() WHERE id=$1', [mine[1]]);
  const changed = await bell(org1, user1)(settled);
  assert.deepEqual(changed.items.map(item => item.id), [mine[1]]);
  assert.ok(changed.items[0].readAt);
  assert.ok(BigInt(changed.items[0].revision) > BigInt(before.revision));
  assert.deepEqual((await bell(org1, user1)(decodeChangeCursor(changed.next_cursor))).items, []);
  assert.equal(changed.unread, 5);

  // since=now has no rows and a cursor from which later changes arrive.
  const head = await bell(org1, user1)('now');
  assert.deepEqual(head.items, []);
  const later = await insert(org1, user1, 'runtime.attention', 'later');
  assert.deepEqual((await bell(org1, user1)(decodeChangeCursor(head.next_cursor))).items.map(item => item.id), [later]);

  // A transaction that is still open when a page is read is delivered by a later page.
  const open = await pool.connect();
  await open.query('BEGIN');
  const held = (await open.query("INSERT INTO hivemind.workspace_notifications (org_id,user_id,type,title) VALUES ($1,$2,'runtime.attention','held') RETURNING id", [org1, user1])).rows[0].id;
  const start = await bell(org1, user1)('now');
  const committedFirst = await insert(org1, user1, 'runtime.attention', 'committed first');
  const during = await bell(org1, user1)(decodeChangeCursor(start.next_cursor));
  assert.ok(!during.items.some(item => item.id === held));
  await open.query('COMMIT'); open.release();
  let resume = decodeChangeCursor(start.next_cursor);
  const delivered = [];
  for (let i = 0; i < 4; i += 1) { const page = await bell(org1, user1)(resume); delivered.push(...page.items.map(item => item.id)); resume = decodeChangeCursor(page.next_cursor); }
  assert.ok(delivered.includes(held), 'a late commit must still be delivered');
  assert.ok(delivered.includes(committedFirst));

  // Roster.
  const employee = (org, scope, teamId, creator, name) => pool.query('INSERT INTO hivemind.digital_employees (org_id,scope,team_id,created_by,name) VALUES ($1,$2,$3,$4,$5) RETURNING id', [org, scope, teamId, creator, name]).then(r => r.rows[0].id);
  const eOrg = await employee(org1, 'organization', null, user2, 'org wide');
  const eTeam = await employee(org1, 'team', team, user2, 'team only');
  const eMine = await employee(org1, 'personal', null, user1, 'mine');
  const eOther = await employee(org1, 'personal', null, user2, 'someone else');
  const eForeign = await employee(org2, 'organization', null, user1, 'other company');
  const load = org => async wanted => (await pool.query('SELECT id, name FROM hivemind.digital_employees WHERE org_id=$1 AND id = ANY($2::uuid[])', [org, wanted])).rows;
  const roster = (org, user, extra) => cursor => employeeRosterChanges(prisma, { orgId: org, userId: user, cursor, limit: 2, load: load(org), ...extra });
  assert.deepEqual(ids((await drain(roster(org1, user1, { teamIds: [], isOrgAdmin: false }))).items), [eOrg, eMine].sort());
  assert.deepEqual(ids((await drain(roster(org1, user1, { teamIds: [team], isOrgAdmin: false }))).items), [eOrg, eTeam, eMine].sort());
  assert.deepEqual(ids((await drain(roster(org1, user3, { teamIds: [], isOrgAdmin: true }))).items), [eOrg, eTeam, eMine, eOther].sort());
  assert.deepEqual(ids((await drain(roster(org2, user3, { teamIds: [], isOrgAdmin: true }))).items), [eForeign]);
  assert.deepEqual((await drain(roster(org2, user2, { teamIds: [], isOrgAdmin: false }))).items.map(item => item.id), [eForeign]);

  // Archiving and removing an employee arrive as deleted; removal leaves a tombstone; unarchiving returns it.
  const admin = { teamIds: [], isOrgAdmin: true };
  const base = (await drain(roster(org1, user3, admin))).cursor;
  await pool.query('UPDATE hivemind.digital_employees SET archived_at = now() WHERE id=$1', [eTeam]);
  await pool.query('DELETE FROM hivemind.digital_employees WHERE id=$1', [eOther]);
  const gone = await drain(c => roster(org1, user3, admin)(c.xid === '0' ? base : c));
  assert.deepEqual(gone.deleted.map(item => [item.id, item.reason]).sort(), [[eOther, 'removed'], [eTeam, 'archived']].sort());
  assert.deepEqual(gone.items, []);
  const tombstoneFor = (await drain(roster(org2, user3, admin))).deleted;
  assert.deepEqual(tombstoneFor, [], 'another company never sees a removal');
  await pool.query('UPDATE hivemind.digital_employees SET archived_at = NULL WHERE id=$1', [eTeam]);
  const back = await roster(org1, user3, admin)(gone.cursor);
  assert.deepEqual(back.items.map(item => item.id), [eTeam]);

  // Removing a company removes its employees without leaving tombstones behind.
  await pool.query('DELETE FROM hivemind.organizations WHERE id=$1', [org2]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM hivemind.digital_employee_tombstones WHERE org_id=$1', [org2])).rows[0].n, 0);
  assert.ok((await pool.query('SELECT count(*)::int AS n FROM hivemind.digital_employee_tombstones WHERE org_id=$1', [org1])).rows[0].n >= 1);
});

test('pg: cleanup', { skip }, async () => { await pool.end(); });
