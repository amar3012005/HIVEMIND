# Core row-level security: staging runbook (stage 1, memories)

Status: staging only. Nothing here runs by default. Production enablement is AMAR's decision and is out of scope. Design: [core-rls-tenant-context-design-20261024.md](core-rls-tenant-context-design-20261024.md). Audit: security audit 2026-10-24, finding 08 F1 (inert RLS) and F2 (keyword fallback).

## What ships in the code

- `core/src/db/tenant-context.js`: `withTenant(prisma, { orgId, userId }, fn)` for Prisma and `withTenantPg(pool, { orgId, userId }, fn)` for raw `pg` pools. Each opens a transaction, first runs `SELECT set_config('app.current_org_id', $1, true), set_config('app.current_user_id', $2, true)`, then runs `fn` on the transaction client. `true` makes both values transaction-local, so they are discarded at `COMMIT`/`ROLLBACK` and cannot leak to the next request on a pooled connection. The session-level `set_app_context()` in `schema.sql` is not used.
- Flag `HIVEMIND_RLS_TENANT_CONTEXT` (default off; on only for `true` or `1`). Off: every helper calls `fn` on the original client and issues no statement. `HIVEMIND_RLS_TX_TIMEOUT_MS` (default 30000) sets the Prisma interactive-transaction timeout for routed reads.
- Personal-tier fix in the keyword (FTS) lane, independent of the flag: the non-personal legacy scope now adds `AND (m.scope <> 'personal' OR m.user_id = $user::uuid)`, so another member's personal memories no longer match an org-wide keyword search. The predicate lives in `core/src/memory/fts-scope-where.js`.
- Staged SQL, not applied by `prisma migrate deploy`: `core/prisma/staged/20261024_core_rls_memories_force/up.sql` and `down.sql`.

## Coverage with the flag on

Covered, all in `core/src/memory/prisma-graph-store.js` and only for orgs whose memory lives in central Postgres:

- `searchMemories`: the FTS query, the trigram fallback query and the Prisma token-similarity fallback, each in its own tenant transaction (an FTS error rolls back only its own transaction, so the fallback still runs).
- `listMemories` (rows and count in one transaction), `listLatestMemories`, `getMemoryScoped`.
- Writes through `advisoryLock(userId, fn, orgId)` (the graph-engine ingest path) and `transaction(fn, orgId, userId)`: the context is set as the first statement of the transaction the store opens. `transaction()` falls back to `currentOrg()` / `currentUser()` from the request context when no ids are passed.

Not covered (these will return zero rows, or fail `INSERT`/`UPDATE`, on `memories` when Core runs as `hivemind_app`):

- `.amr`, remote-agent and self-host (customer Postgres) orgs. They are skipped on purpose: a central `$transaction` would bypass their routing.
- Other `PrismaGraphStore` methods: `getMemory`, `getMemories` (vector-lane hydration), `updateMemory` and `deleteMemory` outside a store transaction, `hardDeleteMemories`, `listRelationships`, `getRelatedMemories`, relationship and metadata writers.
- About 70 other files in `core/src` that read or write `memories` directly, including `server.js`, `persisted-retrieval.js`, `recall-router.js`, `tier-hydrate.js`, `bi-temporal.js`, connectors, the cognition and dream loops, erasure, admin reindex and MCP hosted service.
- Background workers (maintenance, sidecar, schedulers). They have no request principal; the explicit system path of design stage 3 is not built yet.
- Raw `pg` pools (`external/audit/*`, `app-runtime/postgres-runtime.js`, `hq-runtime/event-bus.js`, `vector/mneme/embedded-agent.mjs`). `withTenantPg` exists for them; none is routed in this change.
- All legacy tables other than `memories`; they get a pass-through policy for `hivemind_app` only (see below).

## Known policy mismatches to expect

- Two `memories` policy texts exist. `prisma/migrations/001_initial_schema/up.sql` admits `user_id = current user OR org_id = current org`. `src/db/schema.sql` admits the user's rows, org rows with `visibility IN ('organization','public')`, and every `visibility = 'public'` row from any tenant. Check which one is live (query 3). Neither reads `memories.scope`, which is what the application uses for project and team tiers, so under the `schema.sql` variant other members' project/team memories with `visibility = 'private'` are hidden from `hivemind_app` even though the application allows them.
- `organizations`, `user_organizations`, `relationships` and `audit_logs` have `ENABLE ROW LEVEL SECURITY` and no policy in any Prisma migration or in `schema.sql`; `vector_embeddings` has one only in `schema.sql`. A non-owner role would see no rows of those tables at all. `up.sql` therefore adds `<table>_hivemind_app_staged_passthrough` (`TO hivemind_app USING (true)`) on each legacy RLS table except `memories`. Those policies apply to `hivemind_app` only and keep today's application-predicate isolation for those tables.
- Newer tables (`harness_*`, `app_runtime_*`, `runtime_administrator_messages`, connected-app receipts) are already `FORCE`d with `app.hivemind_*` policies. Under a superuser owner those policies are bypassed today, so any Core path that touches them without setting `app.hivemind_*` will also start failing as `hivemind_app`. Record each such denial.

## 1. Preconditions (staging database only)

Connect with the staging migration (owner) URL. Never run any of this against production.

```sql
SELECT current_database(), current_user, rolsuper, rolbypassrls
FROM pg_roles WHERE rolname = current_user;
```

Record the result. If the owner is a superuser or `BYPASSRLS`, `FORCE` has no effect on it; the enforcement comes from moving the service to `hivemind_app`.

## 2. Create the role and FORCE memories

```sh
psql "$STAGING_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f core/prisma/staged/20261024_core_rls_memories_force/up.sql
```

The role is created `NOLOGIN`. Give it a login and a password interactively, so the password never appears in shell history, logs or this repository:

```sql
ALTER ROLE hivemind_app LOGIN;
\password hivemind_app
```

Store the password in the staging secret store only.

## 3. Point a staging Core at the role

- Keep `DATABASE_URL` on the owner role for `prisma migrate deploy` and for every worker process (maintenance, sidecar, schedulers), since system paths are not built yet.
- For the staging API service only, set its database URL to the same host and database with user `hivemind_app` and the stored password, keeping `?schema=hivemind` and the existing pool parameters. Use a staging env override; do not edit `infra/docker-compose.hetzner.yml` for this.
- Do not run `prisma migrate deploy` with the `hivemind_app` URL; it has no DDL rights. Pass the owner URL explicitly to the migration job.

## 4. Turn on the flag

Set `HIVEMIND_RLS_TENANT_CONTEXT=true` on the staging API service and restart it. Optionally set `HIVEMIND_RLS_TX_TIMEOUT_MS`. With the flag off and the service on `hivemind_app`, every `memories` query sees no tenant context and fails closed; use that combination only to confirm fail-closed behaviour.

## 5. Verification queries

Run in `psql` as `hivemind_app` unless stated, after `\set org_a '<dummy org uuid>'` and `\set user_a '<dummy user uuid>'`; use two dummy organizations with one dummy member each, plus a second member in org A with one `scope = 'personal'` memory.

1. Role is not privileged:
   ```sql
   SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = current_user;
   ```
   Expect `hivemind_app`, `f`, `f`, `t`.
2. Force state (as either role):
   ```sql
   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
   WHERE relnamespace = 'hivemind'::regnamespace AND relrowsecurity ORDER BY relname;
   ```
   Expect `memories` with `relforcerowsecurity = t`.
3. Live `memories` policy text:
   ```sql
   SELECT polname, polroles::regrole[], pg_get_expr(polqual, polrelid) AS using_expr
   FROM pg_policy WHERE polrelid = 'hivemind.memories'::regclass;
   ```
4. RLS tables that deny everything to `hivemind_app` (should list none of the legacy tables after `up.sql`):
   ```sql
   SELECT c.relname FROM pg_class c
   WHERE c.relnamespace = 'hivemind'::regnamespace AND c.relrowsecurity
     AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
       AND (p.polroles = '{0}' OR 'hivemind_app'::regrole = ANY (p.polroles)));
   ```
5. No context fails closed:
   ```sql
   BEGIN; SELECT count(*) FROM hivemind.memories WHERE visibility IS DISTINCT FROM 'public'; ROLLBACK;
   ```
   Expect `0`.
6. Context for org A never shows org B:
   ```sql
   BEGIN;
   SELECT set_config('app.current_org_id', :'org_a', true), set_config('app.current_user_id', :'user_a', true);
   SELECT count(*) FROM hivemind.memories
   WHERE NOT (user_id = :'user_a'::uuid OR org_id = :'org_a'::uuid) AND visibility IS DISTINCT FROM 'public';
   COMMIT;
   ```
   Expect `0`.
7. No pooled leak: in the same session right after step 6,
   ```sql
   SELECT current_setting('app.current_org_id', true), current_setting('app.current_user_id', true);
   ```
   Expect empty or NULL.
8. Signed-in canaries against the staging API as dummy users: save a memory, keyword recall (exact term), semantic recall, memory list and count, open one memory, and an org-wide keyword search by member 2 that must not return member 1's personal memory. Also run chat, connectors, erasure and admin canaries and record every denial (`permission denied`, `new row violates row-level security policy`, unexpected empty results) with its call site.
9. Unit tests in the code: `cd core && node --test tests/unit/core-rls-tenant-context.test.js tests/unit/fts-scope-personal-tier.test.js tests/unit/prisma-graph-store-tenant-context.test.js` (the last one imports `@prisma/client` and needs installed dependencies).

## 6. Rollback

1. Set `HIVEMIND_RLS_TENANT_CONTEXT=false` (or remove it) on the staging API service.
2. Point the staging API service back at the previous owner database URL and restart it. Confirm with query 1 that it no longer connects as `hivemind_app`.
3. With the same migration role that ran `up.sql`:
   ```sh
   psql "$STAGING_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f core/prisma/staged/20261024_core_rls_memories_force/down.sql
   ```
   This sets `memories` back to `NO FORCE ROW LEVEL SECURITY` (ENABLE stays, as before), drops the pass-through policies, revokes the grants and drops `hivemind_app`. `DROP ROLE` fails while a session is still connected as `hivemind_app`; end those sessions first.
4. Remove the stored `hivemind_app` password from the staging secret store.

The code change needs no rollback for the flag: with the flag off it issues no extra statement. The keyword-fallback personal-tier fix stays; reverting it would reopen audit 08 F2.

## Next stages (separate PRs)

Route the uncovered memory paths and the system path for workers, then move the legacy policies to `app.hivemind_*` and `scope`-aware tiers, then replace each pass-through policy with a real one and `FORCE` that table, as in the design note.
