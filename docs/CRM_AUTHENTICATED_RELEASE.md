# CRM authenticated release — 2026-10-06

## Confirmed production release

This section supersedes the candidate and release-hold notes below. The main release owner
completed managed activation and a signed-in disposable canary; this chat did not duplicate
production model runs or writes.

- Core/Control artifact source: `8cc0aa770a2589b1cefadaa6132e62fc4e742153`.
- Native Harness source: `53a46e6d6f80a5c824ab9d1df78058f74a275e99`; image
  `hivemind/harness-chat:sha-53a46e6d6f-crm`, ID
  `sha256:57b4b7957bfaf1d619642ad467ab55cea5aff013daa6f459d859198d00e49ec2`.
- Frontend source: `559d95b974975bee173ddaa27fff5ae89fb455b4`; parent gitlink promotion
  `f8c564046de8edf909324f9dea14ae0a18035d5f`.
- Worker version: `fc14854d-a856-468d-bf3f-8c2fe088f742`.
- Migration ledger: 214; seven forced-RLS CRM tables and restricted role
  `hivemind_app_runtime`. Dedicated database URL is bound only to Core; provisioning password
  is bound to none of the three services.

Native model discovery was proved through the `apps` capability lease: all nine original
schemas were exposed before authoring. The actual signed-in Runtime published application
`7ccb981c-ed1e-4d80-b29f-19f342c33871`, published version 1, created company record
`b782bbc1-7d74-431e-9b74-b84f5a9a1883`, updated it to version 2 / Qualified, and queried
that saved state again. An initial invalid Kanban spec was rejected before writing and corrected
by the model. No connectors, automations, outreach or Company Brain writes were exercised.

The production Your CRM page rendered the same saved application and record. Table, Kanban,
Record and detail drawer were checked. Repeated `/crm/overview` suffixes recovered to canonical
`/hivemind/app/crm` with the query retained; fullscreen and refresh remained stable with data.
The source-proven loop mechanism was the former relative fallback redirect. The origin of the
first malformed suffix remains unproven.

Release evidence: `/root/releases/manifests/crm-managed-corrected-20261006/release.json`;
local native receipts and live screenshot:
`/tmp/crm-final-activation-20261006/native-live-canary-receipts.json` and
`/tmp/crm-final-activation-20261006/your-crm-live-verified.jpg`.

Verification scope remains precise: organization isolation was checked with two synthetic
organizations in isolated authenticated preview; the production canary used one organization.
Scheduled/background CRM lifecycle and live connector synchronization were not proved.
The inherited Worker Day 0 test expectation mismatch remains outside this routing change.

## Historical candidate and setup notes

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
switching. Focused combined tests passed 18/18 (11 CRM and seven employee checks). The canonical Core
baseline and combined CRM source both have 124 full-suite failures, with identical 117 top-level
failing names; it is not a green full-suite gate. Twenty concurrent patch pairs each returned
200/409 after the app-row locking correction, with no intermittent 404.
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

## Superseded preview candidates

- Core: `codex/crm-authenticated-release-20261006`; combined behavioral proof at `72fafd3a4`, includes employee `0ab3b28c` and `488e4637` changes.
- Native: `codex/crm-native-employee-combined-20261006`, `04fdf7ce39703118f78f1fce5c23f64295d70ca8`; preserves employee/pager `e2562e725c` as an ancestor. Normal full host build/client typecheck push guard passed; combined focused tests passed 14/14.
- Da Vinci: `codex/crm-authenticated-fe-20261006`, `71a891aff1453661b2901d6814dee57760c485a9`; parent gitlink matches it. Full CRA build and five focused tests passed.

These candidates retain the verified preview implementation and evidence. They are superseded
for release and must not be cut over directly.

## Canonical baseline preserved by the final CRM combination

The main release owner supplied these newer frozen sources on 2026-10-06:

- Parent: `17d9a9deed07b76056492351d87f31fc3bb11403`, preserving canonical employee commits
  `90392153a` and `95a525131` plus the latest outer frontend gitlink.
- Da Vinci: `135a5dae5e604a548cec1596dda4ef34270edb88`, verified from that parent gitlink.
- Native: `6c262ec39dd7765e7d20720968eaf58334a1172a`, reported pushed after the full guard,
  preserving employee, truthful session loading, mobile counters, and Brain greeting changes.

The CRM source was reconciled onto these exact canonical baselines. Current candidates:

- Core/Control branch `codex/crm-production-canonical-20261006`; immutable build source
  `41d0a91ec9c586ca3de2c0b069052cafaa3b9b7c`. Later documentation commits do not alter runtime code.
- Da Vinci branch `codex/crm-bridge-aligned-fe-20261006`,
  `53b60d7f4cc945addcba080f3fa234313df5fb83`; the parent gitlink matches it. Thirty-seven focused
  checks and the guarded production build passed with the CRM compile flag enabled. The authenticated
  browser proved local-field edits, refresh persistence, all three views and organization switching.
- Native branch `codex/crm-native-frozen-final-20261006`,
  `e8818a39b735ee6d05b9882d480dac770b71483c`. Fifteen focused checks include real Cordis Loader/Include
  composition, nine authenticated tools and Schedule ownership restoration. Runtime and HyperAgents
  load the tools/skill when enabled; disabled compositions and Brain omit them.

The final runner image must additionally preserve the main owner's pending Runtime-opening
correction and combined Brain source. The native source above is proved but is not the final
cutover artifact until that newer source/base is frozen and incorporated.

## Artifact and production readiness

Core/Control immutable images from `3f88c776d06ea04a23d7864d090f2e6d779923b6` completed:

- Core `hivemind/core-api:sha-3f88c776d`, image ID
  `sha256:5527719cf1eb81e977776947ff09111794a0ba88dfe771ae731ad27fb2726ecd`.
- Control `hivemind/control-plane:sha-3f88c776d`, image ID
  `sha256:167be327d19e491b5e01401d6a56b7377907350c9ccc4a2c11559b115306e882`.

Exact image labels, read-only imports and source checksums passed. Actual-image synthetic preview
with no source mounts passed 30 authenticated HTTP checks, five role/lock checks and 20 concurrency
pairs. Serial builders used two CPUs and 2 GiB; no production services were recreated.

The parent subsequently preserves promoted `385ac91827564318b9d6a8b5b2e41042bc256a38` as ancestry,
while retaining CRM frontend `53b60d7f`, a verified descendant of its `248d3dc9` bridge baseline.
Core/Control runtime code is unchanged. Their final release labels must match the next frozen parent
source, rather than retagging these proven images with a different revision.

Native `e8818a39b7` preserves exact Runtime/Brain source `5c946aab6b` and passes its normal full push
guard and compiled Loader proof. Its complete dependency-aware image delta is prepared; compilation
is held because the coordinator's fresh live canary still finds a Runtime room-opening race.
Preserve the next verified correction before final native artifact creation and cutover.

The final Worker archive SHA-256 is
`eb10bef61f669284c51043f934d2d35b845e84c590a3b386b672a0c5fc8b7436`.
The manifest summary and browser/Loader reports are retained under `core/docs/evidence/`.
The normal deployment source guard and CRM compile flag must be preserved during promotion.

Read-only production preflight at `2026-10-06T18:50:16.533Z` found 213 applied migrations,
no unresolved ledger entries and only the CRM migration pending against the candidate source.
CRM tables, restricted role and dedicated managed CRM credentials were absent. The existing platform
role is superuser/BYPASSRLS and must not be bound to the CRM pool. This inspection changed no schema,
credentials, feature flags, services or Worker version.

CRM remains inactive in production. Remaining steps are final compatible runner build, immutable
artifact proofs, the owner's exclusive activation window, managed SQL/role/secret configuration,
scoped artifact deployment and a signed-in disposable Runtime authoring/published workspace canary.
Preview receipts do not establish external SSO, autonomous model tool selection or live production
room entry. Release completion requires those live receipts; it is not complete at build readiness.

## Current external release hold

The main owner is completing the employee/Runtime live canaries and owns the exclusive cutover
window. CRM migration, credential binding, activation and Worker deployment remain unexecuted.
A final source review found no concrete blocking tenant/auth/credential/revocation/idempotency
defect in the inspected direct-pg and native App Builder boundary; this is not production proof.
The prepared activation bundle and canary plan are retained for continuation after the owner
supplies its final native correction and activation window.
