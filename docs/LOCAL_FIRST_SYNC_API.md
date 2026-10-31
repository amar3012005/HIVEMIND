# Local-first sync reads (Control)

Apps that keep a local copy read what changed after a cursor instead of reloading lists. These reads are optional parameters on
existing Control endpoints; without `since` each endpoint answers exactly as before. Every read is scoped by the signed-in session
(`orgId`, `userId`), never by request input. The same cursor format and envelope are used by OpenDot (`GET /api/conversations?since=`).

## Parameters

| Parameter | Meaning |
| --- | --- |
| `since` | An earlier `next_cursor`; `start` (or empty) for everything from the beginning; `now` for the current position with no rows. Any other value is a 400 `Invalid cursor`. |
| `limit` | Page size, 1 to 200, default 100. Anything else is a 400 `Invalid limit`. |

Reply envelope: `{ items, deleted, next_cursor, has_more }` (the bell adds `unread`). Ask again with `next_cursor` while `has_more` is
true; store `next_cursor` once it is false. A cursor is opaque. `revision` on each item is a decimal string that grows each time that
row is written; compare as integers, the higher revision wins. To start: call with `since=now`, keep that cursor, then load the full
state (`since=start` pages or the existing list). Changes made during the load are replayed from the kept cursor; applying one twice is harmless.
A transaction that was still open when a page was read is delivered by a later page; a cursor never skips it.

## Endpoints

### `GET /v1/workspace/notifications?since=&limit=`

The bell: lifecycle notices and Runtime attention, the same rows as the unparameterised list. Items have the stored fields
`{ id, orgId, userId, type, title, body, resourceType, resourceId, data, dedupeKey, readAt, createdAt, revision }`. A notification that was
read, or re-raised under the same `dedupeKey`, comes back as an item with its new `readAt` and a larger `revision`. `unread` is the current
unread count. `deleted` is always empty: notifications are not deleted one by one, and erasing an account wipes the client store by scope.

### `GET /v1/employees?since=&limit=`

The roster the caller may see (organization administrators see all, others see organization-wide, their teams' and their own employees),
as `{ items, deleted, next_cursor, has_more }`. Items have the same public fields as the list (with Hyper state) plus `revision`.
`deleted` entries are `{ id, revision, deletedAt, reason }` with `reason` `removed` (employee deleted) or `archived` (drop it from the roster;
unarchiving brings it back as an item). Not in the feed: Hyper live state that changes without the employee row changing, and visibility lost
because a person left a team; reload `GET /v1/employees` on sign-in and when the app returns to the foreground.

## Storage

Migration `20261031100000_sync_change_feed` (manual SQL release procedure; PostgreSQL 13 or newer) adds `change_xid xid8` to
`workspace_notifications` and `digital_employees`, stamped by trigger with the writing transaction, the `digital_employee_tombstones` table
(organization and employee ids and the time only), and indexes. The columns have a constant default, so no table is rewritten.
Removing an organization leaves no tombstones. Tombstones are not pruned yet.
