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

## Runner cutover completed / main Settings placement

User requested deployment after the unsupported drain endpoint was reported.
Used the canonical versioned Compose chain with graceful shutdown (60-second
stop timeout), immutable source checks, and rollback record; no Docker exec or
live code patch. Runner `sha-1f01b7456e` is healthy, restart count zero, and every
sibling container retained its identity. Digest:
`sha256:250d9575c73bf41860eac6d0ad01c6dd0e26625221067e3e8ff956ae2d291cd4`.
Rollback chain is recorded under
`/root/releases/manifests/hyperagents/dreamer-1f01b7456e-graceful`.

The Dreaming switch belongs on `/hivemind/app/settings`, per user clarification,
not a new native toolbar control. Da-vinci `c3518ea0` reuses native admission,
forwards only the exact Dreamer settings endpoint, and exposes the server-derived
admin switch without mounting another Harness runtime. Focused Worker checks: 9
passed. The broader pre-existing Day 0 test expects the old flag key and fails
independently of this change; its feature was not altered.

Cloudflare production Settings deployment completed: Worker version
`533aacff-a09d-447c-b02f-3f5d5a7891f3`, frontend source `c3518ea0`.
Prior Worker version for rollback: `3efc1b82-3a57-4a6f-8508-cb1427c1f0df`.
Authenticated Chrome canary at `https://next.singulancelabs.com/hivemind/app/settings`
shows the Dreaming section, company Flashbacks consent copy, and enabled admin
switch with `aria-checked=false`. Anonymous access returns JSON 401, not SPA HTML.
No toggle was enabled and no production-model dreaming run was started.

## Automation tasks visibility and embedded toolbar

Native source `009b2f522f6a43929441293f9dd5b8f1e144a35d` is pushed on
`codex/dreaming-automation-visibility`. The existing authenticated settings GET
accepts `view=activity` and projects the existing Cloudflare occurrence schedule
plus the latest ten tenant-scoped durable run receipts. Automation tasks renders
this projection through `schedule.manager.external`; it never creates a second
reminder. Settings remains the sole On/Off control. Dispatcher trigger versions
are independent of the settings revision; do not compare these counters.

Each nightly occurrence owns a new Dreamer session pair. Retry and recovery
reuse that occurrence's session/checkpoint. Cross-night continuity comes from
run history and Flashbacks, not an indefinitely growing conversation.

Embedded schedule utilities, mode label, team action, environment and preview
controls now occupy one flex row. Removed the separate fixed utility row and
hardcoded 328px width that could overlap the HIVE-MIND chat label.

Validation: full host/client pre-push typecheck passed; 276 focused tests passed
(one optional live Cloudflare test skipped), then 25 focused conversation/card
checks passed after the toolbar fix. Production switch was observed On before
release; this update preserves the tenant preference.

Runner deployed as `hivemind/harness-chat:sha-009b2f522f`, image ID
`sha256:34e295a2a1b39d80aeecb5184a187af893c318e2cdbee53fabf51de27bcff58d`.
Canonical Compose image-only cutover completed with 60-second graceful timeout;
all sibling container identities unchanged. Rollback/live manifest record:
`/root/releases/manifests/hyperagents/dreaming-automation-009b2f522f`.
Runner healthy, restart count zero; public health returned HTTP 200.

Authenticated Automation tasks canary shows On, next run `2026-10-01 02:00
Europe/Berlin`, status scheduled, and expanded empty history. No setting was
changed and no model run triggered. Existing separately configured task titled
`Nightly HIVE-MIND Dreamer — memory consolidation` remains in the native catalog;
this release neither created nor modified it. Screenshot:
`/tmp/dreaming-automation-live.png` on the release Mac.
Authenticated HIVE-MIND toolbar verification: clock, menu, mode label and preview
control share top=70px (label vertically centered), with roughly 8px gaps and no
intersections. Screenshot `/tmp/hive-toolbar-fixed.png`. No production-model
canary request was sent by this release check.

## Duplicate automation icon and history overlap fix — 2026-10-01

Native source `774bdf370faf2a75a891b2966a2aa7c6d28f2e04` pushed and deployed.
Embedded BRAIN/OS now retain one Automation tasks manager clock; the redundant
current-session catalog clock is suppressed only on embedded routes. Native
standalone catalog behavior remains available. When the right panel opens and
the native floating history rail is present, the center column reserves rail
space. OS history is in the outer sidebar, so it does not add this inset.

74 focused UI checks and full host/client typecheck passed. Image/profile
validation passed. Runner image ID:
`sha256:5dae774b8fb94230508ec110afc05d39ff23ec5452fd79a7239e57baf540c4cf`.
Healthy, restart count zero, public health 200, sibling container IDs unchanged.
Rollback record: `/root/releases/manifests/hyperagents/automation-overlap-774bdf370f`.
Authenticated canary opened the Vercel task in Automation tasks; task data was not
changed. BRAIN right-pane geometry: history right=498px, transcript left=524px,
transcript right=1131px, right pane left=1173px. Header contains one Automation
entry plus More actions and Preview toggle. Screenshot:
`/tmp/automation-layout-fixed.png`. No model request was sent.

## Automation task history visibility — 2026-10-01

Native source `a171784c11dc1f6441e0d93525fc02ebc33e3c1a` hides the floating BRAIN
session rail throughout Automation tasks and selected task details, and hides
OS's portaled history under the same markers. Returning to chat restores history.
Task views remove the conversation rail inset. 356 focused UI checks and full
host/client typecheck passed. Source pushed; release verification follows below.

HQ calendar is a separate local-preview release at `0e3caf9a2f`, documented in
Codex task `Hq-runtime`, not the live production runner. Read-only probe confirms
preview `/api/hivemind/session/establish` returns 405 for an empty ticket;
production returns expected JSON 401. Calendar promotion must start by merging
its native plugin onto the current runner source, then fix selective Worker-first
API routing on the latest preview Worker without replacing unrelated assets.
The HQ record also lists unfinished cross-member projection, run correlation,
owner inbox, and real-model artifact review; resolving routing alone is not E2E.

Deployed `sha-a171784c11`; immutable image ID
`sha256:c7dda631e1b489ce75d400ae2a377e175afccad59963d2c28333036733db6971`.
Profile validation passed. Runner healthy, zero restarts, public health 200;
all sibling container IDs unchanged. Rollback record:
`/root/releases/manifests/hyperagents/automation-history-a171784c11`.
Authenticated BRAIN canary: task list and selected Vercel detail both hide
history; Back to conversation restores it. OS Automation tasks canary: zero
visible session navigation lists. Screenshot `/tmp/automation-history-hidden.png`.
