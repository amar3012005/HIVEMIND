# CRM integration demo

This task adds opt-in integration to the prepared AppSpec infrastructure. Production remains unchanged.

## Source branches

- Core: `codex/crm-integration-demo-20261006` in HIVEMIND.
- Harness: `codex/crm-native-integration-20261006`, commit `ad2b73390d` (integration plus complete fixture configuration).
- Da Vinci: `codex/crm-workspace-demo-20261006`, commit `c82bdc29` (recorded by the parent gitlink).

## Implemented

Core mounts `/api/app-runtime/apps` behind existing authenticated identity when
`HIVE_APP_RUNTIME_ENABLED=true`. It uses direct `pg` transactions and rejects scoped project,
team, container and service credentials for the organization-wide V1 policy. The native
Harness gateway uses verified runner claims, live membership and an exact route allowlist.

CRM storage does not require Prisma. The lazy CRM pool is capped at five connections with
bounded checkout/query/transaction timeouts. Set `HIVE_APP_RUNTIME_DATABASE_URL` to a restricted
credential for the same PostgreSQL database containing platform identity; absent that setting,
it uses `DATABASE_URL`. Every CRM transaction rejects superuser/BYPASSRLS roles. Platform identity
and other existing services retain Prisma. `prisma-transaction.js` and its driver demonstration
are historical compatibility evidence and are no longer mounted by the CRM server route.

The initial SQL migration can be applied with `psql -v ON_ERROR_STOP=1 -f
core/prisma/migrations/20261005100000_app_runtime_infrastructure/migration.sql` against the
approved preview database. Coordinate with the platform migration ledger to prevent applying
the same migration twice. No Prisma generator or customer-specific migrations are needed for
ordinary CRM fields. Do not apply this to production without the separate release approval.

The optional native Cordis App Builder package registers nine typed tools and a progressive
`create-crm` skill in the existing Runtime/HyperAgents composition. It does not create another
runner or replace the agent loop. Authoring remains in those conversations.

Da Vinci exposes `/hivemind/app/crm` when `REACT_APP_HIVE_APP_RUNTIME_ENABLED=true`.
Your CRM renders published definitions, tables, Kanban, record details, local-field edits,
loaded-record filtering, fullscreen and existing workflow receipts. It does not run workflows.

## Evidence

`crm-demo-evidence/` contains synthetic local database, native-tool and Prisma reports,
and a renderer screenshot. These cover actual PostgreSQL migration, non-BYPASSRLS roles,
two organizations, permissions/revocation, idempotent replay, version conflicts, published
projections, the signed gateway and the actual Prisma 5.22 driver. Workflow receipts are
artificial fixtures; they are not evidence of connector or workflow execution.

Local scripts `core/scripts/crm-demo.mjs` and `crm-prisma-demo.mjs` refuse non-loopback
or non-demo databases. The database script requires a fresh empty database and never drops
existing objects. They must not be pointed at production.

## Integration sequence

1. Review the three task branches and the frontend gitlink together.
2. Apply `20261005100000_app_runtime_infrastructure` in preview through the existing migration process.
3. Verify preview database role/grants and organization isolation with the full identity schema.
4. Release Core and a compatible Harness artifact; explicitly enable the server feature flag.
5. Build/release the matching Da Vinci revision with its frontend flag enabled.
6. Exercise authenticated Runtime authoring, preview, publish, record editing and Your CRM in preview.
7. Release to production only after separate approval and the existing release-owner checks.

## Remaining boundaries

Full production-server authentication, production database grants, scheduled-agent authority
restoration and the complete authenticated application shell were not proven by the local fixture.
Harness's normal pre-push gate passed the host build and client type check. Frontend production
builds and deployment artifact checks remain release checks. V1 permissions are organization-wide;
team, record-owner and field privacy are not implemented. Connector synchronization, workflow
execution, relationship title resolution/drilldown and dedicated `@create CRM` UI remain future work.
