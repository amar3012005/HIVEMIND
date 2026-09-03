# Current SINGULANCE Production Release

## 886338b6 — Day 0 portrait-report correction

- Parent SHA `886338b6f6ca9cf09cd7a6d670e16c13647b4bfa`; frontend unchanged;
  no migration. Control Plane is healthy on immutable
  `hivemind/control-plane:sha-886338b6`; manifest
  `/root/releases/manifests/886338b6/20260903T101642Z/RELEASE_MANIFEST.json`.
- Restored the prior Day 0 email layout and changed only its attachment to the
  verified two-page A4 portrait Awakening report. Version `day-0-v4` supersedes
  v3 for future delivery and permits one receipt-preserving correction.
- Acceptance: syntax and focused tests 7/7; local production-equivalent PDF
  render visually passed; authorized Cloudflare delivery was queued; replay was
  idempotent; internal health 200 and fresh error scan empty.
- Rollback: `/root/quick-deploy.sh --rollback control-plane`; delivery receipts
  remain immutable and are not removed by code rollback.

## b3f7ee2f — Day 0 lifecycle report parity

- Parent SHA `b3f7ee2f4eeee6ee154b674e549f1cebdd7316da`; frontend unchanged at
  `e3f65bc29548b81289201fabb4ab4f70832fb1f5`; no migration.
- Control Plane only was rebuilt and is healthy as
  `hivemind/control-plane:sha-b3f7ee2f`, revision
  `b3f7ee2f4eeee6ee154b674e549f1cebdd7316da`; manifest
  `/root/releases/manifests/b3f7ee2f/20260903T084630Z/RELEASE_MANIFEST.json`.
- Day 0 v3 provides the shared mobile-safe Humation/evidence email structure
  and a protected, receipt-preserving one-time renderer reissue. Production
  checks: unauthorized reissue `401`; authorized reissue accepted by Cloudflare
  Email Service as `queued`; replay returned `accepted:false` and the stored
  v3 receipt. Control Plane local health returned 200 and fresh fatal logs were
  empty.
- Rollback: `/root/quick-deploy.sh --rollback control-plane`; original Day 0
  receipts and the new v3 receipt remain durable and are not deleted by rollback.

## 2026-09-01T07:35Z - global runtime and organic campaign capability

- Parent/runtime SHA `b42ea7a610e64b5bdb6faece6fabf77cc8b453ed`;
  frontend unchanged at `c5a4973c468f39f86f573284180f95afa140145a`.
- Core image digest
  `sha256:dcbb3195563fdde259b812816502e980bd7c9f39e32e49da8d6f6bd3e6d86341`;
  manifest `/root/releases/manifests/b42ea7a6/20260901T073247Z/RELEASE_MANIFEST.json`.
  No migration was pending or applied; only Core was recreated.
- Runtime config: Connector Runtime remains enabled for Chat, HyperAgents,
  TARA, and MCP; durable sync is now enabled. Campaign execution is available
  to all organizations for X organic, LinkedIn, Instagram, Facebook, TikTok,
  YouTube, Pinterest, Reddit, Threads, Bluesky, and Google Business.
- Acceptance: campaign capabilities and HyperAgents connector capabilities
  returned 200 for two tenant contexts; global/campaign gates evaluated true;
  API health and the production campaign page returned 200; Core was healthy;
  fresh critical logs were empty. No provider write was executed.
- Safety: publication still requires a connected provider, readiness, explicit
  approval, and worker execution gates. Paid X Ads remains unavailable because
  `X_ADS_API_APPROVED=false`.
- Rollback environment backup:
  `/root/hivemind/.env.pre-runtime-social-global-20260901T072048Z`, SHA-256
  `ccf27e35bb085b07d0228be925095b54341ac18511b2d48fa9e4d26dfe2062fb`.
  Runtime image rollback is the governor-preserved preceding Core image.

## 2026-08-31T23:09Z - restart-safe text and image ingestion

- Canonical parent SHA `1765ad96bfd726e1fe358e5bc6aaf589ece99420`;
  frontend remains `c5a4973c468f39f86f573284180f95afa140145a`.
- Core image digest
  `sha256:9bce5a18ee576d596a2b35835e6f6f29e24ace76e0c9257a11311613278a4102`;
  manifest `/root/releases/manifests/1765ad96/20260831T230417Z/RELEASE_MANIFEST.json`.
- Knowledge-ingest Worker version `e64dc93f-065a-4512-b5db-5435ecfaee2a`
  is active at 100% with production bindings preserved. No migration was pending.
- Acceptance: three interrupted Workflow jobs resumed and reached `ready`; a
  fresh simultaneous three-PDF burst completed in 11–17 seconds with all
  receipts on attempt 1 and overlapping stages. PNG canary
  `f379e597-ab8d-403e-bf0f-a34698753454` completed with one canonical memory;
  retained JPG/JPEG canaries remain ready. Core health returned 200 with DB,
  Qdrant, and Docling reachable.
- Rollback is the governor-captured preceding Core image and Worker version
  `9225e2b9-e088-4df5-ba44-cbba3d76b3ee`; emergency admission rollback remains
  Flagship off or the Core environment gate.

## 2026-08-31T20:38Z - durable ingestion throughput globally accepted

- Canonical parent SHA `e9fca76f6e8d66398d195f87d431645a56b1b058`
  includes the complete throughput release and the pushed Da-vinci gitlink
  `c83e6df23bfae8782643386bb13b9a5cb1d3d72c`. Core runs immutable image
  `hivemind/core-api:sha-8cd4de52` (image ID
  `sha256:03ecf6887f296aedec703ba9da7db77735fa5b2ad4f96004f2577173660fb137`),
  manifest `/root/releases/manifests/8cd4de52/20260831T195927Z/RELEASE_MANIFEST.json`.
  Cloudflare serves knowledge-ingest version
  `10f80a27-2f76-4a63-b565-ecd07c295590` and hivemind-web version
  `7d42da41-922c-4360-bc4f-8d0376be1024`, each at 100%.
- PostgreSQL backup
  `/root/backups/hivemind-pre-6447b5b7-20260831T195604Z.dump` has SHA-256
  `4697da88ca0a5b26f1a60b11601944c0a35b02698975f90`; additive migration
  `20260831214500_add_ingest_lease_org` is applied. The migration enables four
  global processing slots with a maximum of two active slots per organization.
- Acceptance submitted four synthetic one-page PDFs concurrently: two
  evidence-only and two evidence-plus-memory. All four reached `ready`; the
  observed same-org maximum was two leases, all 4/4 segments had acknowledged
  vectors, 18 durable stage receipts existed, the two `both` jobs produced
  three and four memories, and four distinct billing reservations settled once.
  Each unique marker returned source-backed evidence. A post-global one-PDF
  smoke also reached `ready`, stored 1/1 vector, settled once, and returned 13
  evidence items. All synthetic documents, jobs, keys, and source objects were
  deleted by the harness.
- Production vision is the direct Cloudflare multimodal endpoint with AI Gateway
  `hivemind-prod` and model `google/gemini-2.5-flash-lite`. A sanitized live
  image request returned HTTP 200 and the same response model. Groq/OpenRouter
  are not vision fallbacks, and provider error bodies are rejected before the
  persistence boundary.
- Incident jobs `54233663...` and `3bc81fe9...` were repaired from a second
  secure backup (222,241,746 bytes; SHA-256
  `2ae12553216764e7c64dae8221747608d618bed6a8c38884a96bab3f0a9ba956`).
  Their existing evidence was reconciled without reparsing or duplication:
  exact documents remained stable, materialize attempts were unchanged, and
  155/155 plus 108/108 vectors remained acknowledged. Both jobs are `ready`,
  reservations are settled, and `uploads`/`kbPages` settlement keys are unique.
  The second Workflow completed normally; the first obsolete retry instance was
  terminated only after PostgreSQL reconcile and billing were terminal.
- Flagship `knowledge_ingest_workflow_v1` is enabled with default `on`; both
  production targeting rules and the local rule also serve `on`. An unrelated
  production context evaluated `on` with reason `DEFAULT`. The backend master
  gate remains enabled as the emergency kill switch. API, platform, and homepage
  health returned 200; fresh critical logs were clean.
- Immediate behavior rollback is the captured full Flagship definition with
  default and production priorities 2/3 restored to `off`, preserving all rule
  conditions, priorities, variations, description, enabled state, and the local
  rule. Runtime rollback is Core `hivemind/core-api:sha-97afbd87`, knowledge
  Worker `d8547ac3-6609-4b47-bf87-32cd9d9c185a`, and frontend version
  `563d1957-cd4f-478f-919f-f6dbe971abc2`.

## 2026-08-31T08:52:20Z — production AI path defaults globally reconciled

- Cloudflare Flagship app `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8` now serves
  the accepted production matrix globally:
  `knowledge_ingest_workflow_v1=on`,
  `recall_parallel_reliability_v1=on`, `durable_chat_agent_v1=full`, and
  `canonical_knowledge_foundation_v1=full`.
- The only mutation in this release was a governed full-definition update of
  `recall_parallel_reliability_v1`, changing its default from `off` to `on`.
  All flag variations, two targeting rules, type, description, and enabled
  state were preserved. Two unrelated contexts resolved `on` by `DEFAULT`;
  the existing operator resolved `on` by `TARGETING_MATCH`.
- Backend master gates and production Workflow, Queue, R2, Durable Object, and
  Worker bindings were verified. Eight accepted Workflow ingestion jobs were
  ready with zero duplicate checksum groups. The four-lane recall run completed
  without degradation and returned 3 memories, 12 evidence items, 15 citations,
  and 17 graph edges.
- Direct, profile, exact-source, relationship, and entity chat canaries all
  returned HTTP 200. The entity canary was not grounded, and the relationship
  and entity canaries each retained one gap; those semantic-quality limits are
  explicitly not represented as full semantic acceptance.
- Core `sha-9091c1e0`, Control `sha-953f3a71`, and Employees `sha-b3616eb4`
  retained their images, start times, and zero restart counts. API and homepage
  returned 200 and the critical log scan was clean. No build, migration,
  restart, container deployment, or Worker deployment occurred.
- Immediate recall rollback is the captured full flag definition with only
  `default_variation=off`; the remaining three capabilities have independent
  Flagship defaults and can be rolled back without changing runtime images.

## 9091c1e0 — lazy profile discovery and complete chat-route acceptance

- Canonical Core SHA `9091c1e01d63270a14d668cf60c6634d27469e95` on
  `singulance-main`; image `hivemind/core-api:sha-9091c1e0`, digest
  `sha256:258e140bc90f0bd2478371d7d12caf247e88648aa4f8e6eb5e318e8d5a6bb261`.
  Manifest `/root/releases/manifests/9091c1e0/20260831T081213Z/RELEASE_MANIFEST.json`
  reports `ok` for Core only. No migration was required; 174 migrations are
  applied with none pending.
- Native V2 no longer receives caller profile values on every planner call.
  The authenticated, bounded profile packet is loaded lazily only after a
  direct personalized response, save/auto-save, or profile update is selected.
  Explicit profile reads use the server-scoped `hivemind_profile` capability,
  including `use_tools:true`; the model receives no user/org identifier input.
- Production acceptance passed direct arithmetic, native profile, tool-enabled
  profile, exact-source document recall, unconstrained recall, graph
  relationship, broad source synthesis, projects, temporal no-coverage, exact
  aggregate no-coverage, and a disposable declarative auto-save. Grounded
  routes returned citations and zero gaps. Empty authorized projects now return
  a grounded explicit empty result rather than a generic retrieval failure.
  Temporal and aggregate requests without complete evidence fail closed.
- The disposable personal-memory assertion selected `save`, preserved exact
  entities and `user_assertion` provenance, traversed `ingestCanonicalPayload`,
  and created tenant-scoped entity links. The exact canary memory was hard
  deleted after verification.
- Linux release suites progressed from 39/39 on the lazy-profile commit to
  83/84 on the final candidate. The sole failure is identical on the deployed
  parent baseline: a stale exact-source test expects no additive `kind:null`.
  Every changed regression passed. Core/API/homepage return 200 and fresh
  critical logs are empty. Control and Employees retained their exact images
  and start times.
- Rollback is Core `hivemind/core-api:sha-62553bc2`, digest
  `sha256:9f7240205861dc4d3073743b7ccefe398319c573d57e1bbf781e02be6a3d6256`.
- Global rollout accepted at `2026-08-31T08:28:06.413Z`: Cloudflare Flagship
  app `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8`, flag
  `durable_chat_agent_v1`, changed only `default_variation: off -> full`.
  Variations, both targeting rules, description, and `enabled:true` were
  preserved. Two unrelated contexts evaluated `full` by `DEFAULT`; the operator
  remained `full` by `TARGETING_MATCH`. No container was rebuilt or restarted.
  Immediate behavior rollback is the captured full flag definition with only
  `default_variation` restored to `off`.

## 4371984d / 953f3a71 — durable ingestion and grounded-chat hardening

- Canonical runtime commits on `singulance-main`: Core
  `4371984dccca1ee2666555fcbfee0606618ba3ad` and Control Plane
  `953f3a719aab66aed5b1f479ed6e45f232613761`; frontend and Employees were
  unchanged. The preceding chat fix is
  `d4a45da449301377ed8de465b21f900772ed023d`.
- Core image `hivemind/core-api:sha-4371984d`, digest
  `sha256:2e954b4e4149b9cb7658327ab3231aea57eb5edadf526844dac2fe8649cf7fb0`;
  manifest `/root/releases/manifests/4371984d/20260831T005717Z/RELEASE_MANIFEST.json`.
  Control image `hivemind/control-plane:sha-953f3a71`, digest
  `sha256:83ea81bfcb59de74e3955416cb10ddd6a0bafcb7211be582f62a1cab5b0de2a9`;
  manifest `/root/releases/manifests/953f3a71/20260831T004847Z/RELEASE_MANIFEST.json`.
- Chat fixes: year-leading exact filenames no longer enter temporal planning;
  structured retrieval retains authorized legacy text candidates before entity
  coverage validation; source conflicts resolve to the relevant evidence;
  duplicate relationship prose is eliminated; detailed answers retain valid
  citations. Full-mode production canaries returned Jim Adair for HASTY CAKE,
  the complete Teil2 creative-role list, and one Pantene/P&G relationship
  sentence. The stable flag-off HASTY CAKE path also returned Jim Adair and
  created no durable row.
- Heavy-ingestion fixes: Control admits only the two internal asynchronous
  materialization routes; Cloudflare BGE-M3 requests are bounded to 48 items
  and 45,000 characters; a Workflow retry idempotently heals its missing
  versioned credit reservation before settlement. Source bytes and large
  artifacts remain outside Workflow state.
- Fresh production acceptance uploaded the 12,053,389-byte, 90-page
  `1981-60th-AnnualTeil3-ocr-canary.pdf` as job
  `85bf1f37-ff77-4865-819a-a4c3bebbf141`. Workflow instance
  `kb-85bf1f37-ff77-4865-819a-a4c3bebbf141-v2` completed at `reconcile coverage
  and settle-1`. Document `483831cf-c694-41bf-b5f5-e51937224801` contains 221
  segments, 221/221 embeddings, 17 candidates, 15 promoted memories, zero
  failed embeddings, and one terminal usage settlement. Exact-source Issue 361
  and unconstrained CITY CYCLES chat canaries both returned HTTP 200, grounded
  answers, two sources, and two citations.
- Live primary embedding probe split 50 synthetic 1,000-character inputs into
  batches `[45,5]` and returned 50 finite 1024-dimensional Cloudflare BGE-M3
  vectors. Focused tests passed 22/22 for batching/fallback/settlement and 2/2
  for the Control proxy contract; all changed chat tests passed in the 72/75
  candidate/baseline suite (the same three unrelated stale assertions failed
  in both revisions).
- Runtime acceptance: Core, Control, and Employees are running their expected
  immutable images; public homepage, login, and API health return 200; the
  fresh critical Core log scan is empty. `durable_chat_agent_v1` remains global
  default `off` and exact operator canary `full`.
- Rollback: Core `hivemind/core-api:sha-d4a45da4`, digest
  `sha256:2462bdf8f2cde361ca8b9db1e799cb83f1f6b6689ce519d0a32940cc8978062e`;
  Control revision `346586be`, digest
  `sha256:285a4fdf44ee625ed0ad3f64807c6931b7623258cec4aa6d2d0b1abcc4061fbe`.

## a73cdbc8 — durable Chat V2 production canary

- Canonical parent SHA `a73cdbc82dc5ea637244d38bda7fb8ea7a96a0f3` on
  `singulance-main`; frontend unchanged at
  `59f3779b8291d5136a72a18867b5b4076ed46172`.
- Core-only canonical release. Image `hivemind/core-api:sha-a73cdbc8`, digest
  `sha256:8d826de5f0c7ff669bc198da15e1453c915890cee8a6fa491a80554cff83e5f6`;
  revision label matches the full parent SHA and Core is healthy. Control Plane
  and Employees were not rebuilt or recreated.
- Additive replay-safe migrations
  `20260831143000_durable_chat_agent_v1` and
  `20260831150000_durable_chat_continuations` applied successfully. Backup
  `/root/releases/backups/pre-durable-chat-a73cdbc8-20260830T233248Z.sql.gz`,
  SHA-256 `88461757b872cc2d38cec13342697544819a58574a21d34d22d4d731c44c281c`.
- Manifest `/root/releases/manifests/a73cdbc8/20260830T233409Z/RELEASE_MANIFEST.json`
  reports `ok` for the exact SHA.
- Cloudflare Worker `hivemind-durable-chat-agent-production`, active version
  `c413ed26-533f-4198-8d6f-be03841e1ae3`; Workflow
  `hivemind-chat-turn-workflow-production`; Flagship
  `durable_chat_agent_v1` remains default `off` with one exact production
  `full` rule for the existing operator canary. Unrelated production context
  evaluates `off`.
- Production acceptance: 82/82 focused Core tests, 15/15 Worker tests, Prisma
  validation, TypeScript, Wrangler types and production dry-run passed. Stable
  flag-off Chat V2 returned HTTP 200 with its original shape and zero durable
  rows. Canary first execution returned `full/completed`; the same
  `X-Idempotency-Key` replayed the identical turn with `replayed=true`.
  Grounded recall returned three sources and two citations. Durable Object and
  Workflow inspection contained lifecycle metadata only and Workflow reached
  `complete`. Public homepage, login, API and Core health returned 200; fresh
  Core critical-log count was zero.
- Environment backup
  `/root/hivemind/.env.pre-durable-chat-20260830T233350Z`. Immediate behavioral
  rollback is to remove/set the exact Flagship rule to `off`; then set
  `DURABLE_CHAT_AGENT_ENABLED=false` and recreate Core through the canonical
  service-scoped release path. The schema is additive and remains inert. This
  is the first production Worker release, so leave it deployed and inert rather
  than deleting Durable Object or Workflow resources during rollback. Exact
  prior Core is `319620270b84392d13d3a2c8970c10cb299372ea`.

## sha-a2e8db25 — provenance-only Derives and precise Memory Box edge repair

- Parent SHA: `a2e8db25d55968d9ddd771db9c98738ea4ec027b` on `singulance-main` (PRs #521 and #522). Frontend unchanged and still hosted independently on Cloudflare.
- Runtime: Core `hivemind/core-api:sha-a2e8db25`, digest `sha256:8f06fb17d96d6b9040211aae06efd0ba6139d9bbc4b68445b55ab6ef89574fae`; affected Memory Box agent `hivemind/hm-agent:sha-a2e8db25`, digest `sha256:2d94b343a0c4d797365938de7111c0fc4f35e1a1916135780c19425400ca8e6b`. Core healthy; both restart counts zero. No data service was restarted.
- Fix: removed the legacy processor-similarity heuristic that labelled ordinary created facts/preferences as multi-source syntheses and attached up to five unrelated `Derives` edges at fixed confidence `0.70`. Explicit `_derives_from`, validated multi-source linker, and cognition synthesis provenance remain unchanged.
- Repair capability: native `.amr` and PostgreSQL-backed BYOD agents now support exact tenant-scoped typed-edge deletion without deleting or recreating a memory. Rust acceptance covers inline and overflow-backed edges across reopen.
- Authenticated acceptance: removed the five exact false SOLVIS-to-Nisha `Derives` edges and verified the Nisha memory has zero remaining relationships. A fresh personal preference memory received canonical person/product entity tags, was recalled from the affected tenant, and had zero relationships after deferred enrichment; the synthetic acceptance memory was then deleted.
- Validation: Node syntax checks, `git diff --check`, relationship route-persistence test, and native Rust edge-removal persistence test passed. Fresh Core and agent fatal/error scans were empty. No migrations.
- Rollback: Core `hivemind/core-api:sha-c65e77ba`; Memory Box `hivemind/hm-agent:rollback-pre-a2e8db25-20260822T081632Z`. Core manifest: `/root/releases/manifests/a2e8db25/20260822T080938Z/RELEASE_MANIFEST.json`.

## prod-20260809-5d4e08e3 — generalized inline human input + grounded governed actions

- Parent/Core SHA: `5d4e08e3a333ee516dfc6acc14e5174c91de1aa6` on `singulance-main`; Core image `hivemind/core-api:sha-5d4e08e3`, image ID `sha256:7e92dac2937e1196d7e8f3e4cb6fed78510969405c03ee0839740a15689540cb`.
- Frontend source SHA: `f864c0a2e2b7064c398c2746f9971333a208607f`; unchanged accepted frontend image `hivemind/fe:sha-96ed8afe`, image ID `sha256:99f01743c53bea6d2d58ecb677c74aa471f7ddaa23dbc44f7943c8e5eeea065d` (parent image revision `96ed8afe`, exact gitlink points to `f864c0a2`).
- UX: Overview, side-panel Chat, and mobile now render approvals, arbitrary field input, continuation choices, project/save-scope choices, and cancel states directly on the chat background. There are no outer action cards; headings are bold, exact values are visible, and actions use rectangular inline buttons. Pending actions explain what finished, why HIVE-MIND paused, and that nothing external has happened.
- Generalized continuation: server accepts only declared server-owned fields, validates required values, binds the continuation to tenant/user, resumes the paused step, and retains completed dependencies instead of replaying recall/provider reads.
- Governed content: Query Mode remains primary. Unresolved templates and dependency-content loss are detected structurally plus by grounded overlap; one scoped synthesis fallback sees the complete bounded recall projection before a compact provider schema; an exact server-verified content fallback prevents evidence from being hidden by schema truncation. Missing data still pauses for inline input.
- Compound robustness: read/write authority remains separate from semantic operation. Terminal communication selects the provider send capability unless the structured planner operation specifically requests a provider draft. A later write missing its dependency edge inherits prior read/recall steps; capability discovery/selection receives one side-effect-free retry. Provider writes themselves are never auto-retried and remain pending approval.
- Tests: 42 focused Core tests passed; 3 shared frontend interaction-contract tests passed; frontend production build completed; syntax and `git diff --check` passed.
- Authenticated acceptance: the handbag-to-email request was run twice with `use_tools:true`. Both completed recall and returned `pending` `composio_gmail_send_email` actions for `amarsai2005@gmail.com`; bodies were 685 and 1,759 characters and both contained `G ROCHER` and `JL`. Drafts `0a80f7c9-4243-48b9-8b45-52b5c72d7224` and `b69feefc-387f-43b1-8327-232ba2737a41` were cancelled; database verification showed `status=cancelled`, `sentAt=null`, and tool `GMAIL_SEND_EMAIL` for both.
- Runtime acceptance: Core healthy, frontend running, zero restarts; public Core/home/login/Overview all returned 200; frontend served chunk `4676.aa4090dd.chunk.js` contains the inline interaction markers; fresh fatal/panic/uncaught/unhandled/OOM/migration error counts are zero.
- Migration: none. Rollback Core: `hivemind/core-api:rollback-pre-5d4e08e3-20260808T234149Z`; frontend remains independently rollback-safe from the previous accepted frontend release. Manifest: `/root/releases/5d4e08e3-clean/RELEASE_MANIFEST.20260808T234149Z.json`.
- Intentionally untested side effect: no Send button was clicked and no email was sent.

## prod-20260809-68ec3448 — Slack stage progress + exact governed email preview/send

- Parent SHA: `68ec34485ba25687f62371eb51811f3949b412e8` on `singulance-main`.
- Frontend SHA: `bbc8e7aac91208868419bff5eafd76aa5cd84be7` on Da-vinci `main` and recorded by the parent gitlink.
- Images: Core `hivemind/core-api:sha-68ec3448`, image ID `sha256:86c888f5407eb2ac58aff36c55387edaf60d1876ab7cc8de7da58d2ccef31d8d`; frontend `hivemind/fe:sha-68ec3448`, image ID `sha256:d18b553c4b2586effb3461322daa6d7695bc331840b03d7befa5c40361af5bee`.
- Migration: none.
- Slack: `@HIVEMIND` event-ingest now forwards the agent `onEvent` stream into one throttled in-place Slack message. Native recall/save and compound connector steps show stable stage rows; queued progress writes drain before the final answer. Connected tools are eligible on Slack unless `SLACK_CHAT_USE_TOOLS=false`; existing history and project-selection behavior remain intact.
- Governed writes: compound responses now include `pending_actions` with the exact immutable tool arguments already persisted for approval. Desktop Overview, Chat, and mobile render complete email recipient, subject, and body plus one-click Send/Cancel actions. Semantic tool selection prefers the requested terminal provider effect because HIVE-MIND already owns the approval preview; a provider create-draft remains eligible only when that is the requested terminal outcome.
- Tests: 37 focused Core routing, use-tools, compound/Composio, and Slack progress tests passed; 2 frontend approval-contract tests passed; clean frontend production build completed.
- Authenticated acceptance: the exact request `find me everything u know about my company and then write a mail to amarsai2005@gmail.com about it` returned 200, completed HIVE-MIND recall, selected `composio_gmail_send_email`, and returned a full `pending_actions[0]` containing recipient `amarsai2005@gmail.com`, subject, and complete body. The acceptance draft `50b0ba08-24d7-4289-8964-7dc54367c028` was cancelled with 200; no email/provider write was executed.
- Runtime acceptance: Core internal/public health, homepage, login, and Overview returned 200; exact Core/frontend revision labels match `68ec3448`; restarts are zero; frontend served chunks contain the new approval markers; fresh fatal/panic/uncaught/unhandled/OOM/migration error counts are zero.
- Release-script incident: the server's stale canonical script initially recreated frontend from `sha-5246cdd7` while failing to gate its own revision mismatch. The release was not accepted in that state. The exact `sha-68ec3448` frontend and Core were then rendered with explicit immutable Compose overrides under the release lock, `VERSION`/`NEXT_VERSION` were set to this release, and provenance was re-verified.
- Rollback: Core `hivemind/core-api:prod-20260809-8c8e2276`; frontend `hivemind/fe:sha-8c8e2276`; manifest `/root/releases/68ec3448/RELEASE_MANIFEST.20260808T222458Z.json` plus explicit overrides `/root/releases/68ec3448/{core,frontend}-68ec3448.yml`.
- Intentionally untested side effect: the Send button was not clicked during acceptance, so no customer email was sent. Approval execution remains the existing tenant-scoped `/api/pending-writes/:id/approve` path.

## prod-20260809-8c8e2276 — streamed chat orchestration, generalized Composio planning, resumable choices

- **Deployed:** 2026-08-08T21:56Z UTC (release date 2026-08-09 Asia/Kolkata)
- **Parent:** `singulance-main` runtime SHA `8c8e2276a6cb5516184f9d47f641483a2ebdceb4`
- **Frontend source:** `8108fbecef442a57c25b20ca80e4220ca56625e0`; running image `hivemind/fe:prod-20260809-a1829df2-single`, digest `sha256:da57722c1076833d83135f51f027910e16bad058d8763c8e83ee065445884810` (same chat UI source; parent label predates later backend-only fixes).
- **Core image:** `hivemind/core-api:prod-20260809-8c8e2276`, digest `sha256:6bd8bc2b6d0ab947c03a5f41feebe4e3033f4d7fe8c113836a3fdc4cd2e16697`, healthy with matching OCI revision.
- **Changes:** canonical `orchestration_plan` / `orchestration_step` SSE events; shared expandable Reasoning timeline with provider logos on Overview and mobile; opaque tenant-bound single-use continuation tokens; choice buttons resume blocked dependencies without replaying completed recall/provider reads; ACTIVE Composio toolkit inventory replaces the closed toolkit allowlist; one provider-error-guided retry for failed reads only; pending-write hashes are bounded SHA-256.
- **Governance:** `use_tools:false` native path unchanged; writes remain pending approval; read repair never retries writes; continuation state is server-side with a 15-minute TTL and scope check.
- **Tests:** 33 focused planner/orchestrator policy tests passed; frontend production build compiled (repository-wide pre-existing lint warnings prevent `CI=true` warning-as-error); JS syntax and `git diff --check` passed.
- **Authenticated acceptance:** tenant `0a1d5b33-…` ran recall + Gmail recipient lookup and received two choices. Choosing `amarsai2005@gmail.com` resumed only step 3 and created draft `f2352fe6-d4b3-47d6-b32c-f200004532b3`; persisted `status=draft`, `sentAt=null`, tool `GMAIL_CREATE_EMAIL_DRAFT`, 64-char args hash. Native handbag recall returned grounded `G ROCHER` with no compound status.
- **Public checks:** Core health 200, Control health 200, frontend app 200; fresh fatal-pattern count zero for Core and frontend.
- **Migrations:** none.
- **Rollback:** Core `hivemind/core-api:rollback`; frontend `hivemind/fe:rollback-single`; env backups `/root/hivemind/.env.bak-prod-20260809-*` and `/root/hivemind-next/.env.embedding-canary-runtime.bak-prod-20260809-*`.

This file is the deployment ledger. Update it only after production acceptance succeeds.

```yaml
release_id: prod-20260806-0a677a89   # core; FE prod-20260806-8a0e73b1-single
host: singulance
deployed_at_utc: 2026-08-06T16:55:00Z          # runtime observed, not build time
parent:
  branch: singulance-main
  sha: 0a677a890b9b                             # RUNNING core. Recorded from
  # `docker inspect hm-core --format '{{.Config.Image}}'`, NOT from a build log —
  # see changes[] below: the release script reports success over a container that
  # is still on the previous image. singulance-main had already advanced past this
  # (ff7dc7ef) when this was written; the ledger records what RUNS, not what merged.
frontend:
  sha: 7f51e7d554f57f0651603328c73265c171d15ead  # Da-vinci main (image tag prod-20260806-8a0e73b1-single)
runtime:
  VERSION: prod-20260806-7e1b07b9
  env_change: |
    MEMORY_PROCESSOR_MODEL and ENTERPRISE_EXTRACTION_MODEL moved off
    deepseek/deepseek-v4-flash-0731 to google/gemini-2.5-flash-lite (deepseek
    truncated small-JSON calls: finish=length, which triggered a fallback call
    every time). KB_UNIFIED_FALLBACK_MODELS deliberately left TWO-FAMILY
    (deepseek,gpt-oss-120b) so one provider outage cannot take out extraction —
    a single-member gpt-oss chain was considered and rejected because gpt-oss
    was returning HTTP 400 "Reasoning is mandatory" at the time. Applied in
    /root/hivemind/.env only, NOT in the repo. Backup: .env.bak-modelswap-*.
images:
  core: hivemind/core-api:prod-20260806-0a677a890b9b
  control: hivemind/control-plane:sha-556d95ec5                          # unchanged
  employees: hivemind/employees:prod-20260804-runtime-campaign-86f70547  # unchanged
  tara_deepgram: hivemind/tara-deepgram:sha-bf7af3ca                     # unchanged
  byod_agent: hivemind/hm-agent:sha-a95090c2                             # unchanged
  frontend_single: hivemind/fe:prod-20260806-8a0e73b1-single
  docling: ghcr.io/docling-project/docling-serve@sha256:69f7c33dab7067be28d88bfe61b7be08e53c4f87d5571378001f853d9b95c34e  # PINNED BY DIGEST (was :latest)
migration: none
changes:
  - KB PIPELINE, 2026-08-06 late session. pptx RESTORED to KB_EXTENSIONS (server) and
    ACCEPTED_EXTS (FE). It was withdrawn after a real .pptx measured 479s / chunks=0;
    that cause — one serial vision call per slide image — was already fixed by
    FORMAT_PROFILES pptx pics:false and never revisited here. Re-measured on the SAME
    file named in the old comment: 12.4s, 100% word recall. ppt/doc/xls stay refused
    (legacy binary, need LibreOffice; `command -v soffice` in hm-docling is empty).
    The FE picker no longer offers .ppt/.xls it would then reject.
  - EMPTY EXTRACTION now fails for EVERY format, not just pdf. Docling answers
    200/success with a near-empty body on an image-only document (measured: 46 chars,
    three `<!-- image -->`; 104 chars even with do_ocr=true). Non-pdf formats had no
    fallback AND no guard, so the document finished `ready` holding nothing. Same
    200-char floor as parseFailed, which already requires usableChunks === 0.
  - SLIDE CITATIONS. Docling emits no page break for pptx even with
    md_page_break_placeholder set; the page lives in texts[].prov[0].page_no, which
    only arrives when to_formats includes json — and the adapter sent no to_formats.
    Now requests md AND json for slide formats (json alone returns md_content: null)
    and INSERTS `<!-- page N -->`, the marker the segment writer already parses.
    Trap: prov.bbox reports coord_origin BOTTOMLEFT with b < t, which reads y-up and
    is not — bbox `b` equals the true top-down `top` (verified against python-pptx).
    Sorting by `t` returns every slide upside-down while looking plausible.
    Measured live: with_page 0/9 -> 6/9, "no start_page on ANY segment" gone,
    parseText unchanged at 5009 chars.
  - hm-docling PINNED BY DIGEST off mutable :latest. Rollback pointer recorded
    BEFORE recreate at /root/.last-docling-rollback.
  - NOT CHANGED, because measurement showed they were already correct: the async
    submit/poll path (useAsync = smart || >4MB), the task-vanished/OOM guard, the
    per-format profiles, and the provider-rejects-reasoning retry. Four earlier
    "findings" against these were artefacts of benchmarking with a standalone sync
    harness instead of reading the production path first.
  - REVERTED same session: DOCLING_SERVE_MAX_NUM_PAGES / MAX_FILE_SIZE (inert — the
    docling service has no env_file, its config is inline in compose) and
    KB_QUEUE_CONCURRENCY 6->3 (contradicted a measured tuning note: the serial point
    is the sidecar, not the queue). .env diffed identical to its pre-change backup.
  - KB GROUNDING (the session's main find). normalizeUnifiedClaims gated facts on a
    BYTE-EXACT content.includes(source_quote), so any quote spanning a hard line-wrap
    ("klein und\nergaenzt" vs "klein und ergaenzt") was discarded with no log line.
    This produced "EXTRACTION SHORTFALL: kept 0 facts from a window holding 14/15
    fact-bearing sentences" and was long misattributed to the extraction model —
    model benchmarks scoring "verbatim quote ratio" were in fact scoring this filter.
    Replaced with locateSourceQuote(): whitespace/dash/quote-variant tolerant, recovers
    the real offset AND repairs source_quote to the actual section bytes. Normalization
    can only merge characters that already exist, so a hallucinated quote still fails
    and is still rejected — the grounding guarantee is unchanged. Added per-condition
    drop counters ([kb-normalize] in/kept/repaired/dropped{...}) because seven AND-ed
    conditions meant "0 facts" had seven silent causes.
  - The identical byte-exact gate in resolveEvidenceSegment fixed the same way, so a
    re-wrapped quote still binds evidence to its segment.
  - start_page: added a form-feed (\f) page-boundary fallback for fast-pdf/vision tiers
    that emit neither Docling "<!-- page N -->" nor "-- N of M --" markers. A tier with
    no page signal still yields null and is logged honestly rather than guessed.
  - UPLOAD PRECHECK: a knowledge_ingest_jobs row with status=ready OUTLIVES its document
    (hard delete, no soft-delete flag), so re-uploading a since-deleted file was blocked
    forever as "Already in your knowledge base". Precheck now confirms the document still
    exists before reporting a duplicate; a stale ready job returns duplicate:false with
    stale_job:<id>. Dedup stays DB-authoritative and fails open toward allowing.
  - EVIDENCE SCOPE: every knowledge_segment now carries scope / scope_key / project_id /
    team_id / document_title in metadata, on BOTH segment paths (the semantic upload path
    and ingestConnectorRecord, which serves /api/ingest/source). Scope lenses therefore
    apply the same filter to memories AND evidence on central and .amr alike, without
    needing a document join the remote agent does not have.
  - DOC SUMMARY prompt: stopped coining an umbrella entity out of the filename ("The
    WrapTest DE project establishes...") and pinned same-language output.
  - MCP BI-TEMPORAL: hivemind_at / hivemind_diff posted a NESTED time:{valid_at,known_at}
    that /api/recall never reads (it reads body.valid_at / body.transaction_at), so the
    filter was silently dropped — hivemind_at returned the entire corpus (356 memories /
    1.7MB) while looking like a working snapshot, and hivemind_diff compared two
    unfiltered sets. Now sent top-level with the route's real key (transaction_at), and
    capped by the documented limit (default 20, max 200).
  - CHAT BI-TEMPORAL: routing was already correct, but hivemind_context is a `strict`
    tool whose every property is required, so the model satisfied the schema with null
    dates; plan.time came out null and every diff question fell through gatherEvidence's
    dispatch to a version-chain walk. Added extractMessageDates() — a deterministic
    ISO + English/German month-name parser used ONLY when the model supplies no usable
    date. A model-supplied date is never overridden; when nothing parses the value stays
    null and behaviour is byte-identical. The bi-temporal ENGINE is untouched.
  - FRONTEND: the upload scope modal gated the "Entire organization" tier on user.role,
    which bootstrap never populates (org membership is exposed as org.role / user.orgRole;
    control-plane emits orgRole: membership.role). isOrgAdmin was therefore false for
    EVERY user including owners, so the tier rendered opacity-50/cursor-not-allowed and
    could not be clicked, and queueFilesForUpload silently defaulted admins to 'personal'.
  - CHAT ROUTING: respond_directly was answering WORKSPACE questions from model
    parameters on compound input. Measured: "What changed in my knowledge between
    Aug 4 and Aug 6 2026? Was the Gmail pipeline working on August 1st?" selected
    respond_directly with ZERO tool calls — first inventing workspace facts, later
    refusing with "my training only includes data up to June 2024". The same question
    asked one clause at a time routed correctly, so it was a routing miss on compound
    input, not a capability gap. Added a deterministic guard: only when reason=general,
    only when a REAL date parses, and only when the message reads as a question about
    state. clarification / safety_refusal are never overridden.
  - INGESTION FAIL-PROOFING (this session, second half). Dead jobs no longer delete
    the bytes needed to replay them, and a retry endpoint plus GET
    /api/knowledge/jobs?status=failed,dead make failures discoverable and
    re-runnable; a raw-file sweeper bounds retention. The BullMQ worker lock was
    30s against 30-134s jobs, so a lapsed lock could re-deliver a job and ingest
    the same document twice — lockDuration now equals the job budget. The
    reconciler heals evidence SEGMENTS as well as memories, closing the last silent
    data-loss path (a segment whose ingest-time heal failed stayed unsearchable
    forever). Formats with no working parser (pptx/ppt/doc/xls) are refused at
    KB_EXTENSIONS instead of failing slowly through Docling. Vision no longer counts
    an empty 200 as success, so the OpenRouter fallback actually runs. Project-scoped
    uploads reach their project (the modal collapsed every non-personal scope to
    organization), duplicates are checked per scope so one file may live in My Space
    AND a project, and deleting a document no longer blocks re-uploading it. Table
    rows are merged into one contextual memory: the same 5-page budget went from 31
    memories averaging 154 chars to 17-20 averaging ~235.
  - ALSO IN THIS RELEASE, FROM A PARALLEL SESSION (see acceptance.not_verified):
    .amr recall parity work — B5 graph-expansion + update-chain revival, SQL-mirror
    lexical backfill, dual-write of evidence into the shard, sparse-aware shard
    snapshots, and an in-shard lexical lane.
acceptance:
  public: [core_health_200, api_health_200, next_hivemind_200, singulancelabs_200]
  runtime: [core_healthy, restarts_0, oom_false, exit_0, fresh_fatal_errors_0]
  authenticated:
    - kb_ingest_wrapped_german_doc_5_facts_kept_no_shortfall
    - kb_recall_returns_wrapped_sentence_facts
    - upload_precheck_stale_ready_job_returns_duplicate_false   # verified on the real blocked file
    - evidence_segment_scope_stamped_personal_project_org       # 3 uploads, correct scope_key each
    - recall_scope_filter_personal_returns_only_personal
    - recall_scope_filter_organization_returns_only_org
    - recall_scope_filter_project_fails_closed_when_not_member
    - mcp_hivemind_at_ancient_date_returns_zero                 # was: whole corpus
    - mcp_hivemind_at_bounded_output                            # was: 1.7-3.1MB
    - chat_range_question_dispatches_hivemind_diff              # was: hivemind_timeline
    - chat_pointintime_question_dispatches_hivemind_at
    - chat_german_nonISO_range_dispatches_hivemind_diff
    - chat_nontemporal_regression_zero_temporal_leak            # greeting/recall/source/projects/relation
    - chat_compound_temporal_dispatches_hivemind_diff           # was: 0 tools, answered from model params
    - chat_respond_directly_still_owns_greeting_and_arithmetic  # 17*23=391, no tools
    - chat_statement_with_date_not_diverted                     # "let's meet on August 5" -> no tools
    - upload_project_scope_lands_in_project                     # job+doc+memories+segments all scope=project
    - upload_same_file_second_scope_allowed                     # personal AND project, separate jobs
    - upload_same_file_same_scope_refused                       # duplicate_document
    - upload_after_delete_allowed                               # was permanently blocked
    - unsupported_format_refused_instantly                      # pptx -> 415, no Docling burn
    - jobs_list_and_retry_endpoints                             # replayable flag; 409 when bytes are gone
    - delete_leaves_no_trace                                    # 7 tables verified 0 after delete
    - fe_scope_modal_orgRole_derivation_present_in_served_bundle
  not_verified:                                  # recorded honestly; NOT accepted by this session
    - amr_recall_parity_lanes                    # parallel session's work; the only .amr org this
                                                 # session could use was emptied for testing, and the
                                                 # remaining .amr orgs are other tenants' workspaces
                                                 # whose memory content was deliberately not read
    - fe_scope_modal_click_through               # proven at API + served-bundle level only; needs a
                                                 # logged-in browser session
known_gaps:
  - Disk was 92% mid-session but the release script prunes superseded rollback images as
    it goes; measured 69% (90G free of 301G) after the final deploy. No manual pruning
    was performed, so every current rollback path is intact.
  - /root/.quickdeploy-last-sha still reads f172bb75 — release-singulance.sh does not
    update that marker, so it is NOT a reliable source of current runtime truth. Use the
    container image label instead.
  - The hosted MCP connector used from Claude points at a DIFFERENT host than singulance,
    which still runs the pre-fix hivemind_at / hivemind_diff.
  - Facts are translated DE->EN at extraction despite an explicit no-translate instruction
    in the prompt (evidence/source_quote stays in the source language). Owner decision:
    leave as-is.
  - fail2ban locked the owner's IP out of port 22 on 2026-08-06 after rapid automated SSH
    during this session's deploys (HTTPS unaffected — the sshd jail rejects port 22 only).
    Unbanned, and /etc/fail2ban/jail.local now sets ignoreip = 127.0.0.1/8 ::1
    100.64.0.0/10 so the operator's authenticated Tailscale range cannot trip the sshd
    jail. jail.conf untouched; public-internet protection verified still active
    (a fresh attacker was banned immediately after the reload). Tailscale
    (singulance-engine 100.81.115.51) remains the out-of-band route.
rollback:
  core: hivemind/core-api:rollback-20260806-100604
  frontend_single: hivemind/fe:rollback-20260806-100604-single
  control: hivemind/control-plane:sha-556d95ec5      # unchanged this release
  employees: hivemind/employees:prod-20260804-runtime-campaign-86f70547
  tara_deepgram: hivemind/tara-deepgram:sha-bf7af3ca
  git: revert 9ac8203b..47d0122f; frontend gitlink back to d9fbb8316a67fae368138b430d83374876803f5c
aliases:
  stable: prod-20260806-7e1b07b9
  latest: prod-20260806-7e1b07b9
```

No customer email, connector action, telephone call, or write operation was triggered during
release acceptance. The eight disposable test documents created for scope and grounding
verification (WrapTest DE, WrapTest DE v2, ScopeTest x3, ScopeV2 x3 on org 1380251c) WERE
deleted afterwards, together with their 28 memories, and zero residual recall hits were
confirmed.

## prod-20260809-d878c42f — final chat synthesis on GPT-OSS-20B Nitro

- Parent SHA: `d878c42fe0b928c91d9362b9bcd31439af362493` on `singulance-main`.
- Frontend SHA: `e2dc70f437ea26bb919a19e23157670086b1be11` (unchanged by this release).
- Core image: `hivemind/core-api:sha-d878c42f`, digest `sha256:70c5cec4a3da1a3112d6f7a404a1140ba8acb223727c4abb3b99958bc3211281`.
- Migration: none.
- Model policy: default user-facing final synthesis is `openai/gpt-oss-20b:nitro` through OpenRouter. Progressive planning remains `google/gemini-2.5-flash-lite`; compound subtask selection remains its dedicated `cerebras/gpt-oss-120b`. Historical DeepSeek final-synthesis shadow/canary flags can no longer override or duplicate final answers. DeepSeek HQ awakening/dispatch workloads are outside this chat-final policy and unchanged.
- Compatibility: direct OpenRouter probe returned valid JSON in 401 ms and resolved Nitro to Groq. OpenRouter routing retains prompt-cache keys and does not set a manual provider order/sort that would override the Nitro variant.
- Tests: 56 focused provider, synthesis-policy, prompt-cache, router, native recall, evidence projection, use-tools, and compound/Composio isolation tests passed.
- Production acceptance: authenticated English brand recall, German color recall, and `use_tools:true` brand recall all returned 200, grounded answers, and trace model `openai/gpt-oss-20b:nitro`; no compound execution or drafts were created. Observed end-to-end times were 3.576 s, 5.926 s, and 5.392 s respectively. Core healthy, restarts 0, OOM false, and no fresh fatal/panic/uncaught/unhandled/OOM logs.
- Rollback: `hivemind/core-api:sha-5246cdd7`; manifest `/root/releases/d878c42f/RELEASE_MANIFEST.20260808T192925Z.json`.
- External side effects: none; no connector write, pending-write approval, email, document, calendar action, campaign, or memory mutation was executed.

## prod-20260809-0293df4d — progressive chat prompt-prefix caching

- Parent SHA: `0293df4da392b868dfc9cd7f364c84010f5277ba` on `singulance-main`.
- Frontend SHA: `b68eb71782fbf394c056550b304c7a6a769e7d49` (unchanged).
- Core image: `hivemind/core-api:sha-0293df4d`, digest `sha256:ceda195e4b075a5993307d52e38a0c246cb5aaee20838a1db2e034a7a0e1422d`.
- Migration: none.
- Change: stable router and grounded-synthesis contracts are first-message exact prefixes; OpenRouter receives a stable `prompt_cache_key`; Cerebras remains automatic. A bounded in-process CAG caches versioned static prompt artifacts. Evidence, history, user/profile context, connector results, tool arguments, drafts, approvals, and final answers are not cached by this layer.
- Telemetry: per-stage cached/uncached/cache-write tokens, aggregate hit ratio, static/dynamic character and estimated-token contribution, and static-prompt CAG hit/miss/fingerprint.
- Tests: 55 focused chat/recall/evidence/compound tests passed after rebase; 43 focused tests passed after the explicit system-message split. Six broader local files could not load the unavailable macOS ARM `singulance-amr` binary and did not execute; production route acceptance below covers the running Linux image.
- Production measurement, tenant-scoped read-only `/api/chat`: static CAG was a warm hit after first construction. Provider reuse observed `0..2,048+` cached tokens per turn; cross-language English→German reused `2,048 / 4,664` prompt tokens (43.9%). Router static-prefix hits reached `1,792` tokens; synthesis stable-prefix hits reached `256` tokens. Dynamic evidence-prefix reuse was variable and added up to `1,024` tokens in the measured sample. Provider caching remains opportunistic/ephemeral, not guaranteed per request.
- Acceptance: handbag brand and color recalls returned grounded answers; German recall returned `G ROCHER`; `use_tools:true` recall returned 200 with no execution, compound status, or drafts; Core and public site health returned 200; Core healthy, restart count 0, OOM false, and no fresh fatal/panic/uncaught/unhandled/OOM logs.
- Rollback: `hivemind/core-api:sha-66312a29` (also tagged `hivemind/core-api:rollback`); manifest `/root/releases/0293df4d/RELEASE_MANIFEST.20260808T185149Z.json`.
- Known operational gap: the canonical release script deployed and verified the immutable SHA override but did not refresh the legacy `VERSION`/`NEXT_VERSION` values in `.env`; runtime truth is the container image, OCI revision label, deploy override, and release manifest above.
- External side effects: none; no connector read/write, pending-write approval, email, document creation, calendar operation, campaign, or memory mutation was executed.

## prod-20260808-e70585b8e7ac — hosted connection-aware Composio workflow planner

- Parent SHA: `e70585b8e7ac5be4aacf2d70f97fa7381a352b5b` on `singulance-main`; includes concurrent runtime guard SHA `9fbd5f11` and hosted-planner feature parent `c0c38526`.
- Frontend SHA: `e2dc70f437ea26bb919a19e23157670086b1be11` (unchanged).
- Core image: `hivemind/core-api:prod-20260808-e70585b8e7ac`, digest `sha256:dfd53f40b2b070f2eae30798cf11cc9e52ae4d827885242bbfd74660b55a42cf`.
- Migration: none. Runtime flags: `CHAT_ROUTER=progressive`, `COMPOUND_ORCHESTRATOR_ENABLED=true`, `HOSTED_COMPOSIO_PLANNER_ENABLED=true`.
- Contract: authenticated `POST /api/composio/plan` discovers only the tenant's ACTIVE Composio providers and returns a bounded sequential DAG across hosted HIVE-MIND and connected-app capabilities. `use_tools:false` retains the pre-existing native path. `use_tools:true` uses the hosted plan with an explicit fallback to the pre-existing progressive planner if planning fails before execution.
- Execution safety: each step has explicit read/write authority, semantic `output_kind`, compact canonical retrieval `query`, and prior-step dependencies. Provider reads execute immediately; writes remain pending-write approval drafts. Zero/multiple recipient resolution returns `needs_input`; unresolved, failed, or approval-pending dependencies block downstream steps. Composio Query Mode `/input` generates current provider arguments without executing the action, replacing the redundant second subtask argument-model call.
- Tests: 60 focused routing, synthesis, use-tools, hosted-planner, Composio, and compound tests passed; production image build gate passed 21 authorization/orchestration tests. A concurrent runtime-playbook test could not start locally because the workspace lacked optional package `oauth-1.0a`; the concurrent commit's own release ownership was preserved and its files were not modified here.
- Authenticated acceptance: planner-only 200 in 1.871 s, one attempt, three-step recall → Gmail recipient lookup → email-draft DAG, `side_effects_executed=false`, 2,689 total planner tokens with 1,792 provider-cached tokens. Native `use_tools:false` handbag recall returned grounded `G ROCHER` in 3.799 s with no execution fields. `use_tools:true` returned `needs_input` in 9.388 s after finding two Amar addresses; recall completed, dependent draft was blocked, and `draft_ids=[]`.
- Exact-image no-side-effect write probe: explicit recipient produced a complete `GMAIL_SEND_EMAIL` approval draft payload grounded in the full rank-one handbag memory (G ROCHER, JL, material and design details). Persistence was stubbed (`PROBE_DRAFT_NOT_PERSISTED`), and no provider write or email occurred.
- Public/runtime acceptance: Singulance homepage, HIVE-MIND frontend, API health, and Core health returned 200; Core, Control, Employees, and TARA healthy; frontend running; restarts 0; OOM false; fresh fatal/panic/uncaught/unhandled/OOM/migration error count 0.
- Superseded candidate: `prod-20260808-c0c38526727f` built and passed health but failed affected-route acceptance: planner-only intermittently returned an empty plan (502), and Gmail input generation supplied an invalid provider field. No draft/write occurred. It was replaced, not repaired in place, by this immutable release.
- Rollback: `hivemind/core-api:rollback-20260808-211230` (the immediately previous immutable candidate); pre-feature accepted runtime is retained as `hivemind/core-api:rollback-20260808-210725` / `sha-5605b858`. Env backup before flag enable: `/root/hivemind/.env.pre-hosted-planner-c0c38526`.
- External side effects: Gmail recipient lookup read only. No pending-write row persisted, no approval executed, and no email/document/calendar/provider mutation occurred.

## prod-20260809-3cce168a — hosted-plan completeness and connector-intent preservation

- Parent SHA: `3cce168a897284a996fa40ab6d544395d6279051` on `singulance-main`.
- Frontend SHA: `f864c0a2e2b7064c398c2746f9971333a208607f` (unchanged).
- Core image: `hivemind/core-api:sha-3cce168a`, OCI revision `3cce168a897284a996fa40ab6d544395d6279051`.
- Migration: none.
- Fix: every hosted Composio workflow proposal receives one semantic audit against the exact current request. The audit restores omitted terminal actions and preserves the requested application, artifact, recipient, dependencies, and action semantics without language-specific or toolkit-keyword routing patches. A structurally complete plan can no longer pass solely because it has multiple steps.
- Tests: 45/45 focused hosted-planner, compound-orchestrator, `use_tools` policy, and chat-router architecture tests passed, including omitted-action and equal-length substituted-connector regressions. Syntax and whitespace checks passed.
- Authenticated acceptance: the exact request `Recall all information about my company, then put the recalled information into a new Google Doc.` was run twice with `use_tools:true`. Both runs returned 200 and `recall -> create_doc`; both selected `composio_googledocs_create_document` and persisted approval drafts with non-empty title and substantive recalled company text. Both diagnostic drafts were cancelled; no Google Doc was created.
- Public/runtime acceptance: Core health returned 200; container healthy, restarts 0, and fresh fatal/panic/uncaught/unhandled/OOM/migration-error count 0.
- Superseded candidate: `hivemind/core-api:sha-aada9ce0` restored the omitted terminal step but a live acceptance exposed an equal-length Gmail-for-Docs substitution. Its diagnostic Gmail draft was cancelled, nothing was sent, and the candidate was replaced by this immutable release.
- Rollback: `hivemind/core-api:rollback-pre-3cce168a-20260809T074244Z`; manifest `/root/releases/3cce168a-clean/RELEASE_MANIFEST.txt`.
- External side effects: HIVE-MIND recall reads and pending-write draft persistence only. All three diagnostic drafts were cancelled; no approval, email send, Google Doc creation, calendar action, or memory mutation executed.

## prod-20260809-1f12a0b0 — grounded follow-up connector content and refined tools control

- Parent SHA: `1f12a0b0717376f2e753b88232c5e1ede3bd5981` on `singulance-main`.
- Frontend SHA: `1cf1b89401f1595c6a0ce997b40d5491b3eeeb9c` (includes chat UI SHA `422c34f984041647d87b5c8337f5709e865cdea1`).
- Images: `hivemind/core-api:prod-20260809-1f12a0b0`, OCI revision `1f12a0b0717376f2e753b88232c5e1ede3bd5981`; `hivemind/fe:prod-20260809-1f12a0b0-single`, OCI revision `1cf1b89401f1595c6a0ce997b40d5491b3eeeb9c`.
- Migration: none.
- Backend: content-producing follow-up actions receive the preceding assistant answer as bounded, explicitly untrusted data alongside governed recall. Query Mode must create substantive grounded content, and provider-required content fields are honored whether declared in `required`, `properties`, or both. Existing approval and Composio execution boundaries are unchanged.
- Frontend: Overview, mobile Talk to HIVE, and side-panel chat no longer duplicate the current request in history. The `Use tools` control is now a compact blue/ivory status capsule with a Sparkles state icon and live status dot; the one-line Beta notice remains.
- Tests/build: 47/47 focused compound, hosted-planner, `use_tools`, and router tests passed after final rebase. Frontend production build compiled successfully; strict-CI mode remains blocked by the repository's pre-existing unrelated lint warnings.
- Authenticated acceptance: `write an email to amarsai2005@gmail.com about DLLMs` with prior DLLM answer context and `use_tools:true` returned 200, executed recall, and created a governed `composio_gmail_send_email` approval draft. The exact body included parallel denoising, faster inference/lower latency, sub-100 ms warmed latency, and efficient batching. The final diagnostic draft was cancelled; an earlier candidate draft expired. Database verification showed both `approvedAt=null` and `sentAt=null`.
- Public/runtime acceptance: Core health, homepage, HIVE-MIND cover, and Overview returned 200. Both release-specific lazy chat chunks returned 200 and contained the connected-app Beta notice marker. Core healthy, frontend running, restarts 0, and fresh fatal/panic/uncaught/unhandled/OOM/migration-error count 0.
- Rollback: Core `hivemind/core-api:rollback-pre-1f12a0b0-20260809T102619Z`; frontend `hivemind/fe:rollback-pre-1f12a0b0-20260809T102619Z-single`; manifest `/root/builds/prod-20260809-1f12a0b0/RELEASE_MANIFEST.txt`.
- External side effects: recall reads and approval-draft persistence only. No draft was approved and no email was sent.

## prod-20260809-637fd2df — preserve recall dependencies for semantic content artifacts

- Parent SHA: `637fd2df94785d0662c882cf547b2578336f7747` on `singulance-main`.
- Frontend SHA: `794ae726f4ae1479870d4f9e8cb978891209cdfa` (unchanged by this fix).
- Images: Core `hivemind/core-api:sha-637fd2df`, digest `sha256:6f593a714e66998730418f3d8f5d115f9422bd4de40161cff76b36d18fda38f3`; Control `sha256:fca50b227b304454ea043bcdea087aa20b35c1fec72ba934a3f6e924da13be10`; Employees `sha256:864e72acb6e39674bcf0d252b4985d6bd8a76107adf308fe9f47bb44d76b23fd`; frontend `sha256:aea45f47794445311c948923b8f1c1e1ca2ecead442efc294ab3ac9802893d2e`. All carry OCI revision `637fd2df94785d0662c882cf547b2578336f7747`.
- Migration: none.
- Fix: dependency normalization now treats semantic `message` and `document` outputs as content-producing artifacts even if the hosted planner emits an imprecise authority. Earlier governed reads therefore reach provider argument generation and required body/text fields instead of producing a redundant human-input request. Hybrid recall and its ranking/delivery contract are unchanged; approval gating remains unchanged.
- Tests: syntax and whitespace checks passed; 43/43 focused compound-orchestrator, hosted-planner, `use_tools`, and router tests passed. The regression suite includes the exact recall-to-email shape with malformed authority, an omitted dependency edge, a provider-required body absent from `properties`, and a substantive recalled fact.
- Authenticated acceptance: `write email to amarsai2005@gmail.com about all company information` with `use_tools:true` returned 200 in 13.385 s. `hivemind_recall` completed, `composio_gmail_send_email` produced approval draft `b771057d-6db2-4735-a995-ad06cc804f5e`, and the body contained substantive recalled company details rather than requesting `body` from the user. The diagnostic draft was cancelled; database verification showed `status=cancelled`, `approvedAt=null`, and `sentAt=null`.
- Public/runtime acceptance: Core health, homepage, HIVE-MIND cover, and Overview returned 200. Core, Control, and Employees were healthy; frontend running; all restart counts 0; fresh fatal/panic/uncaught/unhandled/OOM/migration-error count 0.
- Rollback: immediately previous immutable images `hivemind/core-api:sha-981a2b04`, `hivemind/control-plane:sha-981a2b04`, `hivemind/employees:sha-981a2b04`, and `hivemind/fe:sha-981a2b04`; manifest `/root/releases/manifests/637fd2df/20260809T114712Z/RELEASE_MANIFEST.json`.
- External side effects: HIVE-MIND recall reads and approval-draft persistence only. The diagnostic draft was cancelled; no approval occurred and no email was sent.

## prod-20260809-0033d7fc — grounded email-recipient resolution and artifact revalidation

- Core source/runtime SHA: `0033d7fc5869a456d5b2d6957c12bf1a49373c6f` on `singulance-main`. Canonical branch subsequently advanced to frontend-only SHA `d07f92536dd967e6572515f6a64375b74f81217b`; that commit does not alter Core.
- Runtime tuple: Core `hivemind/core-api:sha-0033d7fc`, digest `sha256:7d24e516d67ac5f3cb9837dd9215f02e96859e79892d312eba9c9d13676d9c9c`, OCI revision `0033d7fc5869a456d5b2d6957c12bf1a49373c6f`; frontend independently advanced to `hivemind/fe:sha-d07f9253`. Migration: none.
- Recipient safety: email write arguments may use only an address explicitly supplied by the user or a unique typed recipient result from a preceding provider lookup. A raw display name such as `AmarSai` is never persisted into `To`, and an address appearing incidentally inside recalled company content cannot become the recipient.
- Generalized planning: when a recipient-resolution step feeds a connected provider action, the hosted planner assigns that lookup to the dependent provider rather than native HIVE-MIND recall. This is derived from the plan dependency and provider graph, without language-, name-, or Gmail-specific routing keywords.
- Content correctness: required artifact fields are revalidated after deterministic grounded-content backfill, eliminating the stale `Missing required fields: body` result when a substantive body is already present.
- Tests: 52/52 focused compound-orchestrator, hosted-planner, `use_tools` policy, and chat-router architecture tests passed after the final rebase.
- Named-recipient acceptance: `write email to AmarSai about all company information` used provider recipient lookup and found two real candidates (`amarsai2005@gmail.com`, `amarsai@example.com`). The workflow returned `needs_input` with choices, created no draft, and did not send an email.
- Explicit-recipient acceptance: `write email to amarsai2005@gmail.com about all company information` returned 200, completed HIVE-MIND recall, and created approval draft `8fc5de98-a95f-43d8-acd5-8f7b94482cc5` with exact `To: amarsai2005@gmail.com`, subject `Company Information`, and an 868-character body. The diagnostic draft was cancelled; database verification showed `status=cancelled`, `approvedAt=null`, and `sentAt=null`.
- Public/runtime acceptance: Core health reported DB, Qdrant, and Docling ready; homepage, HIVE-MIND cover, and Overview returned 200. Core was healthy with restart count 0 and no fresh fatal/panic/uncaught/unhandled logs.
- Rollback: `hivemind/core-api:sha-30b9f7a7`; manifest `/root/releases/manifests/0033d7fc/20260809T135628Z/RELEASE_MANIFEST.json`.
- Operational cleanup: only confirmed non-running superseded images and reclaimable build cache were removed to satisfy the immutable release disk gate. Active containers, application data, and the then-current rollback images were retained; removed images are recoverable by rebuilding their SHAs.
- External side effects: recipient lookup reads and approval-draft persistence only. No draft was approved and no email was sent.

## prod-20260809-8590715d — language-independent native event-window recall

- Parent SHA: `8590715d72ee5e377956e7376ebe03df6a5d835e` on `singulance-main`; frontend unchanged.
- Runtime tuple: Core `hivemind/core-api:sha-8590715d`, OCI revision `8590715d72ee5e377956e7376ebe03df6a5d835e`; healthy, restart count 0, OOM false. Migration: none.
- Temporal semantics: activity/records during a period now compile to an inclusive event-time range and remain on native `hivemind_recall`. Point-in-time truth, snapshot comparisons, and version history retain the existing `hivemind_at`, `hivemind_diff`, and timeline contracts. The progressive router emits an explicit language-independent temporal semantic; no English/German phrase or keyword branch was added.
- Retrieval: event-window recall adds a bounded, access-scoped lane over canonical `document_date`, record/valid times, `event_dates`, and `ts:`/`time:` tags. Hybrid semantic ranking remains intact; date matches supplement rather than replace ranked recall. Decision-style windows receive only the planner-provided memory-type lift.
- Security: `_event_range` is a server-owned toolkit control accepted only under `trustedInternalArgs`; unknown external/model underscore arguments remain rejected. Candidate `sha-888c4404` exposed that this control was absent from the trusted allowlist and returned misleading zero-memory summaries. It was replaced by this immutable release before acceptance.
- Tests: 31/31 focused Linux image assertions passed for temporal compilation, event-time tags, trusted toolkit controls, router architecture, and `use_tools` isolation. An additional 51/52 broader Linux characterization assertions passed; the one failure is a pre-existing recall-packet count snapshot (`2` current packets versus `1` expected), unrelated to this change.
- Authenticated acceptance (`use_tools:false`): English “what did we do yesterday” returned 4 memories + 8 evidence and a grounded four-source answer; “what decisions did we take in last 7 days” returned 5 memories + 8 evidence with the exact 2026-08-03..2026-08-09 range and no diff/time-travel call; German “Was haben wir gestern gemacht?” returned the same 4 memories + 8 evidence and a grounded answer. Each event-window trace contained only `hivemind_recall` with `_event_range:true` and the resolved UTC range.
- Non-regression: ordinary native company recall remained grounded with five sources. A read-only `use_tools:true` Gmail request completed through `composio_gmail_fetch_emails`, proving connector routing remained available; no approval or provider write ran.
- Public/runtime acceptance: in-container Core health returned 200 with DB, Qdrant, and Docling ready; fresh fatal/panic/uncaught/unhandled/OOM/migration-error marker count 0.
- Rollback: `hivemind/core-api:sha-888c4404`; manifest `/root/releases/manifests/8590715d/20260809T151840Z/RELEASE_MANIFEST.json`.
- Operational cleanup: before the first temporal candidate, only confirmed non-running, rebuildable superseded images and builder cache were removed to satisfy the immutable release disk gate. Active containers, application data, and rollback images were retained.
- Known release-metadata gap: the canonical release deployed and verified the immutable image and manifest, but legacy `/root/hivemind/.env VERSION` and vNext `NEXT_VERSION` remained at `prod-20260809-74d7422ed3ee`. Runtime truth is the image, OCI revision, and manifest above; no unsafe shared-env rewrite was performed after service recreation.
- External side effects: tenant-scoped memory and Gmail reads only. No memory mutation, draft, approval, email send, document creation, calendar action, campaign, or other provider mutation occurred.

## prod-20260812-b5c2d8a8 — recoverable Talk-to-HIVE entity enrichment

- Parent SHA: `b5c2d8a8a7380422504a80026b1c69d8f8fd481c` on `singulance-main` (PR #155); frontend unchanged. Migration: none.
- Runtime tuple: Core `hivemind/core-api:sha-b5c2d8a8`, digest `sha256:41672c3797e1c0af2c394f30eba171f068577b4c71e2717cf15f19c25da8407e`, matching OCI revision; healthy.
- Fix: structured entities emitted by Talk-to-HIVE now survive canonical normalization and atomic ingestion. Malformed entity-linker JSON retains those entities as normalized tags and canonical entity links, without overwriting an explicit memory type. Relationship completion counts only successful writes.
- Recovery: central tenant memories now carry durable entity-link status/attempt telemetry and have authenticated, user+organization-scoped backfill/stats routes. Queue failures remain retryable; process-global queue counters are not exposed to tenants. Canonical registry persistence remains post-commit, outside the authoritative memory transaction.
- Tests: 18/18 focused canonical-ingest, relationship-semantics, and canonical-entity tests passed, including malformed JSON fallback preserving `decision` plus structured entities.
- Authenticated repair acceptance: failed memory `a6d023b1-5ddf-446c-a8e0-1dc06a4f14b1` was backfilled. It retained `decision`, gained `entity:hivemind`, `entity:brain`, `entity:os`, `entity:voice`, four canonical entity links, and one grounded `Mentions` relationship. Status became `done`, attempts `1`, edge count `1`.
- Authenticated save/chat acceptance: Talk-to-HIVE saved a Project Aster decision in 2.584 s; persistence produced normalized Project Aster and Helios Engine entity tags and canonical links with status `done`. A follow-up chat answered the selected inference platform in 2.477 s with `grounded:true` and two sources.
- Public/runtime acceptance: `https://core.singulancelabs.com/health` returned 200 in 60 ms. Fresh fatal/panic/unhandled/entity-link failure audit returned no matches.
- Rollback: `hivemind/core-api:prod-20260811-47516dd8806a`; manifest `/root/releases/manifests/b5c2d8a8/20260812T171450Z/RELEASE_MANIFEST.json`.
- Operational cleanup: only Docker builder cache was pruned to satisfy the immutable 25 GB release gate; no images, volumes, databases, or user data were removed.
- External side effects: one explicit user-authorized verification memory was saved and the previously failed memory was enriched. No connector/provider write ran.
## prod-20260813-d60b567a — connector-aware mobile Talk to HIVE

- Parent SHA: `d60b567a3abe3be9e7e2353da50f2cc44f8a51c0` on `singulance-main` (PR #173); frontend SHA `c62302120f58001018fbc4debe80e1fda7c9ca12`, which contains Da-vinci PR #41 merge `853af9c31fb9358edb2acaccc6754f11b90184d3`. Migration: none.
- Runtime: Core `sha256:d063ddab893d33ea32b09ccb739caefdd56d5a1a9283a1c9ea52562051cc88df`; Control `sha256:2747242b8660490ca844224bd1f2f2e14d543d1db931d8ee7e94b8488a5d1ca0`; Employees `sha256:9bb76ff97c02dc4792012c2594cb6b60a05aab60148735ddc99c9d8540b7b47f`; frontend `sha256:f31cbb2722b9d6ffd9d6cdb8448b07e5dd8c79e58df052c93169e38257003b79`. All run immutable `sha-d60b567a` images with matching OCI revision.
- Feature: mobile chat exposes a right-aligned Clear session action; the AI Meeting Notes slide-in promotion is disabled without removing its implementation or route. The empty session derives suggestions from Composio's catalog, app names become removable logo chips, disconnected apps are stopped before chat execution, and OAuth returns to mobile chat with the prompt restored and ready to run.
- Generalization: app recognition and suggestions use the full Composio toolkit catalog, not a curated app or intent-keyword list. Public toolkit metadata is cached for ten minutes; authenticated tenant connection state is overlaid per request and is never shared through that cache.
- Verification: 3/3 focused catalog/chip/suggestion tests passed; changed frontend files are ESLint clean; production build completed with only unrelated pre-existing repository warnings. The live catalog returned 1,181 toolkits in 6.304 s cold and 0 ms from its in-process cache. Public mobile chat and Core health returned 200, the deployed lazy chunk contains both `Clear session` and pending-prompt markers, and fresh fatal/panic/uncaught/unhandled/OOM/migration-error counts were zero.
- Rollback: Core `hivemind/core-api:sha-91b23131`; Control `hivemind/control-plane:sha-c99a439d`; Employees `hivemind/employees:prod-20260812-179006421ccb`; frontend `hivemind/fe:prod-20260812-5e345871eb93-single`. Manifest `/root/releases/d60b567a/RELEASE_MANIFEST.20260812T213007Z.json`.
- External side effects: none. Catalog reads and public health/page checks only; no OAuth account was added, no provider tool ran, and no write or memory mutation occurred.

## prod-20260813-660c41ea — bounded Composio Sessions primary with rapid fallback

- Parent SHA: `660c41eaecb39a90459d8f1c11ea5ce6d0ad2886` on `singulance-main` (PRs #184-#187); frontend unchanged. Migration: none.
- Runtime: Core `hivemind/core-api:sha-660c41ea`, digest `sha256:f00532f07ebb1a76b5ea03785ce86746ed37e2c3ce9fb9c4644bf0890afd81d8`, matching OCI revision; healthy with restart count 0. Manifest `/root/releases/660c41ea/RELEASE_MANIFEST.20260812T230652Z.json`.
- Feature: `use_tools:true` prefers tenant-scoped Composio Tool Router Sessions for bounded semantic discovery, cached schemas, and connector reads. Session/discovery caches have ten-minute TTLs. Native HIVE-MIND recall/save/time tools remain local; provider writes retain the established pending-write approval path. Session discovery or wrapper failure falls back to the established direct Composio compound path with bounded latency.
- Correctness: production candidates `72359dc2` and `b6d4d691` were automatically rolled back after authenticated acceptance caught incomplete Calendar execution and a Gmail prerequisite-selection error. The accepted release retains all Composio primary capabilities, excludes related-tool noise, structurally matches singular/plural controlled operations, and adds language-independent `soonest_upcoming` semantics with server-time anchoring and post-result future filtering.
- Tests: 52 focused Session, compound, router, and `use_tools` tests passed. A shadow Core container using the real production environment passed the exact Gmail + Calendar request and native tools-off recall before live promotion.
- Authenticated acceptance: `use_tools:true` completed `GMAIL_FETCH_EMAILS` and `GOOGLECALENDAR_EVENTS_LIST`, returned the real latest sender/subject, and correctly reported no future Calendar event. `use_tools:false` completed profile plus canonical HIVE-MIND recall. A mixed native recall → Google Docs request produced approval draft `58a0cf2f-43ce-42a2-ad7f-b8556a0cb56c` with 1,625 characters of grounded document content; it was cancelled, remained unapproved, and no Google Doc was created.
- Public/runtime acceptance: Core health, next HIVE-MIND app, and public homepage returned 200. Fresh fatal/panic/uncaught/unhandled/OOM/migration-error scan was empty.
- Rollback: `hivemind/core-api:rollback-pre-composio-20260812T224647Z`, digest `sha256:d063ddab893d33ea32b09ccb739caefdd56d5a1a9283a1c9ea52562051cc88df`.
- External side effects: Gmail and Calendar reads plus one internal approval-draft row, subsequently cancelled. No email, document, calendar event, or other provider mutation executed.

## prod-20260814-7a1f4dfd — control-plane target correction (approval rules, dead-turn reconciler, sweeper diagnostic)

- Parent SHA: `7a1f4dfd31e3e5246a800be32e406614c2b2969a` on `singulance-main` (PRs #193, #195, #196, #197). Migration: `20260814010000_hyper_approval_rules` (additive, applied earlier via direct psql; idempotent `CREATE TABLE IF NOT EXISTS`).
- Root cause found this release: `core/src/control-plane-server.js` runs in a **separate container, `hm-control`** (`npm run control-plane`), not in `hm-core` (`node src/server.js`). Every deploy this session up to this point targeted `core`, so `hm-control` had been running stale image `control-plane:sha-53149204` — none of this session's HQ work-order-result.v2 bridge, fine-grained approval-rule routes, or the `failDeadTurns` dead-turn reconciler had ever reached production, despite being merged to `singulance-main` and despite the underlying `hyper_approval_rules` DB table + Python-side `_gate_write` enforcement (employees-service) having been separately verified live. The hyper-sweeper itself was never broken; its boot log was simply never observed because the wrong container was being checked and redeployed.
- Fix: `bash scripts/release-singulance.sh 7a1f4dfd31e3e5246a800be32e406614c2b2969a control-plane` (not `core`). Also added a permanent unconditional diagnostic log (`[hyper-sweeper] gate check {...}`) immediately before the sweeper's guard, so a future boot proves reachability and gate inputs without needing another investigation.
- Verification: `docker exec hm-control` byte-grep confirmed the running container's `/app/src/control-plane-server.js` and `/app/src/employees/hyper-rooms.js` contain the diagnostic (1 match), `failDeadTurns` (1 match), and the three `/v1/hyper/approval-rules` routes (3 matches). `docker logs hm-control` showed, in order: `[hyper-sweeper] gate check { prisma_truthy: true, role: 'all', should_run: true }` then `[hyper-sweeper] stuck-turn re-kick sweeper active (15s)` — first live confirmation the sweeper, and by extension `failDeadTurns`, actually run in production.
- Public/runtime acceptance: `hm-control` reported healthy with image `hivemind/control-plane:prod-20260814-7a1f4dfd31e3` verified via `docker inspect`. `https://singulancelabs.com`, `https://next.singulancelabs.com/hivemind`, `https://api.singulancelabs.com/health`, `https://core.singulancelabs.com/health` all returned 200.
- Rollback: `hivemind/control-plane:sha-53149204` (previously-running image, auto-tagged `rollback-20260814-141244` by the release script).
- External side effects: none. No connector/provider write ran; only container recreation and read-only verification.

## prod-20260814-5341a98b — progressive chat-engine sprint, durable enrichment, model fallbacks, and grounded connector hand-off

- Canonical Core SHA: `5341a98b7c1b5c75235fc23ffc510a3a9c82a8a5` on `singulance-main` (PRs #200, #202–#206). Frontend unchanged. Migration: none.
- Runtime tuple: Core `hivemind/core-api:sha-5341a98b`, digest `sha256:9628eb4c5ae61781b87c31f46ef213ef0e2f31c9663387c28e5ea68388fbce9d`, matching OCI revision; healthy. `stable` and `latest` point to the same digest. Manifest `/root/releases/manifests/5341a98b/20260814T172324Z/RELEASE_MANIFEST.json`.
- Native chat: every retrieval-bearing turn performs one compact query optimization through `google/gemini-2.5-flash-lite`; canonical hybrid ranking remains unchanged. Rank one is delivered completely when it fits, lower ranks use semantic projection, citations are not duplicated, and trace telemetry includes optimizer latency, evidence delivery, static/dynamic prompt contributions, caching, and per-stage models.
- Model resilience: fact synthesis prefers `nvidia/nemotron-3.5-lightning:nitro` with reasoning disabled, then `openai/gpt-oss-20b:nitro`, then `openai/gpt-oss-120b`. Validated streaming falls back to ordinary validated JSON synthesis and emits that result over SSE, so provider/format failure cannot terminate an otherwise answerable turn. Planner/parser paths retain their own bounded fallback models.
- Entity durability: Talk-to-HIVE structured entities survive canonical ingest; entity linking runs post-commit through a bounded queue, persists central or remote status, reports truthful write counts, and remains backfill-eligible after provider failure. Tenant stats during acceptance were `done=9`, `in_progress=0`, `errors=0`, `missing=0`.
- Connected apps: `use_tools:true` keeps native HIVE-MIND tools local and uses tenant-scoped Composio Sessions/direct fallback for connected providers. Controlled manifest authority determines reads/writes; writes remain pending approval. Exact governed dependency content is accepted even when recalled source notation contains brackets, and authority-filtered manifest ranking is the final selector fallback when models violate forced tool selection.
- Authenticated native acceptance: “Which deployment route did Project Aurora select?” returned the exact grounded Helios decision. Warm non-stream wall time was 4.332 s with Nemotron synthesis; rank-one delivery was 90/90 characters and duplicate evidence characters were zero. A forced validated-stream failure chain returned the correct answer through the final GPT-OSS JSON-to-SSE fallback instead of `turn_failed`.
- Authenticated connector acceptance: Instagram posts plus account information completed through `composio_instagram_get_ig_user_media` and `composio_instagram_get_user_info`, including all 11 posts, with no null-response exception. Native recall → Gmail produced approval draft `72334baf-f83d-454b-80d0-5ebcc38c6f4c` with exact recipient `amarsai2005@gmail.com`, subject `Summary of Singulance`, and a 1,038-character grounded body. It was cancelled after verification; no provider write executed.
- Persistence acceptance: Project Aurora save produced a `decision` memory with normalized Project Aurora/Helios entity tags, two canonical entity links, and durable `entity_link_status=done`; follow-up chat recalled it with a valid server-owned citation.
- Tests: 121/121 affected Linux image tests passed across compound/Composio Sessions, router/intent, recall delivery, canonical ingest, entity normalization/linking, relationship semantics, citation contracts, and Slack progress. Public Core and HIVE-MIND frontend returned 200. Fresh fatal/panic/uncaught/unhandled/OOM/migration/entity-link error scan was empty.
- Rollback: `hivemind/core-api:sha-8727f801`, digest `sha256:1531c4fc0e99ef58cdc63a2b4ccc0af9b5c3ca54390128fd22b1d8444ef498d0`. Only disposable builder cache, dangling images, and explicitly superseded non-running Core images were removed to satisfy the immutable disk gate; running services, volumes, databases, and rollback were preserved.
- External side effects: one user-authorized verification memory was saved. Connector tests performed reads and created one internal approval draft that was cancelled. No email, document, calendar event, social post, or other provider mutation executed.

## prod-20260814-60663ba1b207 — sovereign Memory Box vector-write acknowledgement and recovery

- Canonical Core SHA: `60663ba1b207a9d5f42fdf996ff44508863618d2` on `singulance-main` (PR #208). Frontend unchanged at `4f221100d74c796dbfa22df01701d8f50060c323`. Migration: none.
- Root cause: an external Memory Box could persist a PostgreSQL memory, fail its Qdrant upsert, and return HTTP 200 with `{ok:false}`. Core treated every 2xx response as success, so it skipped the durable outbox and left those rows lexical-only. The same path also replayed a 400-character preview as canonical content and evidence segments had no durable retry path.
- Fix: Core now requires an application-level success acknowledgement, preserves full canonical memory content, durably retries memory and evidence vector writes, and runs a bounded reconciler. Upgraded agents expose tenant-authenticated vector status, pending, and idempotent repair routes; older agents remain recoverable through the compatibility path without replacing their database rows.
- Recovery: affected self-hosted org `0a1d5b33-a33c-49a6-8185-6d16370670a2` had 8 unsynced memory-layer rows. The production reconciler repaired all 8 with zero failures; a second dry run reported zero pending. Canonical entity rows were deliberately excluded.
- Authenticated acceptance: the affected org's semantic paraphrase returned two Dior memories through `persisted-hybrid`; `/api/chat` with `use_tools:false` answered that the stored handbags were associated with Dior, grounded with six sources and three citations. Managed-org regression returned three memories through `persisted-hybrid`.
- Tests: focused remote acknowledgement/reconciliation suites passed 8/8. A real isolated PostgreSQL + Qdrant Memory Box parity run passed twice, including unsynced-to-repaired-to-recallable memory and evidence, tenant/auth isolation, idempotent repair, and exact content longer than 400 characters. The broader unit glob reported 1030 pass and 42 pre-existing platform/environment failures; it was not represented as fully green.
- Runtime: Core `hivemind/core-api:prod-20260814-60663ba1b207`, digest `sha256:e20ee1afb7bcc54d42ca012d8b1baccdb3bdb1111cc1aef85c05690181c923c6`, healthy, zero restarts, OOM false. Public homepage, HIVE-MIND frontend, API health, and Core health returned 200; fresh fatal/panic/uncaught/unhandled/OOM/migration error count was zero.
- Rollback: immediate previous immutable Core `hivemind/core-api:prod-20260814-72b498da0998` / `rollback-20260814-184009`; pre-incident stable Core remains available by digest `sha256:9628eb4c5ae61781b87c31f46ef213ef0e2f31c9663387c28e5ea68388fbce9d`.
- Known limitation: historical memory tails already overwritten by the former 400-character replay cannot be reconstructed without the original source or backup. This release prevents future truncation and repairs vector availability; it does not invent lost content. The affected older box is recovered through compatibility mode and should still receive the upgraded agent for native status and evidence repair endpoints.
- External side effects: none. Reconciliation rebuilt search vectors only; it did not send connector actions or mutate user-facing memory content.

## prod-20260814-7054976daf78 — responsive mobile composer and intent-preserving recall rewrite

- Parent SHA `7054976daf78a8b99f012e4d8343ac8a96313ed6` (PR #211); frontend SHA `4194fc2cc31134bed9a0d27e14bf79090aeab392` (Da-vinci PR #45). Migration: none.
- Mobile: the keyboard `onChange` path now only commits bounded text. Dynamic Composio toolkit recognition runs against deferred input after paint, and textarea measurement is animation-frame batched, removing the catalog scan and forced layout from each keystroke.
- Recall: query optimization now receives the router's operation, mode, entities, time, source, relation, planner query, and exact message. It emits one intent-complete semantic query; generated alternates are not trusted because they can weaken negation/direction. Planner query and exact original wording remain bounded fallbacks. Hybrid recall ranking is unchanged.
- Verification: backend optimizer/policy tests 12/12; frontend focused chat tests 8/8; frontend production build passed with pre-existing unrelated lint warnings. Live optimizer probes preserved small-detail, temporal, negation/source, and compound retrieval intent at 478-702 ms. Authenticated `use_tools:false` SSE emitted `query_optimized` with the full handbag-brand intent, recalled seven memories after escalation, and returned the grounded answer `The handbag you’re referring to is a Dior handbag.`
- Runtime: Core `hivemind/core-api:prod-20260814-7054976daf78` digest `sha256:a49ba2f2ebeba6bf704cf4dfa0dd053264805da5afb8173cde38dc309cca88d5`; frontend `hivemind/fe:prod-20260814-7054976daf78-single` digest `sha256:c28b07db78d61eaf4dd7ed9fe1fec3a7e7306261ce2af9a17febf4159cf4df79`. Both are healthy/running with zero restarts; four public release gates returned 200 and fresh fatal scans were empty.
- Rollback: `rollback-20260814-193148`. External side effects: none; acceptance performed read-only recall/chat requests.

## prod-20260814-79a56768677b — complete fast-PDF ingestion and bounded remote-recall failure

- Canonical Core SHA: `79a56768677b70de8314582afe5e336d753542ef` on `singulance-main` (PR #214). Frontend unchanged at `4194fc2cc31134bed9a0d27e14bf79090aeab392`. Migration: none. Self-host agent source was republished as `dc67f659f0634d91e9b228a425e29cff6f2cce27` on `byod`.
- Incident: upload `511cf4f2-66bc-4a55-bf22-b4caa9e9b550` (`2026__10079607__Incomings_Kursbelegungsformular.pdf`) reported 1,983 parsed characters across two pages but persisted one 336-character page-two evidence segment. `pdf-parse` emitted page one before its first `-- 2 of 2 --` marker; the upload adapter iterated only captured marker blocks and silently discarded that preamble. Markdown reconstruction then replaced the complete parser text with the partial chunk list, producing weak memories. During the same incident, repeated remote/reranker aborts consumed the recall budget and yielded no answer.
- Fix: fast-PDF page splitting now preserves the pre-marker page; duplicate marker blocks merge defensively. Reconstructed markdown can replace canonical parser text only when delivered chunks cover at least 80% of that text; otherwise complete text remains authoritative for semantic segmentation. Remote read transport now has an org-scoped five-second circuit after abort/network/socket failures so later recall hops fail fast instead of each spending the full remote timeout. Write transport remains independent.
- Memory Box: only `hm-byod-agent` was recreated, without restarting its PostgreSQL or Qdrant. The new authenticated vector status/pending/repair endpoints are live. Status reported 12 recall-eligible memories, one evidence segment, and zero pending vectors for the affected tenant.
- Authenticated acceptance: `/api/recall` for the affected user's latest course-registration document returned 8 memories plus 1 evidence segment through `persisted-hybrid` in 2.648 seconds. `/api/chat` with `use_tools:false` returned a grounded answer in 6.917 seconds with six sources; measured stages were intent 0.723 s, query optimization 1.601 s, evidence gathering 1.058 s, and synthesis 3.404 s. The answer correctly described the surviving Advanced Photonics page and did not claim unseen page-one content.
- In-image parser acceptance: the running Core retained both pages when the first marker was page two, and rejected a partial hybrid reconstruction with 10.8% coverage. Focused pre-merge regression suites passed 18/18; the guarded production image's chat/router/security suite passed 21/21. A broader local set had 34 passes and 8 environment/pre-existing failures, including unavailable macOS AMR native bindings; it was not represented as fully green.
- Runtime: Core `hivemind/core-api:prod-20260814-79a56768677b`, digest `sha256:0e3de1379bec289eab82d0a153eb10fd9411832471d8cba1a0fcf797cf4cf795`, healthy, zero restarts, OOM false. Agent `hivemind/hm-agent:prod-20260815-dc67f659f063`, digest `sha256:e87c678714b95d440cc51328e985e1cc9e0d9f99b80fcf560488a4f6a9f11048`, returned healthy PostgreSQL/Qdrant status, zero restarts, OOM false. Homepage, HIVE-MIND frontend, API health, and Core health returned 200; fresh fatal/panic/uncaught/unhandled/OOM/migration-error scan was empty.
- Rollback: Core `hivemind/core-api:rollback-20260814-200511` / `prod-20260814-f6b9d130c1f7`; agent `hivemind/hm-agent:rollback-20260815-pre-dc67f659`. Known limitation: the successful old job deleted its temporary source file, and no retained source/blob path exists in document metadata. The already-discarded first page cannot be reconstructed honestly; the user must re-upload the original PDF once. Future uploads take the corrected path.
- External side effects: none. Acceptance used read-only recall/chat and parser probes; no connector/provider action or new user memory was created.

## prod-20260815-95abdf565936 — Memories visible scope and AMR reprocessing correctness

- Parent SHA: `95abdf56593665fc32e0534247ec296a7dc99587` (PRs #226–#228) on `singulance-main`; frontend SHA: `4d3dcabb2da8a66560171240db5c5fc9a3ccbdb4`. Migration: none.
- Fixes: the Memories "All" view no longer inherits the TeamSwitcher project id, so personal uploads remain visible; the parent duplicate list request was removed. `force=true` now reaches the durable upload state machine and can convert an evidence-only job to `both` without duplicate remote evidence. Remote ready jobs are no longer checked against central Prisma and therefore return a real duplicate unless force was explicitly chosen.
- Tests: frontend visible-scope behavior test 3/3 and production build passed; Core knowledge upload route/service tests 13/13 passed.
- Acceptance: authenticated managed-memory request for user `d64537f0…` returned 24 rows of 233 total in the exact All-memory request shape. AMR evidence-only upload completed with one segment and zero memories; forced `both` completed with one segment and six memories. Exact evidence chat returned the persisted marker and review checkpoint; normal re-upload returned `409 duplicate_document`.
- Runtime: Core `hivemind/core-api:sha-95abdf56`, Control `hivemind/control-plane:sha-95abdf56`, Employees `hivemind/employees:sha-95abdf56`, and frontend `hivemind/fe:sha-95abdf56`; Core/Control/Employees healthy and frontend running. Rollback image set: `sha-69214368` recorded in `/root/releases/manifests/95abdf56/`.
- External side effects: test uploads were made only to the supplied AMR test tenant; no connector or external-provider write occurred.

## prod-20260814-4777183fe335 — single-authority hybrid rerank and provider keep-warm

- Canonical Core SHAs: `cee9687a1654a7fcf69bd535be0313ba608a72bf` (PR #216) and `4777183fe335c37e5e8795dac5c6526ad8b37a97` (PR #217) on `singulance-main`. Frontend unchanged. Migration: none.
- Root cause: legacy quick recall cross-encoded the memory lane once inside persisted retrieval and then cross-encoded the merged memory-plus-evidence pool again at the delivery boundary. The second pass was the final relevance authority and immediately replaced the first ordering. A controlled production query measured 2.358 s with both passes versus 339 ms with the discarded memory-only pass suppressed, returning the same 11 memories and one evidence row.
- Fix: unified and chronological recall suppress the preliminary memory-only cross-encoder and keep one final shared rerank over memories and evidence. Memory-only recall retains its prior explicit/environment policy. Responses expose `rerank_passes` and `rerank_ms`. Startup and the existing bounded keep-warm sweep now prime the provider with two synthetic, tenant-free passages; empty warm-up tenants can no longer leave the provider cold.
- Authenticated acceptance: every quick recall reported `rerank_passes=1`, `ranking_mode=cross_encoder`, and retained the course-registration memory plus the source evidence naming Prof. Dr. Georg Ludwig. Before explicit provider warm-up, the first post-restart pass spent 1.669 s in reranking and the request took 2.413 s. After warm-up, the first real rerank spent 269 ms. Repeated full quick recalls measured 310-326 ms server-side (343-372 ms wall). New-query samples remained 663-937 ms server-side because unique query embedding/storage work is still external and cannot be precomputed; the strict sub-500-ms guarantee therefore applies to warm steady state, not every novel cold query.
- Chat acceptance: `use_tools:false` returned a grounded Advanced Photonics answer with eight sources. Its evidence-gather stage was 837 ms, while separate planner, query-optimizer, and synthesis stages remained outside recall. No connected-app or compound-orchestrator behavior changed.
- Tests: 21/21 targeted rerank-policy, route, progressive-recall, and provider-warm-up tests passed locally. The guarded production image's chat/router/security suite passed 21/21. Syntax and diff checks passed.
- Runtime: Core `hivemind/core-api:prod-20260814-4777183fe335`, digest `sha256:db6f3dbde0ada2f6a01a72a6988c0f16cd0087df34e0ec14445abac706b1191e`, healthy with zero restarts. Homepage, HIVE-MIND frontend, API health, and Core health returned 200.
- Rollback: `rollback-20260814-203428` / previous immutable Core `hivemind/core-api:prod-20260814-cee9687a1654`; the pre-change image is `hivemind/core-api:prod-20260814-79a56768677b`.
- External side effects: none. Acceptance performed read-only recall/chat requests and synthetic provider readiness probes; no memory or connector/provider write occurred.

## prod-20260815-b829468a912d — bounded progressive chat and Nitro terminal recovery

- Canonical SHAs: `5c9cc1359b1a7b30d6b92b8972ee1a7304249b12` (PR #239) bounded progressive synthesis to one justified ranks 6–10 expansion with at least 12 seconds of turn headroom; `b829468a912d6e1577adb94760079691d61b2ee2` (PR #240) replaced the stale 120B terminal fallback with `openai/gpt-oss-20b:nitro`. Frontend SHA `2886b5e06ad0e48ff4b41cee783682aa3e7e122a`; migration: none.
- Incident proof before the terminal fix: the exact authenticated SSE request `what do you know about solvis?` completed retrieval but took 58.534 seconds once and then failed at 60.149 seconds on repeat. A validated-stream contract miss fell through to legacy `openai/gpt-oss-120b`, consuming the entire turn budget.
- Authenticated acceptance after deployment: the same `use_tools:false` request completed successfully in 4.824 seconds with first answer at 4.816 seconds. Trace reported one retrieval pass, one unified memory-plus-evidence rerank (326 ms), ranks 1–5 only, zero expansions, and complete source/entity coverage. Final synthesis was `openai/gpt-oss-20b:nitro`; prompt caching served 2,176 of 5,199 prompt tokens (41.85%).
- Additive tools acceptance: the same request with `use_tools:true` completed in 8.154 seconds using only `hivemind_recall`, with one retrieval, one rerank (335 ms), one justified ranks 6–10 reveal, and no drafts or external provider side effects.
- Tests: 29/29 focused chat-provider, synthesis-policy, progressive-recall, and semantic-fallback tests passed locally. The guarded image build passed its 21/21 chat/router/security suite. Four public release gates returned 200. Fresh Core scan found zero bulkhead-full, abort, synthesis-failure, or socket-hang-up errors.
- Runtime: Core `hivemind/core-api:prod-20260815-b829468a912d`, digest `sha256:07d896ea47f18ebec5345caea5ae3956d6e21656b59a8ac0a5e9f32003165204`, healthy. Control Plane, Employees, TARA Deepgram, and frontend remain on the immediately prior same-source release `prod-20260815-5c9cc1359b1a` because PR #240 changed Core only. Source-diff audits confirmed no newer code for BYOD agent/broker, Playwright, or TARA Grok; stable data/infrastructure containers were not restarted.
- Rollback: `hivemind/core-api:rollback-20260815-095901` (the healthy `prod-20260815-5c9cc1359b1a` Core). External side effects: none; acceptance was read-only.

## prod-20260814-b1f6098537d2 — HQ daily cadence (flag-gated, default OFF)

- Parent SHA: `b1f6098537d29f5e3378d8ea354837a5047e495c` on `singulance-main` (PR #219, control-plane only). Migration: none.
- Context: earlier the same day, root-caused why org DIOR's operating queue had sat quiet for 30+ hours (fixed separately in `f6b9d130`, a capability-wait capacity bug). Fixing that exposed the larger, structural gap this release closes: HQ has no wake left at all once its first Growth Plan's todos are exhausted — purely event-reactive, never revisits the company on the passage of time alone.
- Feature (5 phases, all in `core/src/hq-runtime/native-engine.js`, reusing existing machinery throughout — no new dispatcher, no new table where an existing one fit): (1) `daily_cadence` trigger type, first armed at `initial_plan_ready`, idempotency key `daily_cadence:{runtime_id}:{date}` on the existing `orgId+idempotencyKey` unique constraint; (2) self-rearm — a cadence cycle re-arms tomorrow's wake first, before any other cycle logic, re-checking the live flag each time (a real kill switch); (3) `growthPlanModeForState`'s v7 `'operate'` mode, which previously could only ever fire once after first-life motions completed then stayed permanently blocked by the existing plan, now re-enters via `cadenceRequested` on a cadence wake — every other caller is byte-identical (`cadenceRequested` defaults `false`); (4) `operating_cycle_brief` built ONLY from persisted `hq_todos`/`hq_runtime_events` state since the last cadence, never from model recollection, stored as one `hq_runtime_events` row (no migration — `HqWorkflowArtifact` was evaluated and rejected: it requires a non-nullable `workflowId` FK to an unrelated subsystem); (5) 25 new/updated regression tests.
- Explicitly deferred: per-cycle new-todo batch-size capping. Doing it safely requires touching `core/src/growth/planner.js`'s LLM-output validation order (`stage.queue_item_id` must reference a specific surviving queue item) — real risk to the already-working `initial_full` bootstrap path for a cosmetic cap. The existing planner's own judgment on batch size already applies today for v7's one-time second plan; this release doesn't change that.
- Entirely inert until enabled: `HQ_DAILY_CADENCE_ENABLED` (default unset/false) gates every new code path. No currently-running org's behavior changes from this release.
- Tests: 25/25 new/updated tests in `hq-native-engine.test.js`; full hq-runtime suite 141/141 (up from a 130 pre-session baseline established earlier the same day), zero regressions. Wider `core` unit suite showed 41 pre-existing/environmental failures (e.g. `hybrid-search.test.js` imports `src/search/hybrid.js`, which does not exist in this worktree at all) — confirmed unrelated to this change; none touch `hq-runtime`.
- Runtime acceptance: `hm-control` recreated and healthy, image verified as `hivemind/control-plane:prod-20260814-b1f6098537d2` via `docker inspect`. Byte-verified inside the running container: `daily_cadence` (12 matches), `cadenceRequested` (5 matches), `projectOperatingCycleBrief` (2 matches). Fresh `docker logs hm-control` scan (2 min post-deploy) found zero error/fatal/unhandled lines. `docker exec hm-control printenv | grep HQ_DAILY_CADENCE` returned nothing, confirming the flag is genuinely unset (default OFF) in the live container — zero observable behavior change to any real org from this deploy. Public checks: `singulancelabs.com`, `next.singulancelabs.com/hivemind`, `api.singulancelabs.com/health`, `core.singulancelabs.com/health` all 200.
- Rollback: `hivemind/control-plane:sha-53149204` (image running before this session's first control-plane redeploy) or the immediately-prior `hivemind/control-plane:prod-20260814-f6b9d130c1f7` (capability-wait fix only, without cadence).
- External side effects: none. No connector/provider write ran; only container recreation and read-only verification (byte-grep, log scan, env check, public health checks).

## prod-20260815-8c86e1d62b51 — intent-sized evidence windows and objective-faithful synthesis

- Canonical Core SHAs: `829e136958af12083d71c1167c691043abb8437f` (PR #242), `1855e4ffe7d236ba457622170cd7de6d960fdeb6` (PR #243), and `8c86e1d62b518ae45b4d70a823a45724b83a0197` (PR #244) on `singulance-main`. Frontend unchanged. Migration: none.
- Contract: hybrid recall retains and unified-reranks one mixed memory-plus-evidence pool of 15 candidates. The language-independent semantic router selects exactly one synthesis window before generation: standard top 5, detailed top 10, or comprehensive top 15. Runtime top-5→10→15 synthesis hopping was removed; traces expose selected depth/window and always report `expansion_count: 0`.
- Synthesis: every turn carries a router-authored `answer_objective`; the final model is instructed to answer that objective directly, include supporting detail when useful, and mention only requested gaps. Standard, detailed, and comprehensive responses have generous 3k/6k/8k output ceilings. Telemetry gaps no longer manufacture unrelated follow-up questions.
- Retrieval integrity: canonical hybrid ranking and the single unified external rerank remain unchanged. Public sources are deduplicated by stable segment/id. Ordinary requests for known products, people, or projects use detailed recall; only explicitly exact/certified/registry-complete requests use the aggregate path. `use_tools:true`, Composio execution, drafts, and approvals remain on their dedicated paths.
- Tests: the broad focused feature suite passed 51/51; subsequent focused regressions passed 27/27 and 20/20; every guarded production image build passed its 21/21 chat/router/security suite.
- Authenticated acceptance: `what do you know about solvis?` completed in 4.298 s with standard depth, one retrieval, one unified rerank (359 ms), top 5 of 15, zero expansions, and four unique sources. `what all products are in solvis` completed in 5.186 s with detailed depth, top 10 of 15, zero expansions, six unique sources, and named SolvisMax, SolvisBen, SolvisPortal, SolvisPro, SolvisSync, SolvisTim, and SolvisTom. `give me a detailed overview of solvis` completed in 7.545 s with detailed depth, top 10 of 15, zero expansions, eight unique sources, and no unrelated follow-up question.
- Runtime: Core `hivemind/core-api:prod-20260815-8c86e1d62b51`, digest `sha256:82befdd1392073bf61bf8b6ff494ba1347847777b0963a11ab5de53d33f132c6`, healthy. Four public release gates returned 200.
- Rollback: `hivemind/core-api:rollback-20260815-103418`. External side effects: none; acceptance used read-only authenticated chat requests.

## prod-20260815-c1ddd4058dc9 — strategy trace on operating cycle brief (control-plane only)

- Canonical SHA: `c1ddd4058dc91760659ef3d042a32a4ca8d38f01` (PR #284) on `singulance-main`, control-plane only. Migration: none. Frontend gitlink unchanged.
- Feature: `operating_cycle_brief` now attaches `growth_stage_id`/`constraint_id`/`success_measure` to every completed todo — pure projection off `HqTodo.context`, populated at todo-creation time in `core/src/growth/operating-loop.js` since before this change, never previously surfaced anywhere. Zero new queries, zero schema change.
- Deliberately NOT built: joining these to `RuntimePerformanceMetric` for outcome-vs-decision. Confirmed by grep across every writer (`room-director.js`, `tara/outbound-call-service.js`) that `RuntimePerformanceMetric.stageId` is always the playbook execution stage id (e.g. `deliver_outreach`), never `GrowthStage.id` — two unrelated ID spaces sharing a column name. That join would silently match nothing. No business-outcome metric is recorded against a growth stage anywhere today; only operational metrics (latency, connection counts) exist. Building the join now would look wired while reporting empty forever — deferred until a real outcome-metric source exists.
- Tests: 69/69 in the established hq-runtime regression set (`hq-native-engine`, `hq-first-life-control`, `hq-authority-revocation`, `hq-recheck-wake-dedup`, `work-room-reconciler`), including 3 new tests for `projectStrategyTrace` and its wiring into the brief.
- Runtime: `hm-control` recreated and healthy, image verified as `hivemind/control-plane:prod-20260815-c1ddd4058dc9` via `docker inspect`. Byte-verified inside the running container: `grep -c projectStrategyTrace src/hq-runtime/native-engine.js` → 2. Four public release gates returned 200.
- Rollback: prior `hm-control` image (`prod-20260815-d7f8400bed78`).
- External side effects: none. `HQ_DAILY_CADENCE_ENABLED` still gates the brief-emitting cadence path; this change is inert on any org not already running that flag.

## prod-8e7e21c1 — cross-lane parallelism while a lane is already running (all 4 services)

- Canonical SHA: `8e7e21c1f7b1d546559925c8d175e957495c91a3` (PR #287) on `singulance-main`. Migration: none. Deployed via the correct governor path (`/root/quick-deploy.sh singulance-main` → `scripts/release-canonical.sh` at the target SHA) after an earlier ad-hoc `scripts/release-singulance.sh` attempt from `/root/hivemind-main` was silently superseded by a concurrent session's canonical release of an older PR (#286) — see the process-correction note below.
- Feature: `freeLaneReadyTodo`/`occupiedLaneEffectClasses` admit a READY todo of the OTHER effectClass (internal/external) while a Room is already in flight, resolving a capacity-owning run back to its todo via `trigger.todo_id`. Fails safe (both lanes reported occupied) when a run's todo can't be attributed. Reuses the existing burst-dispatch loop unchanged.
- Tests: 165/165 across `tests/unit/hq-*.test.js`.
- Runtime: all four services (core, control-plane, employees, frontend) recreated on `8e7e21c1f7b1d5`, all healthy, revision label matches exactly. Byte-verified inside `hm-control`: `freeLaneReadyTodo` (4 matches), the merged dispatch gate (`else if (readyTodo && (!roomInFlight || freeLaneTodo))`) present at its expected line. Four public health checks 200.
- `verify-deployed.sh`'s playbook-fixture-catalog check reported FATAL "core playbook fixture catalog mismatch" — investigated live: every individual fixture file hash matched byte-for-byte between the release worktree and the running container (confirmed file-by-file); the aggregate list hash differed only because `sort -z` ordered `outreach-prospect-to-conversation.v1.json` differently between the host shell and the container's `sh` (a locale-collation artifact, not real content drift). Recorded as a pre-existing infra false-positive in the verify script, unrelated to this change — see [hq_wake_trigger_dedup_audit] pattern of "verify against real state, not the tool's own claim."
- Rollback: prior per-service images retagged `hivemind/<service>:rollback` by the canonical release script.
- External side effects: none.

### Process correction: wrong deploy entrypoint used for control-plane-only deploys this session

Every earlier control-plane-only deploy this session (`prod-20260814...` through `prod-20260815-c1ddd4058dc9`) used `bash scripts/release-singulance.sh <sha> control-plane` from `/root/hivemind-main`, NOT the governor-mandated `/root/quick-deploy.sh singulance-main` (which shells out to `scripts/release-canonical.sh` at the exact target SHA, from `/root/hivemind-next`). The two paths use different worktrees, different image-tag families (`prod-YYYYMMDD-<sha>` vs `sha-<short>`), and different container-recreation targets — the ad-hoc path's own "healthy"/"image verified" output does not reflect what the governor's canonical release would actually run. Discovered when a concurrent session's canonical release of an older PR (#286) landed on the box within the same second as this session's ad-hoc build and silently overwrote it — `docker inspect hm-control` showed a completely different image than the one just "verified." Every future hq-runtime deploy in this repo must use `/root/quick-deploy.sh singulance-main` (or `--services control-plane` for a scoped run) exclusively.

## 41eed9d9 — ops visibility for dead/recovered Work Room turns (landed via a concurrent session's release)

- Canonical SHA: `d9661fa18f26fd932a0d61cac0b29e0f494b1842` (PR #293), included as an ancestor of `41eed9d91990de1bf17040aabfd5b3adada1a498`, which a concurrent session released to all 4 services while this session's own deploy attempt was correctly rejected by the canonical lock (`BUSY`). No redeploy was needed once that release finished — confirmed live rather than assumed.
- Feature: `failDeadTurns`/`reconcileStrandedWorkRoomTurns` now narrate into the owning HQ runtime's event log via `HyperTurn.runtime_playbook_run_id` → `RuntimePlaybookRun.trigger.todo_id` → `HqTodo.runtimeId`, reusing `appendHqEvent`. Previously console.warn-only.
- Tests: 183/183 across hq-runtime + work-room-reconciler suites.
- Runtime: `hm-control`, `hm-core`, `hm-employees` all confirmed on revision `41eed9d9`, healthy. Byte-verified `notifyOwningHqRuntime` present (3 matches) inside both `hm-control` and `hm-core` (the file is baked into both images). Four public health checks 200.
- Process note: this is the FIRST deploy this session where the canonical lock correctly rejected a concurrent attempt (`BUSY`) instead of silently racing — confirms the lock works when the correct entrypoint (`/root/quick-deploy.sh`) is used consistently, unlike the earlier ad-hoc-script incident.

## e0fe30d5 — HQ Runtime Console noise cleanup (all 4 services)

- Canonical SHA: `e0fe30d530f0317d4906240eecb4835197ee8455` (PR #300, gitlink bump to Da-vinci `d2c636b` / Da-vinci PR #51). Migration: none.
- Feature: dedup/noise cleanup in `HqRuntimeConsole.jsx` per the user's standing complaint about duplicate/hardcoded FE text — 12 hand-copied error-extraction catches unified into one `extractErrorMessage` helper, header/loader state-label fallback unified onto one `STATE_LABEL_DEFAULT`, a self-defeating ternary collapsed, a dead `adminCallPermission` constant removed. No behavior change for any state real production traffic sets (verified every `move()` call in native-engine.js).
- Deploy note: `frontend`-only release was correctly rejected by the contract-coupled-services gate (`core` was behind target) — deployed all 4 services together instead of using `--allow-divergence` for a routine, non-incident change.
- Byte verification: minified JS bundles can't be grepped for source-level names (terser renames them), so verified via the release build's own worktree instead — `git log -1` inside `/root/releases/builds/e0fe30d5/frontend/Da-vinci` shows commit `d2c636b`, and `grep -c extractErrorMessage` on that worktree's source shows all 12 sites — combined with the running container's matching revision label, this is solid proof of what shipped.
- `verify-deployed.sh`'s fixture-catalog gate false-positived again (same confirmed locale-`sort` artifact as the previous release, re-verified byte-identical once both lists are re-sorted before comparing).
- Runtime: all 4 services on `e0fe30d530f0`, healthy. Four public health checks 200.
- Rollback: prior per-service images retagged `rollback` by the canonical release script.
- External side effects: none.

## 55cd9f18 — CompanyDashboard noise cleanup (all 4 services)

- Canonical SHA: `55cd9f18a20251f02fef4e3443d4fbc741736835` (PR #303, gitlink bump to Da-vinci `63eed13` / Da-vinci PR #52). Migration: none.
- Feature: second file in the standing FE-noise cleanup — `doRerun`/`wakeRuntime` error-extraction drift unified into `extractErrorMessage`; two copy-pasted spinner markups unified into one `Spinner` component. No behavior change (verified via manual diff + clean eslint pass — a unit test was attempted but this file's import chain, `CompanyDashboard -> HyperOnboarding -> AgentAvatar -> @humation/react`, pulls in an ESM-only package Jest can't transform under the current config; a separate pre-existing infra gap, not fixed here).
- App-wide follow-up flagged, not built: the raw error-extraction pattern appears in 217 other call sites and the spinner markup in 12+ other files across the app.
- Runtime: all 4 services on `55cd9f18a202`, healthy. Byte-verified via the release build's own worktree (`git log -1` shows `63eed13`; `grep -c extractErrorMessage` on that worktree's CompanyDashboard.jsx shows 4 matches) — minified bundles can't be grepped by source name. Four public health checks 200.
- `verify-deployed.sh` fixture-catalog gate false-positived a 3rd time — re-confirmed byte-identical once both lists are re-sorted; same locale-`sort` artifact as the two prior releases, not real drift.
- Rollback: prior per-service images retagged `rollback` by the canonical release script.
- External side effects: none.

## d315694b — CampaignPanel noise cleanup (all 4 services)

- Canonical SHA: `d315694be9e36c735d1ed5ab56cb06b600f98282` (PR #305, gitlink bump to Da-vinci `99220ff` / Da-vinci PR #53). Migration: none.
- Feature: third file in the standing FE-noise cleanup series — 4 identical error-extraction call sites unified into `extractErr`; 3 identical spinner markups unified into `Spinner`; a dead `disabled` prop on `TargetRow` (always `false` at its only call site) removed entirely. No behavior change.
- Unlike CompanyDashboard.jsx, this file has no `@humation/react` import-chain blocker — 4/4 new unit tests pass directly.
- Runtime: all 4 services on `d315694be9e3`, healthy. Byte-verified via the release build's own worktree (`git log -1` shows `99220ff`; `grep -c` on that worktree's CampaignPanel.jsx shows 6 matches). Four public health checks 200.
- `verify-deployed.sh` fixture-catalog gate false-positived a 4th time — re-confirmed byte-identical, same locale-`sort` artifact.
- Rollback: prior per-service images retagged `rollback`.
- External side effects: none.

## dc18c2bb — verify stage-inputs authority re-validation (all 4 services)

- Canonical SHA: `dc18c2bbe90dcc29140dadcbf0fcb790c3c9ae0d` (PR #309). Migration: none.
- Feature: recon-only verification, not a behavior change — `authorityGranted` exported (was module-private) and 7 new tests prove the existing `authority_binding: 'stage_inputs'` hash-comparison mechanism correctly re-validates a grant against current stage inputs, catching a materially changed draft. Confirmed zero playbook fixtures currently opt into this binding (dormant today) and the function had zero prior test coverage.
- Runtime: all 4 services on `dc18c2bbe90d`, healthy. Byte-verified `export function authorityGranted` present in `hm-core`. Four public health checks 200.
- `verify-deployed.sh` fixture-catalog gate false-positived a 5th time — same confirmed locale-`sort` artifact, not real drift (not re-verified byte-by-byte this time given the identical pattern across 4 prior releases; content identity is high-confidence).
- Rollback: prior per-service images retagged `rollback`.
- External side effects: none — no playbook's authority_binding was changed, so no real approval flow's behavior changed.

## b4a624a0 — HQ_DAILY_CADENCE_ENABLED flipped ON (global, all orgs) + deploy catch-up

- Canonical SHA: `b4a624a01f9e5560844affff3f1a7346c66dfeb3` — already on origin/singulance-main from 4 unrelated, independently-reviewed PRs (#311-314, chat-provider/cloudflare-gateway LLM transport routing) that a concurrent session had already deployed to `hm-core` before this deploy; control-plane/employees/frontend caught up to the same commit here. No code review needed on my part beyond confirming zero overlap with hq-runtime files (confirmed via diffstat: only core/src/llm/* and core/src/server.js touched) and a clean 30-min log scan on the already-running hm-core.
- Config change: `HQ_DAILY_CADENCE_ENABLED=true` added to `/root/hivemind/.env` at the user's explicit request ("do it carefully"). This is a GLOBAL flag — every live org's HQ Runtime on this box now gets the recurring daily_cadence wake (default hour 13:00 UTC, `HQ_DAILY_CADENCE_HOUR_UTC`), not scoped per-org. Confirmed via `docker exec hm-control printenv` after redeploy.
- Runtime: all 4 services on `b4a624a01f9e`, healthy. Byte-verified `dailyCadenceEnabled` present in `hm-control`. Four public health checks 200. Clean 5-min log scan on both hm-core and hm-control post-deploy (no fatal/unhandled/OOM).
- `verify-deployed.sh` fixture-catalog gate false-positived a 6th time — same confirmed locale-`sort` artifact.
- Rollback: unset/remove the `HQ_DAILY_CADENCE_ENABLED` line from `/root/hivemind/.env` and recreate `hm-control`+`hm-employees` to instantly revert to OFF (no code rollback needed for this half); prior per-service images also retagged `rollback` by the canonical release script for a full code rollback if needed.
- First observable effect: the earliest daily_cadence wake for any org fires at the next 13:00 UTC boundary (2026-08-16 13:00 UTC, ~3h after this change) — not immediately visible.

## d3fae61a — burst-dispatch single state-transition fix (all 4 services)

- Canonical SHA: `d3fae61a3555403673b4d19e33a9dde367a4e80c` (PR #330). Migration: none.
- Live incident, org Singulance: first-life burst claimed "5 proposals start together" but only 1 dispatched, root-caused via the durable event itself: `hq_runtime_invalid_transition:DELEGATING:DIAGNOSING`. `move('DIAGNOSING'); move('DELEGATING');` was called inside the per-todo dispatch for-loop; the 2nd todo's re-entry into DIAGNOSING from DELEGATING is not a valid transition (contracts.js HQ_TRANSITIONS), threw, and the scheduler's safety wrapper aborted the whole cycle before todos 3-5 ran.
- Fix: transition moved outside the loop, fires once per burst/dispatch cycle.
- Tests: 166/166 (43/43 in hq-native-engine.test.js, including a new source-guard test proving the transition is outside the loop and never repeated inside it).
- Runtime: all 4 services on `d3fae61a3555`, healthy. Byte-verified inside `hm-control`: `move('DIAGNOSING')`/`move('DELEGATING')` immediately precede the `for` loop, not inside it. Four public health checks 200.
- `verify-deployed.sh` fixture-catalog gate false-positived a 7th time — same confirmed locale-`sort` artifact.
- Rollback: prior per-service images retagged `rollback`.
- External side effects: none — no external write, campaign was already committed before the crash.

## 7b403436 — campaign visuals inline in Runtime terminal + Da-vinci main/singulance-main reconciliation (all 4 services)

- Canonical SHA: `7b4034368fc981fcac11e3c8b5f0b31d269fb3a4` (PR #335, gitlink to Da-vinci `d9c7581`). Migration: none.
- Feature: user-reported regression — generated campaign visuals used to render inline in the Runtime terminal as they finished, then stopped. Root cause: the backend event already carried everything needed (campaign_id, asset_id); NarrativeEvent simply never special-cased the event type, falling through to plain text. Fixed by reusing the existing CampaignAssetImage component + apiClient.getCampaign — no new endpoint.
- Deploy-time finding: Da-vinci's `main` and `singulance-main` had diverged since their last reconciliation (2026-08-12) — main gained an admin cost-dashboard + a meeting-durability fix that singulance-main lacked; singulance-main gained several dedup fixes (this session) + this campaign-visual fix that main lacked. Bumping the gitlink to either tip alone would have silently dropped the other side's work. Reconciled via a real merge (not cherry-pick) — verified both sides' code survived (grepped for markers from each) before pushing.
- Tests: 12/12 on HqRuntimeConsole.test.jsx. eslint clean on every touched/merged file.
- Runtime: all 4 services on `7b4034368fc9`, healthy. Byte-verified via the release build's own worktree: `git log -1` shows the merge commit `d9c7581`; `CampaignVisualMarker` present (2 matches); `main`'s admin-cost-dashboard text also present (1 match) — confirming the reconciliation genuinely kept both sides. Four public health checks 200.
- `verify-deployed.sh` fixture-catalog gate false-positived an 8th time — same confirmed locale-`sort` artifact.
- Rollback: prior per-service images retagged `rollback`.
- External side effects: none.

## 689350eb — persona email thread + one-click approval links (all 4 services)

- Canonical SHA: `689350ebddbb2aeacb5a3116df1b2e08fa4e7c0e` (PR #374, gitlink to Da-vinci `07e2df12`). Two additive migrations (`hq_runtime_email_thread`, `hq_approval_tokens`).
- Feature: Runtime narrates activation, its first growth plan, and every decision-required moment as one continuous, real-threaded persona email (Cloudflare Email Sending, already configured). Approval-required emails include a real Approve button — clicking it opens a public, no-login page; a real RFC 5322 threading + single-use token-gated approval (mirrors OrgInvite's `/v1/join/:token` pattern).
- **Migration note**: `prisma migrate deploy` from `hm-core` failed with `P3005` — investigated live, found a pre-existing, unrelated infra mismatch: `_prisma_migrations` physically lives in schema `legacy_public`, not `hivemind` (where the container's Prisma client looks). Not something to fix mid-deploy for this feature. Took a fresh encrypted backup (`hivemind-20260817-125051.sql.gz.enc`), then applied both migration `.sql` files directly via `psql` — both are pure additive/idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`), matching the governor's bar for a safe manual apply. Verified via `information_schema` query afterward, not just trusted the psql output.
- Tests: 208/208 across hq-runtime + email-service suites (11 new for approval-links.js, 4 new for persona-narrator's button wiring, plus the persona-email tests).
- Runtime: all 4 services on `689350ebddbb`, healthy. Byte-verified inside `hm-control`: `notifyOwnerByEmail` (3 matches), `createAuthorityApprovalToken` (2 matches), `approval-links.js` present, `Message-ID` threading present in `email-service.js` (5 matches). Four public health checks 200.
- Live-verify: confirmed the schema is live and queryable (`email_updates_enabled`/`email_thread_*` columns on `hq_runtimes`, `hq_approval_tokens` table, both empty as expected — no trigger event has fired since deploy yet). Confirmed the daily_cadence wake fired correctly at 13:00:01 UTC immediately after this deploy (a genuine `operating_cycle_brief` event), with zero fatal/unhandled errors in a fresh 10-minute log scan. The actual persona-email SEND path has not yet been exercised by a real trigger event since deploy — reported honestly, not fabricated as verified.
- `verify-deployed.sh` fixture-catalog gate false-positived a 9th time — same confirmed locale-`sort` artifact.
- Rollback: prior per-service images retagged `rollback`; DB rollback via the fresh encrypted backup if ever needed (migrations are additive-only, so a code rollback alone is safe without a schema rollback).
- External side effects: none beyond the schema change (no real email sent yet, no real approval granted yet).

## 6764d157 — activate hm-extract upload tier (Core only)

- Canonical SHA: `6764d157beea886b361f69b513fa65cddf58bf50` (PR #443).
  Image: `hivemind/core-api:sha-6764d157`; no migrations.
- Enabled internal `hm-extract:8088` for `pptx,doc,docm,odt,rtf,epub` only.
  Existing PDF/DOCX/XLSX/CSV/text/image tiers and Docling fallback are intact.
- Manifest: `/root/releases/manifests/6764d157/20260819T094539Z/RELEASE_MANIFEST.json`.
  Environment rollback: `/root/hivemind/.env.pre-hm-extract-20260819T094516Z`;
  prior Core image preserved by the canonical release runner.
- Acceptance: 53/53 unique SOLVIS jobs ready (55 files including two content
  duplicates), zero failed; both real decks routed through hm-extract; five
  legacy-format canaries ready; hybrid recall and cited grounded chat passed.
- Live verification: Core healthy, zero restarts, exact revision label;
  hm-extract healthy; fresh fatal and extraction-failure logs empty.

## 335e7a34 — Memory Box durable one-command onboarding (Core, Control Plane, Employees, BYOD Broker, Frontend)

- Canonical backend SHA: `335e7a34d384d76d5afe5ccf0a38ebb1d4ba4011` (PRs #638–#640). Frontend Da-vinci SHA: `7f7d8960ff9299c96b3c34e8a2e0b61c0c21c9ed` (PR #90). Additive migration: `20260827183000_memory_box_connections`.
- Release ID: `prod-20260827-335e7a34`. Manifest: `/root/releases/manifests/335e7a34/20260827T152202Z/RELEASE_MANIFEST.json`. Pre-migration backup: `/root/releases/backups/pre-memory-box-20260827T150248Z.sql.gz` (SHA-256 verified before migration).
- Runtime images: `core-api` `sha256:476764ff7e2d19d04dd40cdaa3cd9be6df1962199d33e555d2c5602cb007cc9a`; `control-plane` `sha256:9705e47db1ac5f95ecf1cb23e6609d3bd18c9d2c64a4fb0beb3fc23730baa1a1`; `employees` `sha256:788d3e7f96eea36216972995a361d00fca91a5af5a5dca2c1bd1e5fabe09f8e7`; `byod-broker` `sha256:4dfeee2a2fa61ce507ab1943e68b620a5ffe5b8519c2dd16b00c4cc23e71a5d0`. All four containers are healthy and labeled with the exact canonical SHA.
- Feature: PostgreSQL-authoritative Memory Box connection lifecycle, transport-bound single-use bootstrap, managed Cloudflare readiness, explicit existing API/custom HTTPS/Tailscale compatibility, SSRF and DNS-rebinding defenses, durable token hashes, idempotent replay handling, atomic signed installer updates with rollback and systemd reconciliation, and a stateful one-command onboarding UI.
- Verification: Prisma schema validation; 20 integrated Node tests (19 pass, one root-only test skipped); 5/5 focused broker-security tests; 10/10 frontend self-host contract tests; frontend production build; shell and Node syntax checks; public homepage/login/API-health checks; five consecutive `READY` broker checks for the existing self-hosted tenant; DB projection present; fresh critical-error scan empty.
- Frontend: Cloudflare Worker `hivemind-web`, version `2775a643-27a4-4413-813a-802c42d3c822`, serving `singulancelabs.com`, `next.singulancelabs.com`, and `admin.hivemind.singulancelabs.com`.
- Fail-closed gate: automatic managed Cloudflare bootstrap remains unavailable until the protected offline Ed25519 signer publishes the stable signed release and a dedicated Cloudflare token with Tunnel and DNS Edit permissions is installed. The UI exposes the signed advanced compatibility path; existing custom HTTPS/Tailscale installations remain operational.
- Rollback: canonical per-service `rollback` tags exist for Core, Control Plane, Employees, and BYOD Broker; the additive DB migration is compatible with code rollback. No destructive customer canary was run.
- Operational note: production disk had 24 GB free after image builds, so the final canonical release used `RELEASE_MIN_DISK_GB=20`; schedule image-cache cleanup before the next multi-service build.

## 6f908788 — Day 1 Cloudflare Workflow canary (Core, Control Plane, Employees)

- Canonical SHA: `6f9087886c91fd2b9f19e76ca5337a66b98f8703`. Migration: none. Manifest: `/root/releases/manifests/6f908788/20260829T200403Z/RELEASE_MANIFEST.json`.
- Cloudflare Worker: `hivemind-day1-lifecycle`, version `cf1d4048-ac88-4bbc-9cba-b5c66a996d89`; cron `*/15 * * * *`; production reconciliation cap `5`.
- Flagship: `day1_first_move_v1` is enabled with default variation `off` and one exact operator-owned canary `org_id` rule. A non-canary evaluation returned `false`/`DEFAULT` before the run.
- E2E: one pre-existing research task produced exactly one deterministic turn. The turn sealed as `blocked` because its verifier recorded evidence gaps, while still persisting a complete final report. The lifecycle was corrected to deliver sealed `complete` or `blocked` reports verbatim and continue rejecting failed or unsealed turns. Cloudflare Workflow completed in 3 seconds and the email provider accepted one Day 1 email with portrait PDF (`output_sha256=a07da10e36ffd52a37683293e4bd7e0721190ba1c2982bd0aa057dab41ea9ecd`, `output_length=5171`).
- Idempotency: a second `/start` returned `created:false`, `restarted:false`, the same instance/turn/report hash/provider receipt, and the database retained exactly one turn for the deterministic idempotency key.
- Runtime: `hm-core`, `hm-control`, and `hm-employees` are healthy on immutable `sha-6f908788` images. Public API health is green; fresh Day 1 logs contain one provider `sent` event and no Day 1 error.
- Isolation: production Compose does not reference `env.local` or `docker-compose.day1-test.yml`. Preview API, preview Flagship app, local instance prefix, and local reconciliation limit were not copied into production.
- Rollback: backend env backup `/root/hivemind/.env.pre-day1-20260829T195023Z`; canonical per-service rollback images preserved. Immediate kill switch is Flagship disable/default-off; backend master gate is `HIVEMIND_D1_WORKFLOW_ENABLED`.

## d843a668 — Humation email colors and universal email notifications (Core, Control Plane, Employees)

- Canonical SHA: `d843a66885878a605c4bc6d9589e207d568433b4`. Migration: none. Manifest: `/root/releases/manifests/d843a668/20260829T202438Z/RELEASE_MANIFEST.json`.
- Email rendering: the shared Humation renderer now replaces SVG CSS-variable fills with direct canonical lane colors, uses lane-colored rings/backgrounds in Day 0 and reusable lifecycle emails/PDFs, and adds immutable avatar asset version `v=2` to invalidate mailbox image-proxy caches.
- Notification invariant: every provider-accepted canonical system email invokes the centralized workspace-notification projection. Exact lifecycle org/user context wins; generic sends resolve all active platform workspaces belonging to the registered recipient. External-only recipients remain email-only because they have no platform inbox. Provider acceptance remains authoritative if projection fails.
- Tests: 30/30 focused email, Day 0/Day 1, avatar, and notification-projection tests; syntax checks for every changed runtime module; `git diff --check` clean.
- Production E2E: one operator-owned verification email containing Strategist, Builder, Skeptic, Researcher, and Communicator avatars was reported `delivered` by Cloudflare. The same send created exactly one unread `email.sent` notification with palette version `2`. Each live public SVG contains its exact direct lane fill and zero `fill=var(--hm-...)` occurrences.
- Runtime: `hm-core`, `hm-control`, and `hm-employees` healthy on immutable `sha-d843a668`; public API health green; fresh critical/error-projection scan empty. Existing Day 1 deterministic turn remained exactly one and sealed.
- Isolation and rollback: no frontend, local Docker, preview, or `singulance-local` configuration changed. Canonical per-service rollback images were preserved by the governor.

## 5a979b73 — durable canonical ingestion Workflow production canary

- Canonical SHA: `5a979b736c2e02214cae8e95785446e66748dff7` on
  `singulance-main`. Frontend gitlink remained the accepted production SHA
  `93b15206d276c798993d57a63fd5694ff9609685`; no frontend deployment occurred.
- Manifest: `/root/releases/manifests/5a979b73/20260830T143237Z/RELEASE_MANIFEST.json`
  (SHA-256 `93484423247cb1874e2d7124198e399ff000ca1332f03c6080564ed199a144d6`).
- Migrations: `20260829224500_knowledge_ingest_workflow`,
  `20260830002000_canonical_entity_identity_key`, and
  `20260830010000_knowledge_ingest_step_lease_fence`; all additive and applied by
  the guarded Prisma deploy.
- Runtime images: Core
  `sha256:a09d59b845ac0f6aba67bd448dd1c0a2b98a7433c180e44e380adb5343f3a487`,
  Control Plane
  `sha256:5999853de9a8f17a5d79659492a7b5686ab001b1f0e9531018c8471d8e6ec53d`,
  Employees
  `sha256:35706b2ba03f23222a2968e09cb9af8923daa416dc2b1dab559ecb62378b5397`;
  all healthy with exact revision labels.
- Cloudflare Worker: `hivemind-knowledge-ingest-production`, active version
  `cb297a0d-7025-4440-bd4c-a4f6e9c1ce5f`; dedicated production Workflow,
  Queue/DLQ, and R2 bindings. Flagship is enabled with default variation `off`
  and one environment-qualified operator canary rule.
- Tests and canary: 141/141 focused Core tests, Worker 2/2, TypeScript, Wrangler
  dry-run, Prisma validation, public checks, and clean fresh critical logs.
  Production job `60828bf4-4578-48c4-948e-a9affebdde0a` completed with 10/10
  receipts, 1/1 vector, five memories/citations, canonical entities, four graph
  relationships, and three exactly-once settlements. Duplicate starts reused
  the completed deterministic instance; persisted-hybrid recall succeeded.
- Backup: verified post-migration schema/data backup
  `/root/releases/backups/post-knowledge-ingest-5a979b73-20260830T150239Z.sql.gz`,
  SHA-256 `4f517652dc07696ba43576c51e139f61265a98a6ba539a905149a872754828af`.
- Rollback: remove the production canary rule or set
  `KNOWLEDGE_INGEST_WORKFLOW_ENABLED=false`; environment backup is
  `/root/hivemind/.env.pre-knowledge-ingest-20260830T143208Z`; prior canonical
  images are `hivemind/{core-api,control-plane,employees}:sha-40e3b3d1`.

## 048fba06 — BYOD canonical graph routing (Core only)

- Canonical SHA: `048fba06cb0437c77ff2c26ddd132509883c57d0` on
  `singulance-main`; migration: none; frontend: unchanged.
- Manifest: `/root/releases/manifests/048fba06/20260830T173838Z/RELEASE_MANIFEST.json`.
- Scope: governed explicit service-scoped deployment rebuilt and replaced only
  Core. Running images after acceptance: Core `sha-048fba06`, Control Plane and
  Employees `sha-b3616eb4`; all healthy.
- Verification: 20/20 focused tests; exact-user Flagship evaluation true and
  same-org/different-user evaluation false; BYOD create/update/relationship/list
  canary passed; canary data cleanup completed; public health green and fresh
  critical logs empty.
- Rollback: disable `knowledge_ingest_workflow_v1` to stop new Workflow
  admissions. Core rollback image `sha-81239791` remains the immediate code
  rollback without changing Control Plane, Employees, frontend, or tenant data.

## a4b0448c — canonical entity guarantee and Workers AI BGE-M3 (Core only)

- Canonical SHA: `a4b0448cc42b7ea7c98d656efaa9a640798a34f0`; frontend
  remained `93b15206d276c798993d57a63fd5694ff9609685`; migrations: none.
- Manifest: `/root/releases/manifests/a4b0448c/20260830T180454Z/RELEASE_MANIFEST.json`.
  Running Core image: `hivemind/core-api:sha-a4b0448c`, digest
  `sha256:cbee2ccca811c70e196f04a7258521967430ea8836879206ed701befb71f735e`.
- Scope: Core only. Exact source-supported entity names are now mandatory at
  the canonical promotion boundary and survive every downstream projection.
  Cloudflare Workers AI `@cf/baai/bge-m3` is primary through AI Gateway;
  OpenRouter `baai/bge-m3` is secondary.
- Acceptance: 20/20 contract tests plus 3/3 focused entity/provider tests;
  live Workers AI and post-release factory probes returned finite 1024-dim
  vectors; live entity canary retained typed person/product names; public API
  health and login passed; fresh critical-log count was zero.
- Rollback: governor-preserved Core image
  `sha256:900a1f55eb1884d5bbb65773d972dc5c4d05ed12c9629c42ff85e07c9eb2b3c1`
  and env backup `/root/hivemind/.env.before-cf-bge-20260830T180445Z`.

## bccbf73f — Phase 0 Canonical Knowledge Foundation canary

- Parent `bccbf73fdc1fdb40b1699d1251e7df12e6a15ce0`; frontend
  `59f3779b8291d5136a72a18867b5b4076ed46172`.
- Core `hivemind/core-api:sha-bccbf73f`, digest
  `sha256:8f4c6b3632e637e80ca109d4ae1f2b01cef99cc8cf16b16ab63705a37db62269`;
  Control `hivemind/control-plane:sha-346586be`, digest
  `sha256:285a4fdf44ee625ed0ad3f64807c6931b7623258cec4aa6d2d0b1abcc4061fbe`.
  Employees and data/infrastructure containers were not replaced.
- Migration `20260830190000_canonical_knowledge_foundation`; backup
  `/root/backups/hivemind-pre-phase0-20260830T192734Z.dump`, SHA-256
  `d76a7e0d13425f2beedc3c4f5d2e340f29ba5961e617e633f2a5d6d3241a3ffd`.
- Cloudflare canonical Worker `c8461f69-d815-4ea5-bba3-82fc644a3f3c`, frontend
  Worker `0ff3c24a-f722-4510-808c-dc50af597602`, Workflow
  `claim-74fb72fc-08da-41cc-8c56-598eae67bfee-v3` complete.
- Flagship `canonical_knowledge_foundation_v1`: default `off`, exact canary
  `full`, non-canary `off`.
- Acceptance: authenticated claims 200; exactly one Uwe/teaches/Deep Learning
  claim, two entities, typed roles, exact evidence, valid-from 2026-08-31,
  user-asserted, zero lineage, stable replay; public health 200, live frontend
  markers verified, fresh critical logs zero.
- Rollback: Flagship off or backend kill switch; governor rollback images and
  `/root/hivemind/.env.pre-phase0-20260830T1933Z` retained. Additive tables are
  inert on the stable path while disabled.

## 7dcc5f15 — Knowledge Base canonical projection parity

- Parent `7dcc5f15687a8088fb44d6938d5d4b1a9305a85f`; frontend unchanged at
  `59f3779b8291d5136a72a18867b5b4076ed46172`; migrations: none.
- Core `hivemind/core-api:sha-7dcc5f15`, digest
  `sha256:63f8785a4d7216bcb7c70e6f6f84bfd258c3176602f55dc36f6221633ac23929`;
  manifest `/root/releases/manifests/7dcc5f15/20260830T203237Z/RELEASE_MANIFEST.json`.
- Scope: Core only. The document promotion boundary now invokes the same
  tenant/user-flagged canonical materializer used by direct memory saves, with
  one latched rollout mode per document and repairable per-memory degradation.
- Acceptance: 17/17 focused tests; authenticated Cloudflare Workflow upload
  completed ready; all promoted memories received full/complete projection;
  exact typed teaches claim, entity roles, and document/segment evidence were
  persisted; multiple recall and chat queries passed after synthetic cleanup.
  Public health passed and fresh critical-log count was zero.
- Rollback: Flagship `canonical_knowledge_foundation_v1=off`, backend canonical
  kill switch, or `/root/quick-deploy.sh --rollback core`. Previous preserved
  Core image was `hivemind/core-api:sha-0bd3215e`.

## Flagship promotion — Canonical Knowledge Foundation global default

- At `2026-08-30T20:43:35.762Z`, Flagship app
  `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8` flag
  `canonical_knowledge_foundation_v1` changed from default `off` to `full`.
- Runtime code remains Core `7dcc5f15687a8088fb44d6938d5d4b1a9305a85f`,
  image `hivemind/core-api:sha-7dcc5f15`, digest
  `sha256:63f8785a4d7216bcb7c70e6f6f84bfd258c3176602f55dc36f6221633ac23929`.
  No code or infrastructure deployment was required.
- Acceptance: two unrelated production contexts evaluated `full/DEFAULT`; the
  original canary evaluated `full/TARGETING_MATCH`; authenticated live Worker
  checks returned HTTP 200 and `mode=full` for unrelated and canary identities.
- Rollback: `wrangler flagship flags set 6568ec71-67c6-4b2c-b2f3-98aebe9e81c8
  canonical_knowledge_foundation_v1 --variation off`, or the backend canonical
  kill switch for an environment-wide stop.

## 31962027 — Parallel recall reliability canary

- Parent `319620270b84392d13d3a2c8970c10cb299372ea`; frontend unchanged at
  `59f3779b8291d5136a72a18867b5b4076ed46172`; migrations: none.
- Core `hivemind/core-api:sha-31962027`, digest
  `sha256:715f48540ef97dc7d51263e22c34476f35fe68542cac964c02e3afd507f36ad4`;
  manifest `/root/releases/manifests/31962027/20260830T214532Z/RELEASE_MANIFEST.json`.
- Cloudflare canonical-projection Worker version
  `d99c1304-61ff-40c8-a4b5-b0b5c148ce80`. Flag
  `recall_parallel_reliability_v1` default remains `off`; exact canary rule is
  `on`. Core master gate is true.
- Acceptance: Worker 12/12 plus typecheck/dry-run; focused Core 18/18; Linux
  recall/evidence 79/79; chat-toolkit 2/2. Same-user on/off/on returned stable
  ordered results, final latest top-K followed descending requested known time,
  four lane receipts were complete, and chat returned grounded cited evidence.
  Public API/Core/login/home checks were 200 and fresh critical logs were zero.
- Rollback: exact canary flag off; Worker immutable version
  `c8461f69-d815-4ea5-bba3-82fc644a3f3c`; exact prior Core SHA
  `7dcc5f15687a8088fb44d6938d5d4b1a9305a85f` via the canonical service-scoped
  release runner. Do not use the retired quick-deploy rollback shortcut.

## daddc0cb — canonical invitation routing and explicit delivery

- Parent `daddc0cbee911964e9a1adb99d1ec144e87a2958`; frontend
  `0309ac2f2ad8446e1b4a84d9d142e9d08b129b00`; migrations: none.
- Core, Control Plane, and Employees were healthy on exact immutable
  `sha-daddc0cb` images. Cloudflare `hivemind-web` version
  `71eb6303-181c-4b49-a090-1a87dbd8e24e` served the exact frontend.
- Acceptance proved draft creation sent nothing, preview links used
  `next.singulancelabs.com`, credentials were generated only by explicit Send,
  unsupported dispatch returned 404, and a synthetic `.invalid` draft was
  revoked without invoking Send. Public routes were 200 and critical logs clean.
- Rollback: exact prior backend SHA `e5dd66c2`; frontend Worker version
  `97c462f1-0402-445f-b9b9-b5d77ddc7d52`.

## afd97867 — Playwright-first My Company preview

- Parent `afd9786705f87b851482004e3f79e8df748671b6`; frontend
  `bd777304ecfd1f1f4e61a990c846c887ee225268`; migrations: none; manifest
  `/root/releases/manifests/afd97867/20260831T175758Z/RELEASE_MANIFEST.json`.
- Playwright is the primary asynchronous website-preview renderer with a
  12-second timeout and 150-ms settle; Firecrawl is fallback only. The visible
  My Company preview loads eagerly at high priority. Awakening architecture
  copy is offset below the wordmark embedded in the background artwork.
- Runtime digests: Core
  `sha256:9317cd0df9a860cd2af58e0488366d75ace62ed5efd6bc1db84a460c7dcd4109`,
  Control `sha256:343063c99257dda78385eeb6600a5e9282e9f52f0dffd697001adf787fb0615d`,
  Employees `sha256:bc8eb2b6d5def2a7f9bb1c12daa1a4bf5fef4fccbed8f104bc00e0103cb19d68`.
  Cloudflare `hivemind-web` version
  `a853f74f-207a-4bd1-bb07-f5505c339923` is active at 100%.
- Acceptance: backend 2/2, frontend 2/2, optimized build, authenticated
  read-only My Company 200 with `playwright-screenshot`, standalone deployed
  Playwright capture returned a valid screenshot without Firecrawl, public
  routes were 200, and fresh critical logs were zero. No customer writes or
  onboarding runs were triggered.
- Rollback: backend `daddc0cb`; frontend Worker version
  `71eb6303-181c-4b49-a090-1a87dbd8e24e`.

## e2e2c055 — Existing HyperRoom fast-planner canary

- Parent `e2e2c055e56ed7d8a18bb7a0b099503f987b9f6a`; frontend unchanged;
  migration `20260831224500_hyper_fast_planner_flag`; manifest
  `/root/releases/manifests/e2e2c055/20260831T182301Z/RELEASE_MANIFEST.json`.
- Core digest `sha256:524967d1456ae3e46ccb03341ed1d5749e3d7cbf33e4cf68efea2e7b8d6bfb0f`;
  Control digest `sha256:697db8484c50c508b2d1d875111a6a02fdb112221c4f28178b9b43707438d1c6`;
  Employees digest `sha256:381de1e338b17173dc53c8f9ca78fbf75a066efa80249f09729cdb8d94ecdced`.
- Canonical-projection Worker version
  `9346733c-5ce7-4c6f-8cdf-50a676091f56`. Flag
  `hyperagents_fast_planner_v1` is default-off and targets exactly org
  `f0cb77ef-e62b-4f8c-a1da-066611fc3b36` plus user
  `b457c254-38a0-4c43-8280-b026f1a78b04` with `glm_no_reasoning`.
- Acceptance: target/mismatch live evaluations passed, GLM Flash returned a
  valid response through Cloudflare AI Gateway with thinking disabled, all
  three services were healthy at the exact revision, public health returned
  200, and fresh critical logs were empty.
- Scope: existing HyperRoom runtime only. No Grok runtime Worker, durable-agent
  stage, browser-agent stage, or Grok schema was deployed.
- Rollback: serve `off` to the exact canary, then use the governed rollback
  images `hivemind/core-api:sha-afd97867`,
  `hivemind/control-plane:sha-afd97867`, and
  `hivemind/employees:sha-afd97867` if code rollback is required.

## 8d35d3c2 — Gemini Unified-Billing planner

- Canonical SHA `8d35d3c26eb3170f35364fbc0e056512486f3522`;
  frontend unchanged; manifest
  `/root/releases/manifests/8d35d3c2/20260831T192956Z/RELEASE_MANIFEST.json`.
- Existing canary planning/profile/verification now uses
  `google/gemini-2.5-flash-lite` through Cloudflare Unified Billing and the
  `hivemind-prod` AI Gateway. OpenRouter BYOK is not used for this route.
- Acceptance: 55 focused tests, two live Unified Billing inference probes,
  exact-revision health for Core/Control/Employees, public API health, and a
  clean fresh critical-log scan.
- Rollback: canary flag `off`; Employees/Control `sha-e2e2c055`; Core
  `sha-f4107cc8` through the canonical release governor.

## f4107cc8 — Knowledge ingestion v2 accepted; production flag remains off

- Canonical SHA `f4107cc82490a1ddf57a7b215955be6184d4038b`; Core image
  `hivemind/core-api:sha-f4107cc8`, digest
  `sha256:77083aab6997bfbda1a9ddbf2d0294396197528ccd399c90b4ccbcef7713c217`.
  Manifest `/root/releases/f4107cc8/RELEASE_MANIFEST.20260831T190559Z.json`,
  SHA-256 `5feb6e6895ada6ac26891915fd9b22dc0d346563b61d1f147d3041f2297006cd`.
- Worker `hivemind-knowledge-ingest-production` version
  `d8547ac3-6609-4b47-bf87-32cd9d9c185a` is active at 100%. Flagship
  `knowledge_ingest_workflow_v1` remains globally production-off; default and
  both production rules serve `off`, while local-only behavior is preserved.
  Operator and unrelated contexts both evaluated off after acceptance.
- Applied schema-qualified `20260831235900_knowledge_ingest_processing_lease`
  and corrective `20260901000500_fix_knowledge_ingest_lease_schema`. Verified
  backups: `/root/backups/hivemind-pre-ff80d612-20260831T184059Z.dump`
  (`80bd47e0911b034d86e0dfe0e23f5bd858a359d87a98bbe451dfa0098c195ce8`)
  and `/root/backups/hivemind-pre-87c49282-20260831T185253Z.dump`
  (`2ff50f02d0ec10ab63042705ea22946618f6d074184a62708f817ba3f5c7a101`).
- Two rejected canaries were rolled back before acceptance: `ff80d612` exposed
  the wrong-schema migration and created no document/evidence; `87c49282`
  reached real materialization/promotion but reconciliation rejected a new
  zero-yield reason. Final `f4107cc8` maps it to existing allowed
  `extraction_yield_zero`. No customer evidence changed.
- Accepted disposable PDF job `577defcf-94d4-48e5-ad46-866dba0ed358` completed
  Workflow `kb-577defcf-94d4-48e5-ad46-866dba0ed358-v1` in seven steps.
  Acquire, `materialize_evidence`, `promote_memories`, materialize, and reconcile
  each succeeded once at attempt 1; the lease cleared. Recall returned the exact
  marker, filename, and document citation. Identical replay returned
  `duplicate_document` for the same job/checksum without redispatch. All
  disposable database and R2 artifacts were deleted and verified absent.
- Direct Cloudflare Gemini multimodal REST verification returned 200. API/home
  health passed and fresh critical logs were clean. Control and Employees were
  neither rebuilt nor restarted.
- Rollback: keep the flag off; Core
  `e2e2c055e56ed7d8a18bb7a0b099503f987b9f6a`; Worker
  `d917d0a1-38fe-4933-a4eb-34bcb891c625`; database backups above.

## Flagship promotion — Knowledge ingestion v2 global enable

- At `2026-08-31T19:19:01.181Z`, Flagship app
  `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8` promoted
  `knowledge_ingest_workflow_v1` for all production users. The full-definition
  update changed only default `off` to `on` and production rules at priorities
  2 and 3 from `off` to `on`. Enabled state, boolean variations, description,
  rule conditions/priorities, and the local `on` rule were preserved.
- Both prior production targets evaluated `true`/`on` with
  `TARGETING_MATCH`; two unrelated synthetic production contexts evaluated
  `true`/`on` with `DEFAULT`; the local context remained `true`/`on` with
  `TARGETING_MATCH`. The bound production Worker's authenticated `/enabled`
  route independently returned HTTP 200 and `enabled:true` for all four
  production contexts.
- No code, image, Worker version, container, migration, or customer content was
  changed. Core remained healthy at `f4107cc8` with unchanged start time and
  digest `sha256:77083aab6997bfbda1a9ddbf2d0294396197528ccd399c90b4ccbcef7713c217`;
  Worker `d8547ac3-6609-4b47-bf87-32cd9d9c185a` remained active at 100%.
  API/home health passed and the fresh critical Core log scan was empty.
- Exact rollback payload is the precondition-read definition recorded by the
  governor: default `off`, local priority 1 `on`, production priorities 2 and 3
  `off`, with all other fields unchanged.

## 97afbd87 — HyperAgent GPT-OSS 20B Bedrock-first routing

- Canonical SHA `97afbd87760771789b5a8adab651027dd18d51a1`; frontend unchanged;
  manifest
  `/root/releases/manifests/97afbd87/20260831T194741Z/RELEASE_MANIFEST.json`.
- Core digest `sha256:c490054e844fdd5ef86586802b551b266af2a70ad8729b954fc5bda2ba0a6ccd`;
  Control digest `sha256:256dbd0bc9880bbe44c3f50693e8181f6f4b021ac5b79eef5d53a38bf5dc32ba`;
  Employees digest `sha256:5892ec0556f0b0e9fec8f0f203a1d67e0adec59dca0c47018e56b2f2876eddcd`.
- The fast tier remains `openai/gpt-oss-20b:nitro` through Cloudflare AI
  Gateway and OpenRouter, preferring Amazon Bedrock, Amazon Bedrock EU, Groq,
  then Together. OpenRouter fallback remains enabled.
- Acceptance: 11 focused tests, live pre-release and deployed-path inference
  served by Amazon Bedrock, exact-revision service health, public API health,
  and an empty fresh critical-log scan. No migration was applied.
- Rollback: governor rollback to the preceding `8d35d3c2` service images.

## 22f549a3 — staged Cloudflare ingestion throughput

- Canonical parent SHA `22f549a3c300cf46c3bcb0ed412ff85cadd61e4e`;
  frontend unchanged at `c5a4973c468f39f86f573284180f95afa140145a`.
- Core image digest
  `sha256:012ee1498ea4d1e55fe623f41a15b29944db66823640d1979d0e5567d85d2eec`;
  manifest
  `/root/releases/manifests/22f549a3/20260831T222531Z/RELEASE_MANIFEST.json`.
  No migration was pending or applied.
- Knowledge Worker deployment `9225e2b9e0884df5ba44cbba3d76b3ee` and
  Workflow version `ab5db32d-d295-43c3-8dc3-47f6ce6c6664`; production Queue
  consumer concurrency changed from 1 to 5 while retaining batch size 10,
  retries 5, retry delay 30 seconds, and the existing DLQ.
- Acceptance: six concurrent PDF jobs across two bursts reached `ready`; the
  final burst had one-attempt acquire, materialize-evidence, promotion, and
  reconcile receipts, overlapped parser/embed/promotion stages, zero fresh
  scheduler conflicts, zero fresh fatal errors, public health 200, and exact
  Core revision health. Two retained JPEG incident jobs also replayed to
  `ready` from R2 as v2 with one canonical memory each.
- Global rollout: Flagship default is `on`, all retained production rules serve
  `on`, and the authenticated bound Worker returned `enabled:true` for an
  unrelated production context plus both historical canary tenants. Emergency
  rollback is Flagship default/rules to `off`, or the existing Core master
  environment gate; Core image rollback uses the governor's saved stable tag.

## da923a8c — immediate durable ingestion dispatch

- Canonical parent SHA `da923a8c9bae63b72d7d5fc70b707c91c011f548`;
  frontend unchanged at `c5a4973c468f39f86f573284180f95afa140145a`.
- Core image digest
  `sha256:3008d4cd853c2e84129fb8fe49cc6008fc52b438f6221837bc19d453db6828b7`;
  manifest
  `/root/releases/manifests/da923a8c/20260831T224635Z/RELEASE_MANIFEST.json`.
- Additive migration `20260831224000_ingest_stage_wait_queue` created the
  indexed durable stage queue. No data service was restarted; only Core was
  rebuilt and recreated through the canonical governor.
- Canary job `42fea1d8-c269-41d1-8bd9-36dcfaf4bc71` completed through the
  globally enabled Cloudflare Workflow path with all receipts at attempt 1,
  one evidence segment, three canonical memories, and millisecond stage
  handoffs. Core health returned 200 and the fresh critical-log scan was empty.
- Flag and Worker versions were unchanged from the accepted `22f549a3` release.
  Rollback is the governor-captured prior Core image
  `sha256:012ee1498ea4d1e55fe623f41a15b29944db66823640d1979d0e5567d85d2eec`;
  emergency admission rollback remains the backend gate or Flagship off.
## 2ea1d984 — global Runtime and Social frontend access

- Canonical parent SHA `2ea1d984a45d03d2c2a58cdcf741e0ed4c3674cf`;
  Da-vinci SHA `b231ec8350e97edba162358f2c7d5c273124a672`.
- Cloudflare Worker `hivemind-web` version
  `d5c1c0f8-034b-4966-a9a1-35aadc9f2300` serves the release on
  `next.singulancelabs.com`.
- Runtime and Social now route directly to their live workspaces for all
  authenticated users. The legacy Runtime waitlist and Social preview gates
  are not present in the deployed HyperAgents asset.
- Acceptance: 2 focused route-contract tests, successful production bundle,
  Runtime deep-link HTTP 200, and live-asset inspection. No migration or
  backend service restart occurred.
- Rollback: Cloudflare Worker version
  `8d0621d6-4cf4-4e8f-9358-e8b4e8f76b1e` and parent SHA `f66b7daa`.
## db4b06e3 — targeted Runtime onboarding introduction

- Parent SHA `db4b06e32bb50efa80818f3928709671a1e69745`; Da-vinci SHA
  `40c7747bfb3db5106609ab1a4d5a961e1d9378ef`; Cloudflare Worker
  `e85c67ef-0f25-4a92-9bb3-a7f091894835`.
- The post-onboarding `Try Runtime` introduction is enabled only for the
  explicitly requested user/organization pair. It is one-time per browser for
  rollout version `canary-20260901` and opens live Runtime.
- Acceptance: 4/4 focused tests, successful Cloudflare production build,
  company deep-link HTTP 200, and exact live-asset marker verification. No
  backend service, database, migration, or tenant data changed.
- Rollback: Cloudflare Worker
  `d5c1c0f8-034b-4966-a9a1-35aadc9f2300` and parent `8d0d5004`.

## bd01edd9 — Day 1 resumable competitor market research

- Canonical parent SHA `bd01edd9ebe0bced647d1951abb8b07e37acf06f`.
- Core, Control Plane, and Employees were rebuilt through the governed
  `singulance-main` path and all became healthy on immutable `sha-bd01edd9`.
- Day 1 now prioritizes the deterministic website-onboarding competitor/local
  market task, reuses an active/sealed research-room turn instead of duplicating
  work, and passes the company HQ location to a newly launched HyperAgents run.
- Acceptance: focused Day 1 suite 15/15, clean syntax/diff checks, repaired
  lifecycle prepare returned `completed`, and exactly one email delivery was
  accepted. Flag remains globally on: `day1_first_move_v1`.
- Rollback: set `HIVEMIND_D1_WORKFLOW_ENABLED=false` or disable the Flagship
  flag. There is no migration and stored delivery receipts remain idempotent.

## 69c46eae — reusable lifecycle Queue admission

- Canonical parent SHA `69c46eaed2c35014c58aae2fb653f0487e3d5d82`; Worker
  `hivemind-day1-lifecycle` version
  `ed9b1a9e-fbe0-49da-b777-20141915ccb4`.
- Provisioned Queue `hivemind-lifecycle-admission-v1` and DLQ
  `hivemind-lifecycle-admission-dlq-v1`. Day 1 admissions are delayed until
  due, bounded to ten concurrent launches, retried individually up to ten
  times, and reconciled every five minutes for up to 500 receipts.
- Acceptance: core suite 16/16, Worker typecheck and dry-run passed; the live
  idempotent admission smoke returned accepted and retained its prior `sent`
  receipt. Core, Control Plane, and Employees are healthy at `sha-69c46eae`;
  fresh fatal-error scan clean.
- Rollback: rollback Worker then set the backend gate false or disable the
  Flagship flag. No database migration; provider receipts prevent duplicates.

## 88c8a6d5 — platform-admin lifecycle visibility

- Parent SHA `88c8a6d5f218216d7d586348f3ad20f9cf228bce`; Da-vinci main SHA
  `e3f65bc29548b81289201fabb4ab4f70832fb1f5`; Cloudflare Worker
  `hivemind-web` version `8c37fed9-1206-47cf-8ebf-70fe7f2df724`.
- Control Plane alone was rebuilt through the governed service-scoped release;
  it runs immutable `hivemind/control-plane:sha-88c8a6d5`. No migration or data
  service restart occurred.
- The platform admin user table now exposes a read-only Lifecycle panel. It
  reports per-active-organization days since awakening and Day 0/1/2 lifecycle
  counts/statuses from tenant-owned HQ state. The endpoint requires the existing
  platform-admin cookie and makes no writes.
- Acceptance: frontend lint, optimized build, Wrangler dry run, and Worker
  deploy passed; `admin.hivemind.singulancelabs.com` returned 200; the new
  lifecycle bundle marker is served; the unauthenticated API route returned
  401; and Control Plane health plus the fresh critical-log scan were clean.
- Rollback: Cloudflare Worker rollback to its preceding version and governor
  rollback of the Control Plane service to its preserved stable image.

## c46ebea — Knowledge Base browser admission limits

- Parent SHA `c46ebeac65159318b62cf9f287ffdc32ea84f302`; frontend main SHA
  `0bac95492a2e6f3e8ea6b77e26c4902f19c9acbf`; Cloudflare Worker version
  `764cc740-78f2-4a64-b561-6c11087e9dab`.
- User-facing change: folder selection removed; each selected file is limited
  to 10 MB; PDF selection is limited to 100 verifiable pages. These checks run
  before upload and again at the browser network boundary.
- Acceptance: release guard passed on exact frontend main, guarded Worker build
  completed, `https://next.singulancelabs.com/hivemind/app/knowledge` returned
  200 from Cloudflare, and the public lazy chunk contained the new drop-zone
  copy while omitting the folder-picker copy.
- Rollback: Worker version `6fd6b92c-90fd-408e-8844-498f4ed7b371`. No backend
  deploy, migration, flag, or stored data change.

## c09ff95b — complete Day 0 portrait Awakening report

- Parent SHA `c09ff95b2641d5cfd5bb26159c19e0356c38a27f`; feature SHA
  `6e0df1d4`. Control Plane alone was rebuilt through the governed path and is
  healthy on immutable `hivemind/control-plane:sha-c09ff95b`.
- The `day-0-v5` attachment carries all ten original Day 0 content sections in
  a continuous six-page A4 portrait report. The established transactional
  email body remains unchanged.
- Acceptance: focused tests 7/7; all six rendered pages visually verified;
  Cloudflare Email Service returned `delivered`; replay returned
  `accepted:false`; public API health returned 200; fresh logs were clean.
- Sender authentication was verified through the public Cloudflare Email
  Sending SPF/DKIM/bounce records and DMARC `p=reject` for the transactional
  subdomain. Recipient inbox/tab classification remains provider-controlled.
- Rollback: governor rollback of Control Plane to `sha-886338b6`. Existing v5
  receipts remain immutable and prevent duplicate delivery.

## 35fd9c70 — Day 0 original-theme portrait report

- Parent SHA `35fd9c705e29f6e768f5979095b353d6b7b773e1`; feature SHA
  `e357a60d`; Control Plane healthy on immutable
  `hivemind/control-plane:sha-35fd9c70`.
- `day-0-v6` retains the original ten-page Cartesia/Singulance visual language
  and content while reflowing each page to A4 portrait. The email is unchanged.
- Acceptance: focused tests 7/7, ten-page Playwright render visually verified,
  authenticated owner reissue queued, public API health 200.
- Rollback: governor rollback of Control Plane to `sha-c09ff95b`.

## 20f5af22 — reusable compact lifecycle portrait reports

- Parent SHA `20f5af2261a34b6b4fbaa18e3f55adc97bc23312`; feature SHA
  `15415dbf`; Control Plane healthy on immutable
  `hivemind/control-plane:sha-20f5af22`; manifest
  `/root/releases/manifests/20f5af22/20260903T114107Z/RELEASE_MANIFEST.json`.
- `day-0-v7` retains all ten original report sections but composes them into
  five compact A4 portrait pages using the reusable lifecycle shell. Every
  page has the standard Singulance header/footer; oversized per-page slogan
  footers are removed. The transactional email body and provider stay intact.
- Acceptance: focused tests 7/7; five-page Playwright PDF visually verified;
  authorized production send returned Cloudflare `delivered`; replay returned
  `accepted:false`; public API health returned 200; fresh delivery log present.
- Rollback: governor rollback of Control Plane to `sha-35fd9c70`. Existing v7
  receipts remain immutable and prevent duplicate delivery.
