# Singulance Feature Registry

This append-only registry is the global record of features accepted on
`singulance-main`. Add an entry only after the governed production release and
runtime verification have completed. Use the same feature identifier in
Cloudflare Agent Memory and in the `singulance-local` registry.

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
