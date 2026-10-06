# Native employee lifecycle release review — 6 October 2026

## Source and boundaries

Core task branch `codex/employee-lifecycle-server` starts at canonical GitHub `singulance-main` bf73ef56. Harness task branch of the same name starts at cb14eb1bee. Da-vinci task branch starts at origin/main f6c61d67; its reviewed UI commit is 6dcb8db9. Reconcile all against current production before promotion; these branches do not replace unpushed Mac commits.

Core adds an administrator-authenticated `/v1/employees/native-lifecycle`, signed Runtime-only `/internal/v1/harness-chat/core/employee-lifecycle`, and signed administrator-scoped `/internal/v1/harness-chat/core/employee-lifecycle-proof`. It uses existing DigitalEmployee JSON policy, HyperAgentOperatingMemory and native Session tables. No migration or new database credentials are required. Creation stores draft/native-harness registry rows; legacy sidecar dispatch, deploy, remint and reserved-metadata mutation reject these rows.

Harness adds `hivemind_employee_lifecycle`, fresh registry checks before work/tool dispatch, ancestor owner checks for child tools, native Schedule deadline closeout, and a purpose-separated authenticated lifecycle callback host. Archive requires accepted work reviews, successfully recorded private learning/handoff, no outstanding child work and no open employee turn. It preserves histories. Core enumerates all company rooms; >1000 employee or Chief rooms fails closed rather than truncating cleanup.

The Worker UI uses the same native endpoint for direct creation, templates and profession hires. Temporary setup shows pending until the native schedule receipt is confirmed. Native rows do not expose legacy deploy/pause/remint buttons. UI activation must follow backend canaries, not precede them.

## Required configuration

The plugin `hivemind-employee-lifecycle-host` is deliberately shipped with `enabled: false` in `packages/bundle/hivemind-web-app/cordis.patch.yml`. Enable explicitly in the reviewed runner configuration after binary checks. It uses the existing secret reference `HIVE_HARNESS_RUNNER_SERVICE_SECRET`; never output or duplicate its value.

Core AND Control need `HIVEMIND_EMPLOYEE_LIFECYCLE_URL=http://harness-runner:3080/internal/hivemind/employee-lifecycle` using the verified existing common `hivemind_default` network and runner alias. Preserve all other service configuration. The host endpoint must remain internal. Signed callback audience is `hivemind-employee-lifecycle`, validity 30 seconds, bound to exact body hash, company, administrator and employee. Missing/unconfirmed host returns pending and does not claim deadline activation.

Runtime creation and host activation reconcile authority after native Schedule.ensure: changed/unknown revision removes the wake. This addresses archive cleanup occurring between initial proof and schedule creation. Retries use the exact saved native key and do not alter the original scheduled time.

## Immutable build and rollout sequence

1. Parent reviews/reconciles source with current canonical production refs, verifies active Runtime admission, and retains rollback identities. Push normal task branches; no hooks bypassed.
2. Build Core and Control from the integrated parent SHA and complete normal image checks. No migration step.
3. Build Harness from its integrated immutable SHA. The change touches package exports, bundle wiring, runtime Schedule dependency and pnpm importer, so use the corresponding wider graph build/install validation; do not use a source-only or copy-only patch image. Rebuild runtime and hq-runtime host outputs, exported lifecycle-host module and bundle graph. Preserve generated native event catalog (no new event type introduced here).
4. Deploy backend artifacts through their managed service manifests, with host initially disabled; check real signed and human routes. Drain/admission checks before any restart.
5. Enable the reviewed host and callback URL references; verify real internal activation and schedule persistence in disposable organization A. Keep frontend native-creation entry disabled/not promoted until this passes.
6. Run two-company canaries below. Only then reconcile/promote the Worker UI with frontend_finish's onboarding/popup changes. Worker-only cutover never restarts the runner.
7. Record digests, health, canary receipts, browser screenshots, rollback and proof limits. No full readiness signoff from isolated tests alone.

## Current rollback identities observed read-only

- Runner: hivemind/harness-chat:sha-cb14eb1bee-history-dates; image sha256:07e962efcefcce0aafa897e2fbd3853e93ac4515b08cfd068bf899e238c54e21.
- Core: hivemind/core-api:sha-7d4d5eb2; image sha256:96e6448a8ef1053d4af328fa9948f522832227be301cbca5a9c1b5a406b3f098.
- Control: hivemind/control-plane:sha-dc41d789; image sha256:1506892f7a8c9d859bdc79135f690d511ca6ade1839fc52df8fb4d9306e190d5.

Refresh these immediately before cutover. No services have been modified by this task.

## Canary setup and acceptance

Use two NEW disposable companies and administrator principals A/B, not Solvis/B&B/Aster production tasks. Same-company second owner A2 exercises all-room cleanup. Existing actual isolated PostgreSQL fixture `/root/employee-lifecycle-proof` creates both organization identities and restricted runner role without production connectivity. It now proves 14 checks including open employee turn blocking archive.

Authenticated canary: create ongoing and temporary employee via administrator UI and Runtime native tool; repeat exact creation request and require same ID. Confirm native preset room and private memory, no provider credentials or broadened permissions. Create actual Teams task, schedule it, finish an artifact, accept its current review and save private learning/handoff. Before those receipts, archive must fail. An active turn and pending child work must also fail. Deadline must stop business tools but allow bounded private closeout and reply to Runtime. Archive must retain room/history/artifact and remove employee-room schedules in A and A2 plus exact Chief closeout wake; unrelated schedules remain. B must neither see nor mutate A, and revoked administrator is denied on a fresh request. Repeat activation/archive and concurrent activation-vs-archive; no duplicate or lingering wake.

## Verified and remaining limits

14 isolated actual PostgreSQL/native-session proofs; 7 Core tests; 89 native employee/task/schedule restart checks; 2 native Schedule-host tests including retry and archive race; 2 administrator form tests; both native compilations and frontend bundle/lint passed. Host test uses real native Schedule with memory backend plus separately tested Core PostgreSQL attestation; it is not a full actual Teams + PostgreSQL Schedule + authenticated browser production canary.

Administrator membership is checked at request admission and fresh attestation; revocation does not retroactively cancel an already admitted in-flight operation. No stronger immediate cancellation guarantee is claimed. Core open-turn checks are durable boundary evidence, not a replacement for release drain or cancellation of an already in-flight external action. Unknown/pending callback cleanup must remain visible and retryable. DSH MCP docs were unavailable in this server context; contracts were verified against exact checked-in native source and READMEs.

## Review corrections — native contracts checked on 6 October

Current DSH documentation revision `639ed015397290b3745d163aafe02ffee4aa3f84` confirms native `Schedule.ensure` first-committed timing and deterministic identity, session-owned authorization, and retained inactive records. The callback continues using that native contract. Core fresh attestation supplies same-company room owners; an unavailable cleanup remains pending, never ready.

The reviewed branch adds fail-closed malformed lifecycle validation, bounded private closeout arguments, first owner and scheduled work checks, and a persistent reviewed Teams path for registry-native employees. Legacy explicit-ID executor selection excludes any reserved lifecycle policy, including malformed values. Native child session ancestry is included in open-turn/task closeout and exact room cleanup, within the attested organization only.

Latest isolated PostgreSQL proof passes 16 checks with restricted native Session writes, including an active descendant and unfinished descendant Team task blocking archive. These events are persisted through native Session persistence; they are not a full live LLM/Teams execution canary. Native focused service tests pass separately. No production change was made. The complete real Teams + PostgreSQL Schedule + human/Runtime creation-through-archive canary remains required before end-to-end signoff.


### Full native-plugin fixture result

The reviewed isolated fixture now passes **20 checks**. Its additional four
checks mount actual Cordis TeamService, PostgreSQL Schedule, Session persistence,
AgentLoop and artifact generation. A scripted in-process mock adapter issues the
real generation tool call (no external provider). The future assignment dispatches
at its saved time into the persistent employee room. Runtime inspects the saved
content; native completion is denied before the current accepted review. After
acceptance and a recorded private handoff, Core archives while retaining history.

Repeatable sources: `core/tests/integration/native-employee-lifecycle.pg.mjs`
and `native-employee-plugins.pg.mjs`. The bounded disposable runner mounts these
as `/source`, alongside `native-lifecycle.js` and the exact native Session baseline,
hardening and Schedule SQL migrations. It uses the compatible cb14 runner image,
restricted fixture role, no network except the disposable PostgreSQL namespace,
read-only files, nonroot execution and explicit CPU/memory/PID/disk/wall limits.
The original fixture import location under native Session persistence is retained
so native dependency resolution uses the image's own package graph.

This proves plugin integration with scripted model responses and dummy registry
adapters, not human browser UX or business-model reasoning. Activation/archive
callbacks against the newly built host, revoked-room-owner cleanup, and live
administrator/Runtime UI canaries remain release checks. Revoked owner cleanup
may correctly stay pending when native Schedule authorization denies the owner;
it must never be reported as successful or bypass that authorization.
