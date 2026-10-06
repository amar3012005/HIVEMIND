# Server recovery reconciliation — 6 October 2026

The earlier server recovery commit `82a7e418` and its source exports are preserved.
They are superseded for integration by the pushed CRM branches; do not apply the older
six-file Harness patch over the integrated package.

## Reviewed seam

The recovered seam reads only the legacy single `role`, while current Core declares
`roles[]` authoritative and the integrated store uses `effectiveRoles`. Its independent
membership check also lacks the integrated store's deleted-user check and transactional
locking before receipt replay. Retain it as recovery history, not as a second authorization layer.
Current Core's compound membership key is `userId_orgId`; that part of its contract matches.

## Server copies

- `/root/hivemind-crm-server-recovery`: preserved earlier recovery work.
- `/root/hivemind-crm-integration-review`: isolated worktree at Core `664cbb94`.
- `/root/harness-crm-integration-review`: isolated worktree at Harness `ad2b73390d`.
- The integrated Core copy has the frontend gitlink checked out at `c82bdc29`.

## Server verification

A separate `crm-isolated-demo-20261006` container used the existing PostgreSQL image,
loopback port 55449, a 512 MiB memory limit, 0.5 CPU limit and synthetic credentials/data.
The image initialization pre-created an empty schema, so the successful acceptance run
used a separate fresh database created from `template0`.

Actual PostgreSQL 15.7 checks passed: migration, non-superuser/non-BYPASSRLS execution,
two-organization isolation, draft/validate/publish, references, permission denial,
revocation, replay, destructive-change denial, concurrency, published projections,
immutable history and signed gateway. The actual Prisma 5.22 driver checks also passed.
Reports are in `crm-demo-evidence/server-{database,prisma}-report.json`.

The isolated database container is stopped after verification; retained data can be reviewed
by starting that container. The fixture HTTP service was temporary and is no longer listening.
No production service was recreated, no production database migrated and no CRM flag enabled.

## Remaining proof

The full production identity schema/authentication boot, production database role/grants,
scheduled-agent scope restoration and the complete authenticated frontend shell still require
preview acceptance. Native tools and UI were verified locally earlier; copying their source
to the server is not a fresh server-native invocation or browser proof. Connector execution
and workflow execution remain outside this V1 slice.
