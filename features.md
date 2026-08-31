# Singulance Feature Registry

This append-only registry records features accepted on the canonical local and
production branches. A local entry requires focused tests plus a healthy local
container. A production entry requires the governed release path, runtime
verification, and its independent rollback control.

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
- Local safety: local preview-mail gateway and local-only Compose settings are
  preserved; the Day 1 overlay never imports a production database or service
  credential.
- Local verification: 30 focused email, notification, Humation, and Day 1 unit
  tests passed; `hivemind-control-plane-local` rebuilt from this branch and
  reached healthy.
- Rollout evidence: all three eligible organizations started through the same
  authenticated deterministic lifecycle endpoint; all three Workflow instances
  completed. PostgreSQL recorded three linked, uniquely deduplicated
  `lifecycle.email.sent` platform notifications and zero duplicate dedupe keys.
- Rollback: disable the Flagship flag for immediate evaluation rollback, or set
  `HIVEMIND_D1_WORKFLOW_ENABLED=false` as the backend master kill switch. The
  reconciliation scheduler remains throttled to five organizations per cron run.

## feature-20260830T001000Z — Public AI discovery policy

- Local status: integrated and verified in the permanent `singulance-local`
  worktree; production remains unchanged pending governed promotion.
- Capability: public marketing hosts expose `robots.txt`, `llms.txt`,
  `llms-full.txt`, and sitemap policy for search, retrieval, citation, and AI
  user visits. Training/fine-tuning is disallowed; authenticated, preview, and
  administrative hosts do not expose discovery assets and are `noindex`.
- Source: frontend commit `880962c7215732d004c6abb21b9fcc81bdd48ed0`, integrated
  through local session `ef793da9376dffa7e03ec4b683762bdd65859fe7`.
- Local verification: `npm run test:ai-discovery` passed 3/3 against the merged
  checkout. The full production build previously passed on the identical
  immutable frontend SHA; no shared Docker container was changed for this
  edge-worker/static-asset-only feature.
- Release rule: deploy only from a clean, current `singulance-main` promotion;
  verify public crawler access and private-host `noindex` behavior before
  enabling any narrow crawler guard.

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
- Integration receipt: feature commit `58ec7ff8` and merged-state candidate
  `42d2bcc0` are pushed on `codex/knowledge-ingest-workflow-v1`; merged checks
  passed 138/138 backend tests, 3/3 frontend discovery tests, the optimized
  frontend build, Prisma validation, and local control-plane health. This entry
  remains local-only and does not authorize a production rollout.
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

## feature-20260831T020000Z — Complete durable Grok-style HyperAgents (local candidate)

- Cumulative Flagship flag `hyperagents_grok_agents_v1` remains fail-closed and
  unenabled. Its stages are `off`, `shadow_roster`, `persistent_agents`,
  `durable_assignments`, `real_tools`, `collaboration`, `browser`, `skills`,
  `routines`, and `full`; the decision is latched per turn.
- Persistent organization-scoped Agent identities, roster-first selection,
  deterministic Room and WorkOrder Workflows, PostgreSQL leases/receipts,
  duplicate-safe recovery, capability-gap events, real participant execution,
  collaboration, versioned skills, and Agent-owned routines are implemented.
- Pause, resume, cancel, and steering persist on the HyperTurn and are honored
  by Employees. Cloudflare Browser Run is exposed as a structured Agent tool;
  Sandbox execution is argv-only, allowlisted, isolated, and authority-gated.
- Integrated Da-vinci candidate `f47d945` adds active-agent/runtime visibility
  and live turn controls.
- Verified with Prisma validation/generation, Core runtime/HyperRoom tests,
  changed-file Python compilation, Worker TypeScript and contract tests,
  Wrangler local dry-run including Browser/Sandbox, Sandbox image build, and an
  optimized Da-vinci build. No Cloudflare resource or production service was
  deployed or enabled.

## Local — Grok-style HyperAgents runtime (2026-08-31)

- Status: accepted locally; production untouched.
- Backend commit: `e4c1983f4cc8cdf6eeb47b3be0eab38b6180f626` on `singulance-local`.
- Flag: `hyperagents_grok_agents_v1` defaults to `off` and resolves to `full`
  for every user only when `environment=local`. Non-local evaluations remain
  `off`, so this rule cannot enable the runtime in production.
- Cloudflare local resources: `hivemind-hyperagents-grok-local`,
  `hivemind-hyper-room-run-local`,
  `hivemind-hyper-agent-assignment-local`, and
  `hivemind-hyperagents-grok-local-sandbox-local`.
- Accepted behavior: roster-first selection, persistent agent identities, durable
  Room and assignment Workflows, PostgreSQL WorkOrder/Result authority, bounded
  real-tool AgentScope execution through the production-equivalent Cloudflare AI
  Gateway path, reviewer participation, workflow retry/recovery, and Cloudflare
  Browser execution with isolated receipts.
- Final canary: turn `4bc77624-17da-444b-9619-a6cd2fb467b1` reached `complete`
  and `SEALED`; both durable assignments completed and the Room Workflow reused
  terminal state after a transient execute timeout without duplicate work.
- Verification: Worker 5/5; Employees focused suite 39/39; API, Control and
  Employees health HTTP 200; authenticated recall returned one memory and two
  evidence results; direct Cloudflare Browser canary returned Example Domain.
- Rollback: remove the local targeting rule or set the flag to `off`. Flag-off
  turns remain on the existing runtime. No production targeting was added.

### Local rollout update — 2026-08-31

- The canary-specific rule was promoted to `environment equals "local"` after
  the accepted full-mode canary. Evaluation with arbitrary local org/user values
  returned `full` via `TARGETING_MATCH`; the same arbitrary identity with
  `environment=production` returned the default `off`.
- Local artifact-only profiles are enabled through
  `VISUAL_PATH_IN_HYPERROOMS=true` as of commit `83f57630`. Branding, marketing,
  fundraising, and product tasks can therefore enter the governed renderer
  instead of terminating before agent execution.
