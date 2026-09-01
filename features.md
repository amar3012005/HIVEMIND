# Singulance Feature Registry

## feature-20260901T073500Z — global runtime and organic social campaigns

- Production Connector Runtime is enabled for Chat, HyperAgents, TARA, MCP,
  and durable connector sync, with all registered connectors available subject
  to tenant connection and authorization.
- AI Campaigns is enabled for every organization. Governed execution supports
  X organic, LinkedIn, Instagram, Facebook, TikTok, YouTube, Pinterest, Reddit,
  Threads, Bluesky, and Google Business.
- Availability does not grant silent publishing: provider connection,
  execution readiness, explicit campaign approval, worker/channel gates, and
  audit receipts remain enforced. Paid X advertising remains provider-gated
  and disabled because API approval is not present.
- Runtime acceptance used Core SHA
  `b42ea7a610e64b5bdb6faece6fabf77cc8b453ed` and verified two tenant contexts,
  public campaign-page/API health, connector capability issuance, durable-sync
  startup, and clean critical logs without publishing customer content.

## feature-20260831T230928Z — restart-safe text and image ingestion

- Flag `knowledge_ingest_workflow_v1` remains globally enabled. Core release
  `1765ad96bfd726e1fe358e5bc6aaf589ece99420` and Worker version
  `e64dc93f-065a-4512-b5db-5435ecfaee2a` are active.
- Short but coherent native PDF text remains text-first; character density no
  longer forces whole-document vision or Docling. Visual-page enrichment stays
  selective and Gemini 2.5 Flash Lite remains behind Cloudflare AI Gateway.
- Current-version Workflow checkpoints are safely redispatched after a Core
  restart. Redispatch is version-fenced and idempotent; completed receipts are
  reused and cannot duplicate evidence, memories, vectors, or billing.
- Fresh three-file production acceptance completed in 11–17 seconds with
  attempt-1 receipts and overlapping extract/embed/promote stages. Live PNG,
  JPG, and JPEG paths all reached canonical ready state with one memory.

This append-only registry is the global record of features accepted on
`singulance-main`. Add an entry only after the governed production release and
runtime verification have completed. Use the same feature identifier in
Cloudflare Agent Memory and in the `singulance-local` registry.

## feature-20260831T085220Z — Best ingestion, recall, and chat matrix globally enabled

- Production status: globally enabled and runtime-verified for all users.
- Cloudflare Flagship app: `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8`.
  Final defaults are `knowledge_ingest_workflow_v1=on`,
  `recall_parallel_reliability_v1=on`, `durable_chat_agent_v1=full`, and
  `canonical_knowledge_foundation_v1=full`. Existing variations and targeting
  rules remain intact.
- Recall promotion: the governed full-definition PUT at
  `2026-08-31T08:52:20.083Z` changed only
  `recall_parallel_reliability_v1.default_variation` from `off` to `on`.
  Two unrelated contexts evaluated `on` by `DEFAULT`; the operator canary
  remained `on` by `TARGETING_MATCH`.
- Runtime: Core `9091c1e01d63270a14d668cf60c6634d27469e95`, Control
  `953f3a719aab66aed5b1f479ed6e45f232613761`, and Employees `b3616eb4`.
  Their immutable images, start times, and restart counts were unchanged.
- Acceptance: eight Cloudflare Workflow ingestion jobs are terminal-ready with
  zero duplicate checksum groups. Parallel recall completed memory lexical,
  memory vector, evidence lexical, and evidence vector lanes without
  degradation, returning 3 memories, 12 evidence items, 15 citations, and 17
  graph edges. Five authenticated chat classes returned HTTP 200.
- Known semantic limits: the broad entity chat canary returned
  `grounded=false`; relationship and entity canaries each retained one evidence
  gap. These are tracked quality limitations, not orchestration or availability
  failures, and this release does not claim perfect semantic coverage.
- Health: API and homepage returned 200, the critical production log scan was
  clean, and no container or Worker was rebuilt or restarted.
- Rollback: full-replace the preserved recall flag definition with only
  `default_variation=off`. Ingestion, chat, and canonical knowledge each retain
  their independent prior default variation for an isolated behavioral rollback.

## feature-20260831T082806Z — Durable chat orchestration globally enabled

- Production status: deployed, globally enabled, and verified for all users.
- Capability: durable chat sessions and turn lifecycle around the existing
  grounded native planner, progressive profile discovery, hybrid memory plus
  evidence recall, citation validation, graph relationships, and canonical
  memory saves.
- Runtime: Core `9091c1e01d63270a14d668cf60c6634d27469e95`, image
  `hivemind/core-api:sha-9091c1e0`, digest
  `sha256:258e140bc90f0bd2478371d7d12caf247e88648aa4f8e6eb5e318e8d5a6bb261`.
- Cloudflare: Flagship app `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8`, string flag
  `durable_chat_agent_v1`, enabled with global default variation `full`.
  Variations `{off, shadow, session, workflow, full}`, both existing targeting
  rules, and description were preserved exactly. Two unrelated contexts
  evaluated `full` with reason `DEFAULT`; the original operator evaluated
  `full` through its preserved targeting rule.
- Acceptance: direct, profile, exact-source, relationship, broad recall,
  project-list, temporal no-coverage, aggregate no-coverage, and canonical
  declarative save paths returned the expected production behavior. Core/API/
  homepage are healthy; critical logs are clean; no service was rebuilt or
  restarted for the flag change.
- Rollback: full-replace the same preserved Flagship definition with only
  `default_variation` changed back to `off`. The captured definition retains
  every variation and rule; no code, schema, or container rollback is required.

## feature-20260829T203749Z — Day 1 lifecycle default-on

- Production status: deployed, globally enabled, and verified.
- Capability: reusable Cloudflare Workflow lifecycle for Day 1 research delivery,
  responsive branded email rendering, Humation character colors, and projection
  of every accepted transactional email into platform notifications.
- Runtime commit: `d843a66885878a605c4bc6d9589e207d568433b4`.
- Cloudflare: Flagship app `2e89fbd3-7496-459b-a507-f1017d444dd9`, flag
  `day1_first_move_v1` enabled with default variation `on` and no targeting rules;
  Worker `hivemind-day1-lifecycle`, deployed version
  `cf1d4048-ac88-4bbc-9cba-b5c66a996d89`.
- Rollout evidence: all three eligible organizations started through the same
  authenticated deterministic lifecycle endpoint; all three Workflow instances
  completed. PostgreSQL recorded three linked, uniquely deduplicated
  `lifecycle.email.sent` platform notifications and zero duplicate dedupe keys.
- Local acceptance: `singulance-local` commit
  `b15b4ceb5d354f9281626cad9bd863c153a1ae6c`; 30 focused tests passed and the
  rebuilt local control-plane was healthy.
- Rollback: disable the Flagship flag for immediate evaluation rollback, or set
  `HIVEMIND_D1_WORKFLOW_ENABLED=false` as the backend master kill switch. The
  reconciliation scheduler remains throttled to five organizations per cron run.

## feature-20260830T004500Z — Public AI discovery policy

- Production status: deployed and verified. Public `singulancelabs.com` serves
  `robots.txt`, `llms.txt`, `llms-full.txt`, and sitemap guidance for indexing,
  citation, retrieval, and direct AI-user visits; training/fine-tuning is
  declined.
- Privacy boundary: `next.singulancelabs.com`,
  `admin.hivemind.singulancelabs.com`, and `icarus.singulancelabs.com` deny
  discovery-file paths through Cloudflare WAF ruleset
  `06fb27e2007640bea0a590a353797322`; application HTML remains `noindex`.
- Release: parent `fe71aa3c173359659e0a3144df9aef3c0fde6eda`; frontend
  `93b15206d276c798993d57a63fd5694ff9609685`; Worker `hivemind-web` version
  `acc99047-4b86-41ca-b1b4-d00c55d6c75e`.
- Rollback: roll back the Worker and disable/delete only that WAF ruleset; no
  database or customer data changed.

## feature-20260830T012000Z — Enterprise canonical ingestion Workflow v1

- Local status: implemented and accepted for `singulance-local`; production and
  `singulance-main` remain unchanged.
- Capability: Cloudflare Queue + Workflow orchestration, R2 source durability,
  PostgreSQL lease/checkpoint receipts, replay-safe canonical evidence, memory,
  entity, and citation materialization, with unchanged browser/API contracts.
- Controls: `HIVEMIND_LOCAL_MODE=true`,
  `KNOWLEDGE_INGEST_WORKFLOW_ENABLED=true`, and Flagship
  `knowledge_ingest_workflow_v1=true` for the test organization. Either feature
  control rolls new admissions back to BullMQ.
- Cloudflare local resources: Worker `hivemind-knowledge-ingest-local`, Workflow
  `hivemind-knowledge-ingest-workflow-local`, Queue/DLQ
  `hivemind-knowledge-ingest[-dlq]-local`, and R2
  `hivemind-ingest-artifacts-local`. Hosted Worker version:
  `ad64498c-2489-459c-a664-7de235a7bd38`.
- AI parity: production Gemini/DeepSeek/Groq policy and BGE-M3 1024-dimensional
  embeddings use AI Gateway `hivemind-prod`; credentials are not stored in Git.
- Verification: 133/133 focused backend tests; Worker 2/2 tests, TypeScript
  check, and Wrangler dry-run; frontend AI-discovery 3/3 and full CRA build;
  Prisma validation; local and hosted replay canaries.
- Runtime canary: job `cca99f31-fcfd-4707-b0ba-2d84de3f9d9c` produced one
  document, two evidence segments with 2/2 vectors, ten candidates, eight
  memories, nine citations, ten successful receipts, and one canonical Paolo
  entity. Duplicate hosted starts completed once with unchanged counts.
- Baseline note: unfiltered root `npm test` is not a valid Windows release gate
  today because it mixes Vitest with Node's runner, references retired absolute
  paths/modules, and requires a Linux-only AMR binary. The focused ingestion
  suite and local Linux container runtime are green.

## feature-20260830T150300Z — Durable canonical ingestion Workflow production canary

- Production status: deployed and accepted on canonical parent
  `5a979b736c2e02214cae8e95785446e66748dff7`. The public upload, polling,
  duplicate, scope, billing, memory, and citation payloads remain unchanged.
- Cloudflare resources: Worker `hivemind-knowledge-ingest-production`, Workflow
  `hivemind-knowledge-ingest-workflow-production`, Queue/DLQ
  `hivemind-knowledge-ingest[-dlq]-production`, and R2
  `hivemind-ingest-artifacts-production`. Active Worker secret-change version:
  `cb297a0d-7025-4440-bd4c-a4f6e9c1ce5f`.
- Flagship `knowledge_ingest_workflow_v1` remains default-off. It has separate
  environment-qualified local and production canary rules, so neither tenant ID
  can accidentally enable the other environment.
- Production canary job `60828bf4-4578-48c4-948e-a9affebdde0a` completed through
  `cloudflare_workflow`: one document, one evidence segment/vector, four
  candidates, five memories, five citations, canonical entity links, four
  relationships, ten successful receipts, and three exactly-once settlements.
  Two duplicate starts reused the completed deterministic Workflow instance;
  counts remained stable. Persisted-hybrid recall returned the synthetic Paolo
  canary memory.
- Tests: 141/141 focused Core tests, Worker 2/2 tests, TypeScript, production
  Wrangler dry-run, Prisma generation/validation, public health, tenant-scoped
  ingestion/recall, duplicate replay, persisted-count checks, and fresh critical
  log scan passed.
- Rollback: disable the Flagship rule or set
  `KNOWLEDGE_INGEST_WORKFLOW_ENABLED=false`; canonical rollback images are the
  prior `sha-40e3b3d1` Core, Control Plane, and Employees images.

## feature-20260830T174500Z — BYOD canonical graph parity for flagged ingestion

- Production status: accepted on Core SHA
  `048fba06cb0437c77ff2c26ddd132509883c57d0`. Control Plane, Employees,
  frontend, local Docker settings, databases, and Cloudflare resource bindings
  were not rebuilt or replaced.
- Fix: the storage backend selected for a BYOD memory is latched onto hydrated
  rows and every canonical graph projection. Updates, Extends, Derives,
  Contradicts, entity projection, and citation/relationship writes can no
  longer fall through to central PostgreSQL when an async boundary loses
  request-local routing context.
- Production canary: two tenant-scoped BYOD writes returned 201; the second
  returned `mutation.operation=updated`; the agent returned one certified
  Updates edge; the prior memory became non-latest; and deterministic tags for
  Paolo Meridian, Heidelberg, and Atlas Memory Box were present. Exact canary
  memories were removed after verification.
- Flagship: `knowledge_ingest_workflow_v1` evaluates true only for production
  org `0a1d5b33-a33c-49a6-8185-6d16370670a2` plus user
  `727af46d-6bdf-4a77-ac7f-1c8c59bde96d`; a different user in the same org
  evaluated false. Default remains off.
- Verification: focused graph/deployment tests 20/20, public health green,
  Core `sha-048fba06` healthy, Control Plane and Employees unchanged on
  `sha-b3616eb4`, and the post-canary three-minute critical-log scan was empty.
- Rollback: disable the Flagship rule for new Workflow admissions; for the Core
  graph fix use the governor-preserved `sha-81239791` rollback image.

## feature-20260830T180000Z — Second production ingestion canary tenant

- Flagship-only rollout; no Worker, container, database, frontend, or local
  deployment changed.
- `knowledge_ingest_workflow_v1` now also evaluates true only for production
  org `bfbdd2bc-e214-44e5-80d4-e3284256d0c0` plus user
  `e35811aa-4bcd-44bb-b829-a437895a42eb`. A different user in the same org
  evaluates false; the global default remains off.
- Day 1 audit: production `day1_first_move_v1` is enabled, default-on, and has
  no targeting rules. The production `HIVEMIND_D1_WORKFLOW_ENABLED` backend
  gate is also true, so Day 1 is enabled for every eligible user.

## feature-20260830T181000Z — Exact canonical entities and Cloudflare BGE-M3

- Production Core release `a4b0448cc42b7ea7c98d656efaa9a640798a34f0`
  makes supported exact subject/entity names a default invariant of canonical
  knowledge-memory promotion; no feature flag is required for correctness.
- The generator schema requires `subject` and `entities`. The canonical
  materializer merges supported declared entities, subject, and relationship
  endpoints before memory tags, metadata, evidence metadata, vector payloads,
  and central/embedded/hybrid/BYOD entity projection.
- Production embedding order is Cloudflare Workers AI
  `@cf/baai/bge-m3` through `hivemind-prod`, then OpenRouter
  `baai/bge-m3`. Both emit 1024-dimensional BGE-M3 vectors; timeout failover is
  enabled without weakening caller cancellation.
- Verified with 23 focused tests, a live Workers AI preflight, a post-release
  finite-vector canary, typed exact-name materialization, public checks, and a
  clean critical-log scan. No frontend, Flagship targeting, Cloudflare
  Workflow resource, database, or local deployment configuration changed.

## feature-20260830T184000Z — Quiet durable-ingestion connectivity handling

- Production frontend `3fb492ac6e69008f19bc71bbe9fc81878e806b2f`
  no longer shows a global connection outage for an individual Knowledge Base
  status-poll miss. Durable polling continues normally.
- The global health badge requires three consecutive failures before showing
  Offline and returns Online after the first successful probe. User-action and
  confirmed service failures remain visible.
- Accepted as Cloudflare Worker version
  `288561fd-e001-4132-a82c-7e8f0711d9e3` after focused tests, production build,
  dry-run, served-bundle inspection, and public login verification.

## feature-20260830T200500Z — Canonical Knowledge Foundation Phase 0 canary

- Production was first accepted for exact user
  `e35811aa-4bcd-44bb-b829-a437895a42eb` and organization
  `bfbdd2bc-e214-44e5-80d4-e3284256d0c0`. After Knowledge Base canonical
  projection acceptance, Flagship was promoted globally to default `full` on
  2026-08-30; the backend environment kill switch remains available.
- Canonical source: `singulance-main`
  `bccbf73fdc1fdb40b1699d1251e7df12e6a15ce0`; frontend
  `59f3779b8291d5136a72a18867b5b4076ed46172`.
- `CanonicalClaim` stores factual predicates separately from memory lineage.
  `/relationships` remains Updates, Extends, Derives, Contradicts, and PartOf.
- Canary proof: one `Uwe Egly -> teaches -> deep learning` claim, two entities,
  subject/actor and object/technology roles, valid from 2026-08-31,
  `user_asserted`, exact source evidence, and zero lineage. Replay stayed 1/2/0.
- Cloudflare canonical Worker `c8461f69-d815-4ea5-bba3-82fc644a3f3c` and
  frontend Worker `0ff3c24a-f722-4510-808c-dc50af597602` are live. The
  multivariate flag now serves `full` by default to every valid tenant/user
  context. The UI separates Claims from Memory lineage.
- Rollback: set the canary to `off`, set
  `CANONICAL_KNOWLEDGE_KILL_SWITCH=true`, or use governor rollback images.
- Knowledge Base promotion parity was accepted at Core
  `7dcc5f15687a8088fb44d6938d5d4b1a9305a85f`: standard, enterprise,
  connector, and evidence-upgrade promotion boundaries now await the same
  feature-flagged canonical projector. A production Cloudflare Workflow upload
  produced `Professor Uwe Egly (person) -> teaches -> Neuro-Symbolic AI course
  (technology)` with exact document/segment evidence and typed endpoint roles.

## feature-20260830T205222Z — Durable Cloudflare ingestion enabled globally

- Flagship `knowledge_ingest_workflow_v1` in app
  `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8` now serves variation `on` by default.
  Existing exact canary rules remain for audit continuity, but every valid
  production organization/user context now selects the durable Cloudflare
  Workflow, Queue, DLQ, and R2 ingestion lifecycle.
- The production backend master gate remains
  `KNOWLEDGE_INGEST_WORKFLOW_ENABLED=true`; setting it to `false` or changing
  the Flagship default to `off` immediately returns new admissions to the
  stable BullMQ path without deleting in-flight Workflow state.
- Runtime verification used an unrelated valid UUID organization/user pair:
  Wrangler returned `on/DEFAULT`, and the authenticated live production Worker
  `/enabled` endpoint returned HTTP 200 with `enabled=true`.
- Embeddings were already configured correctly and were not redeployed:
  Cloudflare Workers AI `@cf/baai/bge-m3` through AI Gateway `hivemind-prod` is
  primary; OpenRouter `baai/bge-m3` is the same-model secondary. A fresh live
  factory probe reported `cloudflare -> openrouter` and returned a finite
  1024-dimensional vector with neither provider cooling down.
- No Worker, container, database, frontend, local deployment setting, Queue,
  Workflow, R2 bucket, or secret was replaced by this rollout.

## feature-20260830T214700Z — Parallel recall reliability production canary

- Canonical Core SHA `319620270b84392d13d3a2c8970c10cb299372ea` adds
  independently recoverable memory lexical/vector and evidence lexical/vector
  lanes to both public recall and chat.
- Flagship `recall_parallel_reliability_v1` defaults `off`. It serves `on` only
  for production org `bfbdd2bc-e214-44e5-80d4-e3284256d0c0` plus user
  `e35811aa-4bcd-44bb-b829-a437895a42eb`; all other users retain the stable
  prior behavior. The Core environment master gate is enabled and fail-closed.
- Healthy lanes remain usable when another lane fails. Only failure of all four
  retrieval lanes produces retryable HTTP 503, explicitly without claiming the
  requested knowledge is absent. Strict temporal inventory failures also remain
  fail-closed.
- `latest` and `earliest` final top-K are ordered from the fully filtered mixed
  memory/evidence pool using the requested known-time or event-time axis, with
  stable deterministic tie-breaking. Timeline delivery remains chronological.
- Same-user rollback proof changed only the canary rule `on -> off -> on`:
  all three runs returned the same ordered IDs, timestamps, and two evidence
  rows; off reported `legacy`, while on reported all four lanes `complete`.
- Live chat returned two memories plus one evidence row, three citations, and a
  grounded answer after the internal-tool allowlist regression was fixed.
- Cloudflare Worker version `d99c1304-61ff-40c8-a4b5-b0b5c148ce80`; Core image
  `hivemind/core-api:sha-31962027`, digest
  `sha256:715f48540ef97dc7d51263e22c34476f35fe68542cac964c02e3afd507f36ad4`.
- Rollback: serve `off` for the exact canary (fastest), set the Core master gate
  false, roll the Worker back to version
  `c8461f69-d815-4ea5-bba3-82fc644a3f3c`, or release exact prior Core SHA
  `7dcc5f15687a8088fb44d6938d5d4b1a9305a85f` through the canonical runner.

## feature-20260830T230000Z — Durable Chat Agent local acceptance

- Local-only branch `codex/durable-chat-agent-v1`, pushed implementation
  `7347cfc3f502fc564b75ae6efee5a6086cf6cc0f`, adds the multivariate
  `durable_chat_agent_v1` envelope around the unchanged Native Chat V2.
  Production remains disabled at both Flagship and environment gates.
- PostgreSQL is authoritative for turn admission, request scope, ordered events,
  checkpoints, final responses, errors, replay, and tenant authorization.
  Cloudflare Agent version `24cab74d-0e4a-466e-8a12-0b8b0a99aca3` stores only
  opaque lifecycle metadata; its contract rejects message, prompt, answer,
  memory, evidence, citation, tool payload, source, and artifact fields.
- Modes are `off`, `shadow`, `session`, `workflow`, and `full`. Evaluation is
  latched once per turn and fails closed to the byte-compatible V2 path.
- Durable modes add one bounded recovery for a zero-result entity-attribute
  rewrite, and graph-first/source-second recovery for an explicit relationship
  claim. Existing synthesis still requires source grounding and forbids deriving
  relationships from co-mention.
- Local E2E proved fact, ownership, temporal, source, detailed overview,
  exhaustive synthesis, relationship, idempotent replay, cursor resume,
  unauthenticated denial, and metadata-only edge mirroring. Standard uses top 5;
  detailed/comprehensive retain the existing unified top 15 contract.
- Rollback is immediate: set `DURABLE_CHAT_AGENT_ENABLED=false` or serve `off`.
  No production Worker, container, database, frontend, or flag was changed.

### Durable continuation and Workflow completion

- Implemented in local feature commit `2d4619d4` on
  `codex/durable-chat-agent-v1`; production was not changed.
- PostgreSQL now owns lease-fenced compound-turn continuations. Only token
  digests are persisted; invalid input is retryable, successful tokens are
  consumed exactly once, and duplicate idempotency keys replay the stored final
  response.
- `workflow` and `full` start a deterministic Cloudflare Workflow per turn and
  wait durably for opaque terminal metadata. The live local success and failure
  canaries both completed, and Workflow output contained no customer content.
- Local Worker version `308c14b7-ca86-4539-8abd-15831474515a`; Workflow resource
  `hivemind-chat-turn-workflow-local`. Production remains disabled and was not
  deployed or modified.

### Exact production canary

- Accepted on canonical SHA `a73cdbc82dc5ea637244d38bda7fb8ea7a96a0f3`.
  Production Worker version `c413ed26-533f-4198-8d6f-be03841e1ae3` and Workflow
  `hivemind-chat-turn-workflow-production` are live. Flagship remains default
  `off`; only the existing production operator identity is targeted `full`.
- Stable non-canary V2, durable completion, exactly-once replay, grounded recall,
  metadata-only edge state, public health, and clean logs were verified. This is
  a canary release, not a global enablement.

## feature-20260831T182301Z — Existing HyperRoom fast planner canary

- Canonical production SHA `e2e2c055e56ed7d8a18bb7a0b099503f987b9f6a`
  adds a fail-closed, turn-latched mode to the existing HyperRoom runtime.
- Flagship `hyperagents_fast_planner_v1` remains `off` by default. Only org
  `f0cb77ef-e62b-4f8c-a1da-066611fc3b36` and user
  `b457c254-38a0-4c43-8280-b026f1a78b04` receive `glm_no_reasoning`.
- Enabled profile selection, Director planning, and verification use
  `@cf/zai-org/glm-5.3-flash` through Cloudflare AI Gateway with thinking
  disabled. Plain copy does not require the visual renderer, current-evidence
  queries survive planning, and journal persistence adds no summarizer call.
- Non-target users retain the previous production behavior. This feature does
  not deploy or enable the Grok-style HyperAgents runtime.
- Rollback is immediate by serving `off` to the exact canary; the additive
  database latch can remain in place.

### feature-20260831T192956Z — Gemini Unified Billing transport

- The same exact production canary now uses
  `google/gemini-2.5-flash-lite` for profile selection, planning, and
  verification.
- Transport is Cloudflare AI Gateway Unified Billing, funded by the Cloudflare
  credit balance. It deliberately omits the exhausted OpenRouter BYOK alias.
- Flag targeting, stable non-canary behavior, and Grok-runtime status are
  unchanged.

## feature-20260831T191032Z — Durable knowledge ingestion v2

- Accepted production implementation: canonical SHA
  `f4107cc82490a1ddf57a7b215955be6184d4038b`; Core digest
  `sha256:77083aab6997bfbda1a9ddbf2d0294396197528ccd399c90b4ccbcef7713c217`;
  Cloudflare Worker version `d8547ac3-6609-4b47-bf87-32cd9d9c185a`.
- Adds one-time admission latching, fail-closed Workflow selection, a fenced
  processing lease, independently retryable evidence and memory checkpoints,
  parser-error contamination rejection, and direct Cloudflare Gemini vision.
  Stable BullMQ remains selected while the production flag is off.
- A disposable valid PDF completed the seven-step Workflow; every durable
  receipt succeeded exactly once, the lease cleared, hybrid recall cited the
  exact document, and identical replay was rejected without reparsing. All
  disposable document and R2 data were removed afterward.
- Two earlier canaries were rejected and rolled back: one caught a PostgreSQL
  schema qualification error; the next caught an invalid zero-yield reconcile
  reason. Both fixes are in the accepted revision and retained in the journal.
- Rollout state: `knowledge_ingest_workflow_v1` remains globally **off** in
  production after acceptance. The capability is dormant for normal production
  uploads until a separately governed flag promotion; local-only targeting is
  preserved.
- Rollback: keep Flagship off; Worker
  `d917d0a1-38fe-4933-a4eb-34bcb891c625`; Core
  `e2e2c055e56ed7d8a18bb7a0b099503f987b9f6a`; exact backups and manifest are
  recorded in `docs/PRODUCTION_RELEASE.md`.

### Global production rollout

- Globally enabled at `2026-08-31T19:19:01.181Z`. Default and every production
  targeting rule serve `on`; local targeting remains on. Bound Worker and
  direct Flagship evaluations proved prior targets plus unrelated users are
  enabled. No runtime service was rebuilt or restarted.
- Immediate rollback restores default and production priorities 2/3 to `off`
  using the captured full flag definition; the local rule remains `on`.

## feature-20260831T194741Z — HyperAgent GPT-OSS 20B provider routing

- Production HyperAgent fast-tier calls normalize to
  `openai/gpt-oss-20b:nitro` and travel through Cloudflare AI Gateway to
  OpenRouter.
- Provider priority is Amazon Bedrock, Amazon Bedrock EU, Groq, then Together,
  with OpenRouter fallback enabled.
- Verified live on canonical SHA
  `97afbd87760771789b5a8adab651027dd18d51a1`; Amazon Bedrock served both the
  direct Gateway canary and deployed HyperAgent transport canary.
- This is shared provider policy, not a Grok-runtime enablement. The existing
  Gemini planner canary remains unchanged.

## feature-20260831T203008Z - durable ingestion throughput global release

- Canonical `e9fca76f6e8d66398d195f87d431645a56b1b058` runs Core throughput
  controls, the structured frontend error contract, and Cloudflare knowledge
  Worker `10f80a27-2f76-4a63-b565-ecd07c295590`.
- Admission is globally enabled. Processing allows four global slots but no
  more than two active jobs per organization; durable receipts, version fences,
  exactly-once billing, R2 retention/replay, and the backend kill switch remain.
- Four concurrent synthetic PDFs and a post-global PDF smoke passed ready,
  vector, billing, recall, and self-cleanup checks. Production vision is Gemini
  2.5 Flash Lite through Cloudflare AI Gateway `hivemind-prod`; provider errors
  cannot become stored evidence.
- The two poisoned Lecture incident jobs are repaired without reparse or
  duplication. Their stable evidence documents contain 155 and 108 fully
  embedded segments, respectively; both jobs and billing ledgers are terminal.
- Flag rollback restores default and production priorities 2/3 to `off` while
  preserving local-on behavior and the full flag definition. Runtime rollback
  versions are listed in `docs/PRODUCTION_RELEASE.md`.
# Production feature — staged durable canonical ingestion (2026-08-31)

- Flag: `knowledge_ingest_workflow_v1` — enabled globally in production.
- Release: `22f549a3c300cf46c3bcb0ed412ff85cadd61e4e`.
- Admission uses Cloudflare Queue/Workflow/R2. Core independently bounds
  extraction, evidence embedding, memory generation, and projection/reconcile,
  allowing the next document to extract as soon as the prior parser releases
  its slot.
- Public upload/status contracts are unchanged; BullMQ remains the flag-off
  rollback path but is not selected while the global flag and Core gate are on.
- Cloudflare BGE-M3 remains the primary embedding route with the configured
  secondary fallback. Image uploads use the same durable admission and
  canonical single-memory materializer.

## feature-20260831T225017Z — immediate durable ingestion dispatch

- Flag remains `knowledge_ingest_workflow_v1`, enabled globally. Public
  upload/status payloads and the existing flag-off rollback path are unchanged.
- Core release `da923a8c9bae63b72d7d5fc70b707c91c011f548`
  uses durable FIFO stage checkpoints and immediate capacity release events;
  there is no timer-based stage-slot polling.
- Extraction, embedding, promotion, and projection have independent bounded
  pools. PDF rendering is bounded at two concurrent processes by default;
  healthy text layers bypass rendering and only visual pages use Gemini 2.5
  Flash Lite through Cloudflare AI Gateway.
- Production canary `42fea1d8-c269-41d1-8bd9-36dcfaf4bc71` completed every
  checkpoint once, with extract→embed and embed→promote handoffs measured in
  single-digit milliseconds.
## feature-20260901T082450Z — Runtime and Social globally available

- Runtime and Run your Social Media are available to every authenticated
  production workspace; there is no frontend early-access or coming-soon gate.
- Runtime opens `/hivemind/app/employees/runtime`. Social opens
  `/hivemind/app/employees/campaigns` and uses the already-enabled governed
  organic campaign runtime.
- Released as Da-vinci `b231ec8350e97edba162358f2c7d5c273124a672`, parent
  `2ea1d984a45d03d2c2a58cdcf741e0ed4c3674cf`, and Cloudflare Worker
  `d5c1c0f8-034b-4966-a9a1-35aadc9f2300`.
