# Core RLS for tables the runner role can read: findings, blockers and apply runbook

Status: staged, unapplied. Production enablement is AMAR's decision. Owner-plan item 84. Builds on [the design](core-rls-tenant-context-design-20261024.md) and [the memories staging runbook](core-rls-staging-runbook-20261024.md).

## Findings (production, read-only, 2026-10-24)

1. Core and the owner role are the superuser `hivemind_user` (`rolsuper`, `rolbypassrls`). Its queries skip every policy, FORCE included. Enabling RLS on a table therefore changes behavior only for the non-superuser roles: `hivemind_harness_runner`, `hivemind_app_runtime`, `hivemind_broker`.
2. In schema `hivemind`, 27 of 277 tables have RLS enabled, all 27 forced: `harness_*`, `app_runtime_*`, `connected_app_receipts`, `runtime_administrator_messages`. They read `app.hivemind_org_id` / `app.hivemind_user_id` with `NULLIF(current_setting(name, true), '')::uuid`. No other table in `hivemind` has RLS or a policy. `legacy_public.api_keys` has RLS enabled, not forced, and no policy.
3. The legacy tables the earlier design note describes as `ENABLE`d (`memories`, `users`, `organizations`, `user_organizations`, `relationships`, `sessions`, `audit_logs`, ...) have `relrowsecurity = false` and no policy in production. The repository migrations and `schema.sql` do not describe production. `core/prisma/staged/20261024_core_rls_memories_force/up.sql` (PR #751) refuses to run on production: its precondition raises because `hivemind.memories` has no policy.
4. The runner role is not behind tenant RLS for these tables. It holds direct privileges on tables with no RLS, so it reads every organization's rows regardless of the tenant setting:

   | table | runner privileges | has RLS |
   |---|---|---|
   | memories | SELECT | no |
   | relationships | SELECT | no |
   | source_metadata | SELECT | no |
   | usage_events | SELECT | no |
   | users | SELECT | no |
   | organizations | SELECT | no |
   | user_organizations | SELECT | no |
   | projects | SELECT, INSERT, UPDATE | no |
   | project_members | SELECT, INSERT | no |
   | harness_dream_due | SELECT, INSERT, UPDATE | no |
   | account_erasure_operations | column SELECT (7 columns) | no |
   | harness_storage_units | SELECT, INSERT | no (no tenant data: name, version) |

   Views `hivemind_attention_*` are owned by the superuser and filter on `app.hivemind_*` themselves, so they are not affected.
5. `hivemind_app_runtime` has column SELECT on `hq_workflows` (no RLS). `hivemind_broker` has column SELECT on `organizations(id, hosting_mode)` and `api_keys(org_id, key_hash, revoked_at)`; it resolves an API key before any tenant context exists.
6. The remaining ~230 tenant tables are reachable only by the superuser. RLS on them adds no protection until Core stops connecting as a superuser (design stages 4 and 5).

Measured isolation (rolled-back, read-only transaction; `SET LOCAL ROLE hivemind_harness_runner`; `app.hivemind_org_id` = org A, the SINGULANCE org; org B = another existing tenant): the runner saw all 765 memories including all 36 of org B's, all 6243 usage events including org B's 49, and all 23 organizations. The forced-RLS control tables (`harness_sessions`, `harness_dream_runs`) showed 0 rows for org B.

## What this change ships

- `core/prisma/staged/20261024_core_rls_runner_tables/up.sql` (group A): ENABLE + FORCE on `memories`, `relationships`, `source_metadata`, `usage_events`, `projects`, `project_members`, `user_organizations`, `organizations`, `users`, `hq_workflows`, with policies `TO` the specific non-superuser roles that use each table. Two further policies keep today's access unchanged: `hivemind_broker` reads `organizations` unconditionally (column grants limit it to `id, hosting_mode`), and `hivemind_app_runtime` reads `hq_workflows` by organization. The `memories` policy omits the legacy `visibility = 'public'` cross-tenant arm and hides other members' `personal` rows.
- `down.sql`: exact reverse (drop policies, NO FORCE, DISABLE).
- `up-b.sql` / `down-b.sql` (group B): `harness_dream_due`. Blocked, see below.
- `verify.sql`: read-only two-organization check, ends in `ROLLBACK`.
- `core/src/db/tenant-context.js`: with `HIVEMIND_RLS_TENANT_CONTEXT` on, the context now also sets `app.hivemind_org_id` / `app.hivemind_user_id` (transaction-local), next to `app.current_*`. Flag off: no statement, as before.
- Tests: `core/tests/unit/core-rls-runner-tables-sql.test.js` (static checks on the SQL) and the updated `core-rls-tenant-context.test.js`.

Core is unaffected by group A because it connects as the superuser. Group A constrains the runner and the two other roles only.

## Blockers

Runtime runner (role `hivemind_harness_runner`), checked in Runtime-Runner at `cb6fc64ac3`:

- Group A: none found. Every query on the ten group A tables runs inside a transaction that first calls `set_config('app.hivemind_org_id', ..., true)`: `DreamStore.scoped()`, `claim()`, the schedule-postgres `transaction()`/registration/dispatch paths, `ownership-postgres.ts`, `attention.ts` and `organizationAgentScope()`. SECURITY DEFINER functions (`organization_agent_storage_scope`, `reset_*`) are owned by the superuser and are unaffected.
- Group B (`harness_dream_due`), three call sites without context, so `up-b.sql` must wait:
  1. `packages/hivemind/dreamer/src/store.ts` `DreamStore.accept()`: `this.pool.query('SELECT user_id FROM harness_dream_due WHERE org_id=$1')` before `scoped()`.
  2. `packages/hivemind/dreamer/src/index.ts`, the run lookup route: `pool.query` by the `x-hivemind-tenant-id` header.
  3. `packages/hivemind/dreamer/src/index.ts` `tick()`: `pool.query` scan of all organizations.
  Fix: run each in a transaction that sets `app.hivemind_dream_scheduler = 'on'` (as `claim()` does) or the organization context, or move the scan behind a SECURITY DEFINER function.
- `account_erasure_operations`: the runner has column SELECT but no Runtime source reads it. Recommend `REVOKE SELECT ON hivemind.account_erasure_operations FROM hivemind_harness_runner` after confirming with Runtime, rather than RLS (the table has no organization column).

Core (not blocking group A):

- Only `memory/prisma-graph-store.js` calls the tenant-context helpers. About 205 files under `core/src` mention `memories`, 53 mention `user_organizations`. They are safe only while Core connects as the superuser. Moving Core to a non-superuser role (design stage 4) is blocked until each is routed through `withTenant` / `withTenantPg` or an explicit system path exists. PR #751 lists the memory paths.
- The staged `hivemind_app` SQL from PR #751 must be reconciled before use: it assumes legacy policies that production does not have, and it keys on `app.current_*`. Policies in this change are `TO` named roles; extending them to `hivemind_app` is a follow-up.

## Apply runbook (for AMAR's approval)

Run with the owner role (`hivemind_user`) from `singulance-engine`, in a quiet window. `up.sql` takes brief ACCESS EXCLUSIVE locks (`lock_timeout` 5s; it aborts rather than queue). Group A is reversible with `down.sql`.

1. Pre-flight, read-only; record the output.
   ```sql
   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
   WHERE relnamespace = 'hivemind'::regnamespace AND relname IN ('memories','relationships','source_metadata',
     'usage_events','projects','project_members','user_organizations','organizations','users','hq_workflows');
   SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class
     WHERE relnamespace = 'hivemind'::regnamespace AND relname IN ('memories','relationships','source_metadata',
     'usage_events','projects','project_members','user_organizations','organizations','users','hq_workflows'));
   ```
   Expect all `f`/`f` and 0 policies. Confirm the runner role is not privileged: `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'hivemind_harness_runner'` returns `f, f`.
2. Canary before: with the runner's current traffic, note Runtime health and the dreamer/schedule error rate.
3. Apply group A:
   `psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f core/prisma/staged/20261024_core_rls_runner_tables/up.sql`
   The file runs in one transaction; any failure leaves the database unchanged.
4. Verify immediately:
   `psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -v org_a='<org A uuid>' -v org_b='<org B uuid>' -f core/prisma/staged/20261024_core_rls_runner_tables/verify.sql`
   Expect: `ef` for all ten tables; step 2 all 0; step 3 every `orgb_visible` 0 and `orga_visible` equal to org A's real counts; step 4 `0`; step 5 `readable = t`.
5. Canaries after: a signed-in Runtime chat turn, a scheduled-task delivery, a Dreaming read (`recent`/`read`/`walk`), the HQ attention path, and an app-runtime workflow receipt query. Watch runner logs for `permission denied`, `row-level security`, and unexpected empty results for 30 minutes.
6. Rollback at any sign of a denial: `psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f core/prisma/staged/20261024_core_rls_runner_tables/down.sql`. Verify with the pre-flight query (all `f`/`f`, 0 policies).
7. Group B (`up-b.sql`) only after the three Runtime call sites above ship and are deployed.

Core needs no change or restart for group A. The tenant-context flag change is dormant unless `HIVEMIND_RLS_TENANT_CONTEXT` is set.

## Not verified

No scratch Postgres was available locally (no `psql`, no Docker daemon), and nothing was applied anywhere. `up.sql`, `down.sql` and `verify.sql` have not been executed; the policy predicates were evaluated as plain SELECTs in a rolled-back read-only transaction on production (they type-check and return the expected counts). The static tests check structure, not behavior. The first real execution is the apply step above, which is why it is a single transaction with a rollback script and a verify script.
