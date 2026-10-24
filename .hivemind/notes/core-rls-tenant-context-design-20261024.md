# Core row-level security: tenant context design and staged rollout

Status: design only (security audit 2026-10-24, finding 08 F1). No migration, policy or role change ships with this note, because enabling enforcement on the legacy tables without the steps below would fail closed on every unscoped query and take Core down.

## Current state (singulance-main)

- Legacy tables (`users`, `organizations`, `user_organizations`, `platform_integrations`, `memories`, `relationships`, `vector_embeddings`, `sessions`, `sync_logs`, `audit_logs`) use `ENABLE ROW LEVEL SECURITY` without `FORCE` (`core/src/db/schema.sql`, `core/prisma/migrations/001_initial_schema/up.sql`). Their policies read `app.current_user_id` / `app.current_org_id`. No Core code sets either variable, so these policies never constrain the table owner and isolation rests on application predicates alone.
- `set_app_context()` in `schema.sql` sets those variables with `set_config(..., FALSE)`, which is session-level. On a pooled connection (Prisma, `pg.Pool`) a session-level value leaks to the next request that borrows the connection. It must not be adopted as written; nothing calls it today.
- Newer tables already follow a working pattern: `harness_sessions*`, `harness_dream_*`, `runtime_administrator_messages`, the app-runtime tables and connected-app receipts are `FORCE`d and keyed on `app.hivemind_org_id` / `app.hivemind_user_id`, set transaction-locally with `SELECT set_config('app.hivemind_org_id',$1,true), set_config('app.hivemind_user_id',$2,true)` inside `prisma.$transaction` (for example `core/src/harness-chat/organization-agent-access.js`, `core/src/employees/native-lifecycle.js`).
- Core connects with `POSTGRES_USER` (`infra/docker-compose.hetzner.yml`). In the official Postgres image that role is a superuser, and superusers and `BYPASSRLS` roles skip every policy, `FORCE` included. Owner check required: `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;` on the production Core connection.

## Target design

1. One variable convention. Legacy policies move from `app.current_*` to `app.hivemind_org_id` / `app.hivemind_user_id`, so every table reads the same transaction-local context. Policies cast with `NULLIF(current_setting(name, true), '')::uuid`, so an unset context matches no rows.
2. One tenant-scoped executor. Add `withTenant(prisma, { orgId, userId }, fn)` in `core/src/db/` that opens `prisma.$transaction`, runs the two `set_config(..., true)` calls first, and passes the transaction client to `fn`. Values are transaction-local, so they are discarded at `COMMIT`/`ROLLBACK` and cannot leak through the pool. Request handlers obtain `orgId`/`userId` only from the authenticated principal, never from the body. Raw `pg` paths use the same helper over `BEGIN`/`COMMIT` with `release()` in `finally`, following Runtime's `session-persistence-postgres` transaction helper.
3. Explicit system paths. Schedulers, migrations, erasure and cross-tenant admin reads run under a separate role or set an explicit, audited flag (as Runtime's scheduler does with `app.hivemind_scheduler`). Request paths must never be able to set it.
4. `FORCE ROW LEVEL SECURITY` on every tenant table, so the owning role is constrained too.
5. Non-owner runtime role. Create `hivemind_app` with `NOSUPERUSER NOBYPASSRLS NOCREATEROLE`, grant DML on the `hivemind` schema, and keep table ownership and DDL with a separate migration role (`DATABASE_URL` for `prisma migrate deploy`, `HIVEMIND_APP_DATABASE_URL` for the services). `memories` keeps its `visibility = 'public'` arm only if public cross-tenant visibility is an intended product feature; otherwise remove it.

## Staged rollout

Each stage is a separate PR and release, verified before the next.

1. Instrument. Ship `withTenant` and route new code through it. Add a test-only Postgres fixture with two dummy organizations that asserts a query with no context returns zero rows from either, and that a context for org A never returns org B rows.
2. Shadow policies. Create the `app.hivemind_*` policies on the legacy tables alongside the old ones, still without `FORCE`, while the services keep the owner role. Nothing is enforced yet. Log (do not fail) where request paths touch legacy tables outside `withTenant`, using a statement-level check in staging.
3. Migrate call sites. Move legacy-table reads and writes into `withTenant`, highest-risk first: `memories` and the FTS search paths, `platform_integrations`, `sessions`, `sync_logs`, `relationships`, `vector_embeddings`. Introduce the explicit system path for background workers.
4. Staging enforcement. In staging only, run the services as `hivemind_app` and `FORCE` the legacy tables. Run the full API and integration suites plus signed-in canaries for chat, recall, connectors, erasure and admin. Fix every denial.
5. Production enforcement, one table group at a time. Switch production services to `hivemind_app` first (keeping no `FORCE`), then `FORCE` one group per release with the previous state recorded as the rollback (`ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` and the old role URL). Watch error rates and empty-result anomalies for each group before the next.
6. Retire the old policies and `set_app_context()`.

## Acceptance

- The two-organization fixture passes against the production schema and role definitions.
- `pg_roles` shows the production service role is neither superuser nor `BYPASSRLS`.
- `SELECT relname FROM pg_class WHERE relrowsecurity AND NOT relforcerowsecurity AND relnamespace = 'hivemind'::regnamespace` returns no tenant tables.
- No request-path call site sets the system flag.
