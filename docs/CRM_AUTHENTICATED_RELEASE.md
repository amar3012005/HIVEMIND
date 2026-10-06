# CRM authenticated release candidate — 2026-10-06

## Storage and authoring

The mounted CRM engine uses `pg` directly. Platform authentication retains its existing Prisma
implementation. Customer fields and views are versioned AppSpec metadata; records are JSONB.
Creating or changing a workspace does not run a customer migration or restart a service.

The existing Runtime and HyperAgents author through the native Cordis App Builder tools and
progressive `create-crm` skill. `/hivemind/app/crm` is the published human workspace: Table,
Kanban, Record, local-field edits, filtering, fullscreen, and existing workflow receipts.

## Restricted database contract

Apply `core/prisma/migrations/20261005100000_app_runtime_infrastructure/migration.sql` through
the managed migration job, preserving the platform migration ledger. It is ordinary PostgreSQL
SQL; the CRM engine does not invoke Prisma. The migration owner must differ from the runtime role.

Then run `core/scripts/provision-app-runtime-role.mjs` from the exact immutable Core artifact.
Its managed secret inputs are:

- `CRM_PROVISION_DATABASE_URL`: privileged migration connection to the platform database.
- `HIVE_APP_RUNTIME_DATABASE_PASSWORD`: dedicated CRM password, at least 32 characters.

It provisions `hivemind_app_runtime` with login and no superuser, RLS bypass, role inheritance,
database creation, role creation, or replication. Grants cover seven CRM tables, selected existing
workflow receipt columns, and the fixed membership function. Platform identity writes are denied.
No secret values belong in commits, reports, shell arguments, or model context.

The migration-owned `app_runtime_lock_membership(uuid,uuid)` function returns membership roles
and active status while holding user, organization, and membership locks until transaction end.
It uses explicitly qualified tables, a fixed `pg_catalog` search path, transaction-local identity
checks, and revoked public execution. This preserves revocation serialization without granting
identity UPDATE to the CRM credential.

## Managed activation

1. Reconcile the final employee, Brain, and progressive-history revisions before freezing source.
2. Record current Core, Control, runner images and Worker version for rollback.
3. Apply the additive SQL migration and provision the dedicated role in the coordinated window.
4. Set Core `HIVE_APP_RUNTIME_DATABASE_URL` to that restricted credential using managed secrets.
5. Enable `HIVE_APP_RUNTIME_ENABLED=true` for Core, Control, and the compatible native runner.
6. Build Da Vinci with `REACT_APP_HIVE_APP_RUNTIME_ENABLED=true` and its matching parent gitlink.
7. Release exact pushed immutable artifacts through the existing owners.
8. Perform signed-in Runtime authoring and published CRM canaries using disposable data only.

Native signing uses the existing `HIVE_HARNESS_RUNNER_SERVICE_SECRET`; its service origin is the
existing `HIVEMIND_CONNECTED_RECEIPT_SERVICE_URL`. No second runner, agent profile, or loop is added.

## Verified preview evidence

The preview uses actual Core and Control processes, a complete isolated platform schema, native
persisted API keys, signed Redis session cookies, and the real runner JWT gateway. Identities,
credentials, CRM records, and workflow receipts are synthetic. External SSO login and production
traffic have not been proven by these fixtures.

Evidence owners retain sanitized HTTP, role/lock, native-tool, and frontend reports. The dedicated
role successfully ran CRM operations, rejected identity UPDATE with SQLSTATE `42501`, and held
membership locks so concurrent revocation waited until transaction release. Cross-organization
IDs, forged browser identity headers, project-scoped credentials, invalid signatures, stale
versions, and revoked memberships were rejected by their actual authenticated boundaries.

Committed evidence is in `core/docs/evidence/crm-*-20261006.*`: 30 authenticated HTTP checks,
five role/lock checks, all nine native tools, and authenticated browser views/edit/reload/tenant
switching. Focused CRM tests passed 10/10. The full Core sweep has 124 failures on both untouched
`740bcb7da` and the CRM candidate, with identical failing names; it is not a green full-suite gate.
The browser report separates rendered workspace proof from the follow-up Runtime-entry helper
fix and the pending live authoring-room canary.

The native Schedule PostgreSQL tests also restore org/user/profile/project ownership on cold
delivery and prove project scope is denied before CRM credential/network access.

## Rollback and remaining boundary

Disable the feature flags and restore recorded immutable images/Worker version. Keep the additive
CRM schema and records intact; do not drop published data during application rollback. Retain the
restricted credential for any subsequent recovery, rather than substituting a superuser.

V1 permissions are organization-wide. Connector synchronization, workflow execution, relationship
title resolution, and backfills require their existing governed integration boundaries. The CRM
page renders receipts; it is not a new workflow executor. Production cutover remains coordinated
with the main release owner and its Runtime/employee fixes.
