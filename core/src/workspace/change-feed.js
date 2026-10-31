/**
 * Change feed for local-first clients: rows changed after an opaque cursor, plus tombstones, in bounded pages.
 *
 * Rows carry `change_xid`, the id of the transaction that last wrote them (migration 20261031100000_sync_change_feed).
 * A page only returns rows below the snapshot horizon (`pg_snapshot_xmin`), so a transaction that is still open when the
 * page is read cannot be skipped by a later page. The cursor is `base64url({"v":1,"x":"<xid>","i":"<id>"|null})`.
 * `revision` in every item is `change_xid` as a decimal string; it grows each time that row is written.
 * The same cursor format and envelope are used by the OpenDot feed (`GET /api/conversations?since=`).
 */

export const CHANGE_PAGE_DEFAULT = 100;
export const CHANGE_PAGE_MAX = 200;
const START = Object.freeze({ xid: '0', id: null });

export function encodeChangeCursor({ xid, id }) {
  return Buffer.from(JSON.stringify({ v: 1, x: String(xid), i: id })).toString('base64url');
}

/**
 * Read a `since` value: `start` (or empty) is the beginning, `now` is the current position without rows.
 * @returns {{xid:string,id:string|null}|'now'|null} The cursor, `'now'`, or null when the value is not one this server issued.
 */
export function decodeChangeCursor(value) {
  if (value === '' || value === 'start') return START;
  if (value === 'now') return 'now';
  if (typeof value !== 'string' || value.length > 400 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed?.v !== 1 || typeof parsed.x !== 'string' || !/^[0-9]{1,19}$/.test(parsed.x)) return null;
    if (parsed.i !== null && (typeof parsed.i !== 'string' || parsed.i.length > 200)) return null;
    return { xid: parsed.x, id: parsed.i };
  } catch {
    // The text is not base64url JSON.
    return null;
  }
}

/**
 * Read `since` and `limit` from a request URL.
 * @param {URL} url
 * @returns {{cursor:{xid:string,id:string|null}|'now',limit:number}|{error:string}}
 */
export function readChangeRequest(url) {
  const cursor = decodeChangeCursor(url.searchParams.get('since') ?? '');
  if (cursor === null) return { error: 'Invalid cursor' };
  const raw = url.searchParams.get('limit');
  if (raw === null) return { cursor, limit: CHANGE_PAGE_DEFAULT };
  if (!/^[0-9]{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > CHANGE_PAGE_MAX) return { error: 'Invalid limit' };
  return { cursor, limit: Number(raw) };
}

async function horizonOf(prisma) {
  const rows = await prisma.$queryRawUnsafe('SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon');
  return String(rows[0].horizon);
}

/** Merge live rows and tombstones (each fetched with `limit + 1`, ordered) into one page of at most `limit` entries. */
export function mergeChangePage(rows, tombstones, limit, horizon) {
  const order = (a, b) => {
    const ax = BigInt(a.entry.feed_revision), bx = BigInt(b.entry.feed_revision);
    if (ax !== bx) return ax < bx ? -1 : 1;
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  };
  const tagged = [
    ...rows.map(entry => ({ live: true, entry: { ...entry, id: String(entry.id) } })),
    ...tombstones.map(entry => ({ live: false, entry: { ...entry, id: String(entry.id) } })),
  ].sort(order);
  const hasMore = tagged.length > limit;
  const page = tagged.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.filter(item => item.live).map(item => item.entry),
    tombstones: page.filter(item => !item.live).map(item => item.entry),
    nextCursor: encodeChangeCursor(hasMore && last ? { xid: last.entry.feed_revision, id: last.entry.id } : { xid: horizon, id: null }),
    hasMore,
  };
}

/** SQL predicate: rows of `alias` written below the horizon and after the cursor (`xid`, `id`) in the `(change_xid, id)` order. */
function after(alias, xid, id, horizon) {
  return `${alias}.change_xid < ${horizon}::text::xid8 AND (${alias}.change_xid > ${xid}::text::xid8 OR (${alias}.change_xid = ${xid}::text::xid8 AND (${id}::text IS NULL OR ${alias}.id::text COLLATE "C" > ${id}::text)))`;
}

/** The reply to `since=now`. */
export async function changeHead(prisma, extra = {}) {
  return { ...extra, items: [], deleted: [], next_cursor: encodeChangeCursor({ xid: await horizonOf(prisma), id: null }), has_more: false };
}

const iso = value => (value instanceof Date ? value.toISOString() : value ?? null);

/**
 * Bell notifications of one person (lifecycle and Runtime attention, as `GET /v1/workspace/notifications`) that changed after the cursor.
 * Notifications are never deleted one by one, so `deleted` is always empty; a read notification comes back as an item with `readAt` set.
 * @returns {Promise<{items:object[],deleted:[],unread:number,next_cursor:string,has_more:boolean}>}
 */
export async function workspaceNotificationChanges(prisma, { orgId, userId, cursor, limit }) {
  if (cursor === 'now') return changeHead(prisma, { unread: await unreadCount(prisma, orgId, userId) });
  const horizon = await horizonOf(prisma);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT n.id, n.org_id, n.user_id, n.type, n.title, n.body, n.resource_type, n.resource_id, n.data, n.dedupe_key, n.read_at, n.created_at,
            n.change_xid::text AS feed_revision
       FROM hivemind.workspace_notifications n
      WHERE n.org_id = $1::uuid AND n.user_id = $2::uuid
        AND (n.type LIKE 'lifecycle.%' OR n.type = 'runtime.attention')
        AND ${after('n', '$3', '$4', '$5')}
      ORDER BY n.change_xid, n.id::text COLLATE "C"
      LIMIT $6`,
    orgId, userId, cursor.xid, cursor.id, horizon, limit + 1);
  const page = mergeChangePage(rows, [], limit, horizon);
  return {
    items: page.rows.map(row => ({
      id: row.id, orgId: row.org_id, userId: row.user_id, type: row.type, title: row.title, body: row.body,
      resourceType: row.resource_type, resourceId: row.resource_id, data: row.data, dedupeKey: row.dedupe_key,
      readAt: iso(row.read_at), createdAt: iso(row.created_at), revision: row.feed_revision,
    })),
    deleted: [],
    unread: await unreadCount(prisma, orgId, userId),
    next_cursor: page.nextCursor,
    has_more: page.hasMore,
  };
}

async function unreadCount(prisma, orgId, userId) {
  return prisma.workspaceNotification.count({
    where: { orgId, userId, OR: [{ type: { startsWith: 'lifecycle.' } }, { type: 'runtime.attention' }], readAt: null },
  });
}

/**
 * Employees of the roster the caller can see (the rule of `GET /v1/employees`) that changed after the cursor.
 * An employee that was removed or archived arrives in `deleted`; unarchiving brings it back as an item.
 * Visibility lost without a change to the employee (a person leaving a team) is not in the feed; clients reload the roster on sign-in.
 * @param {object} args
 * @param {string[]} args.teamIds Teams the caller may see; ignored for organization administrators.
 * @param {boolean} args.isOrgAdmin
 * @param {(ids:string[])=>Promise<object[]>} args.load Loads the public employee fields for these ids, scoped to the organization.
 * @returns {Promise<{items:object[],deleted:object[],next_cursor:string,has_more:boolean}>}
 */
export async function employeeRosterChanges(prisma, { orgId, userId, teamIds, isOrgAdmin, cursor, limit, load }) {
  if (cursor === 'now') return changeHead(prisma);
  const horizon = await horizonOf(prisma);
  const [rows, tombstones] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT e.id, e.archived_at, e.change_xid::text AS feed_revision
         FROM hivemind.digital_employees e
        WHERE e.org_id = $1::uuid
          AND ($2::boolean OR e.scope = 'organization' OR (e.scope = 'team' AND e.team_id = ANY($3::text[]::uuid[])) OR e.created_by = $4::uuid)
          AND ${after('e', '$5', '$6', '$7')}
        ORDER BY e.change_xid, e.id::text COLLATE "C"
        LIMIT $8`,
      orgId, Boolean(isOrgAdmin), teamIds ?? [], userId, cursor.xid, cursor.id, horizon, limit + 1),
    prisma.$queryRawUnsafe(
      `SELECT t.id, t.deleted_at, t.change_xid::text AS feed_revision
         FROM hivemind.digital_employee_tombstones t
        WHERE t.org_id = $1::uuid AND ${after('t', '$2', '$3', '$4')}
        ORDER BY t.change_xid, t.id::text COLLATE "C"
        LIMIT $5`,
      orgId, cursor.xid, cursor.id, horizon, limit + 1),
  ]);
  const page = mergeChangePage(rows, tombstones, limit, horizon);
  const live = page.rows.filter(row => row.archived_at == null);
  const loaded = new Map((live.length ? await load(live.map(row => row.id)) : []).map(employee => [employee.id, employee]));
  const items = [];
  const deleted = page.tombstones.map(row => ({ id: row.id, revision: row.feed_revision, deletedAt: iso(row.deleted_at), reason: 'removed' }));
  for (const row of page.rows) {
    if (row.archived_at != null) { deleted.push({ id: row.id, revision: row.feed_revision, deletedAt: iso(row.archived_at), reason: 'archived' }); continue; }
    const employee = loaded.get(row.id);
    if (employee) items.push({ ...employee, revision: row.feed_revision });
  }
  return { items, deleted, next_cursor: page.nextCursor, has_more: page.hasMore };
}
