# Native Dreamer / Flashbacks release

Changed units: additive PostgreSQL migration, native Harness runner, standalone
Dreamer dispatch Worker. Core, Control Plane and outer frontend binaries are unchanged.

- Migration: `core/prisma/migrations/20260930220000_dsh_dreamer/migration.sql`.
- Native plugin: `@deepseek-ai/dsh-hivemind-dreamer`; source and tests in the Harness repo.
- Dispatcher: `workers/dreamer-dispatch` (Durable Object alarms + Queue + dead-letter Queue).
- Tenant feature starts OFF. Native General settings exposes one admin switch.
- Enabling creates the reserved **Flashbacks** project with `org_visible` policy;
  all company members can read. That standing consent permits direct dream saves
  without individual approvals. OFF cancels work; saved dreams remain.

Native trigger/status endpoints: `/hivemind/dreamer/trigger`,
`/hivemind/dreamer/runs/{id}`. Signed tenant settings: `/hivemind/dreamer/settings`.
Runner environment: `HIVEMIND_DREAM_DISPATCH_URL`, `HIVEMIND_DREAM_ADMIN_TOKEN`,
`HIVEMIND_DREAM_DISPATCH_TOKEN`, `HIVEMIND_DREAM_CALLBACK_TOKEN`.
Dispatcher secrets respectively: `SCHEDULER_ADMIN_TOKEN`, `DSH_DISPATCH_TOKEN`,
`DSH_CALLBACK_TOKEN`. Do not commit secret values. Optional runner model/provider
select a child model; cron/timezone/concurrency remain deployment configuration.

Release only after contract, non-superuser isolation, native delegation/cold
recovery, actual local alarm/Queue/callback, UI and memory regression checks.
Apply the additive migration first, register it through the owning migration
release path, then deploy the exact pushed runner SHA and dispatcher configuration.
Keep all organizations OFF until authenticated verification passes. Record prior
runner image and versioned manifest chain; rollback the runner/config on failure.
Do not drop Flashbacks or ledger tables during rollback.

Current read adapter supports managed hybrid PostgreSQL memory. Unsupported remote
memory residency stays unavailable rather than querying a different tenant store.

## Release evidence — 2026-09-30

- Native source `1f01b7456e288c58aa6b32d1d11b6407594c9896` is pushed.
- 73 focused checks passed, including local Durable Object alarm → Queue →
  native continuable DSH → Flashbacks receipt → terminal callback and cold recovery.
  These use a deterministic model/provider, not a paid production-model canary.
- Parent source promoted through `f7a8e7a1`; additive migration applied through
  the guarded Prisma migration container. Exactly the Dreamer migration was pending.
- Production dispatcher is deployed at
  `https://hivemind-dreamer-dispatch.amarsai2005.workers.dev`; health is ready.
  Distinct service credentials installed; preview is unchanged.
- Candidate `hivemind/harness-chat:sha-1f01b7456e` built on native amd64 and
  image/profile validation passed. Live runner remains `sha-15f83836ea`.
- Runner cutover was aborted before recreation: deployed runner lacks
  `/internal/hivemind/runner-drain-status` (404). Do not bypass the active-turn
  safety check. Prepared override/rollback record exists under
  `/root/releases/manifests/hyperagents/dreamer-1f01b7456e`.
- Production ledger verification: zero enabled tenants. No real dreaming run
  has been triggered. Finish drain verification, runner cutover and authenticated
  live settings/memory canary before claiming complete production availability.
