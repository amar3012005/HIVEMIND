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

## feature-20260830T150000Z — Durable Dreaming and Subject Profiles v2

- Local status: integrated into `singulance-local` at `2b2510a3`; shared backend
  runtime acceptance remains pending because the parallel ingestion session owns
  the current `knowledge-workflow-local` API container.
- Gate: `DREAM_WORKFLOW_V2_ENABLED` plus fail-closed `dream_workflow_v2`.
- Cloudflare: isolated Workflow, Queue/DLQ, Cron, R2, Flagship, and existing AI Gateway.
- Data: additive checkpoints, candidates, typed derivation receipts, and immutable generic subject-profile revisions.
- Compatibility: existing cognition/profile payloads are unchanged; v2 fields and routes are additive.
- Promotion: shared-runtime local acceptance is required before production governance.

## feature-20260830T081500Z — Heavy-document ingestion replay hardening

- Local status: accepted on `codex/knowledge-ingest-workflow-v1`; production and
  `singulance-main` remain unchanged.
- Source commit: `1ae13c022db72927aebef43ecdaa6230c5fd24a7`.
- Capability: forced reprocessing keeps the existing document projection live
  until its replacement memories, citations, entities, and claims are durable;
  it then retires only memories without support from another document and
  removes obsolete semantic vectors and citation links.
- Admission durability: identifier-stable R2 writes retry bounded transient
  failures with a configurable five-minute attempt window. Platform timeout
  codes are normalized before durable job failure recording.
- Production parity: local inference used the production Cloudflare AI Gateway,
  LLM policy, embedding model and 1024-dimensional embedding contract. Database,
  Redis, Qdrant, auth, Workflow, Queue, R2, and Flagship resources stayed local.
- Runtime acceptance: eight OCR PDFs were admitted together through
  `knowledge_ingest_workflow_v1`. All eight reached `ready`: 691 pages, 1,722
  segments, 1,722/1,722 evidence vectors, 113 memories, and 113 live citation
  projections. Every current processing version has ten successful checkpoint
  receipts and each job retains exactly three idempotent usage settlements.
- Isolation and recall: a foreign-organization status request returned 404.
  Filename recall returned eight persisted-hybrid results, one exact filename
  match, and citations on all eight returned memories.
- Tests: all 105 `core/tests/knowledge/*.test.js` tests passed; syntax,
  PowerShell parsing, Compose validation, and `git diff --check` passed. The
  repository-wide Node test command remains red on its documented unrelated
  Windows/Vitest/AMR/retired-module baseline.
- Rollback: disable `knowledge_ingest_workflow_v1` or set
  `KNOWLEDGE_INGEST_WORKFLOW_ENABLED=false`; new admissions return to BullMQ.
## feature-20260830T025500Z — Dreaming provider-outage recovery guard

- Local status: committed as `276d2203` and integrated into the permanent
  `singulance-local` worktree by merge `76a134fe`; production remains unchanged.
- Behavior: if every eligible subject fails during candidate generation, the
  stage raises retryable `candidate_generation_provider_unavailable`. The run
  cannot reconcile, publish, notify, or finalize as a successful zero-candidate
  dream during a total AI-provider outage.
- Verification: the focused lifecycle suite passed 6/6. Local recovery run
  `39b8eb5f-fef0-42b7-86b6-9c45ce012b65` remained checkpointed at
  `generate-candidates` with attempt 2 while its isolated Cloudflare Workflow
  continued bounded retries.
- Remaining gate: rotate the expired production-parity LiteLLM/OpenRouter
  credentials, rebuild an immutable local API image, then finish successful
  grounding, derivation, profile, vector, notification, UI, restart, and DLQ
  acceptance before any governed production promotion.

## feature-20260830T033000Z — Dreaming terminal failure receipts

- Local status: patch `e924850a`, merged to `singulance-local` at `f582bb5d`;
  isolated Worker version `b6c01ba1-0420-44e4-b36d-26b04cb416e5`.
- Behavior: exhausted Cloudflare stage retries durably close the authoritative
  PostgreSQL run as recoverable error. A provider outage cannot leave an active
  run stuck indefinitely or publish partial cognition.
- Runtime proof: run `39b8eb5f-fef0-42b7-86b6-9c45ce012b65` is terminal error
  with `recovery_status=retry_exhausted`; lifecycle tests passed 7/7 and Worker
  TypeScript validation passed. Production was not modified.

## feature-20260830T042000Z — Immutable terminal Dreaming state

- Local status: patch `718b0117`, merged to `singulance-local` at `c314c713`;
  isolated Worker version `7c21bf84-11b3-4b66-8126-6e679da944a1`.
- Behavior: delayed Cloudflare retries cannot convert failed or cancelled runs
  into completed runs, including through finalize. Tests passed 8/8 and the
  local provider-outage canary remains terminal error with zero publication.

## feature-20260830T091800Z — Deterministic immutable local API build

- Local status: patch `5bab2ada`, merged at `963dd056`; production unchanged.
- Build: optional Lightpanda/Puppeteer binary downloads no longer block the API
  image, while package lifecycle scripts and Prisma generation remain enabled.
- Runtime proof: immutable image
  `sha256:cf62435628596297a247387c7dd2ccca46323e215ae49056690fcd70f5918d22`
  runs healthy from `HIVEMIND-local-main` and contains the merged ingestion and
  Dreaming terminal-state code.

## feature-20260830T090000Z — Meta-aware PDF quality and preview-read recovery

- Local status: accepted on `codex/knowledge-ingest-workflow-v1`; production and
  `singulance-main` remain unchanged. The frontend companion commit is
  `bab779a` on `codex/preview-health-poll-cleanup`.
- PDF quality: a deterministic text-layer gate measures short-token,
  single-token, and average-token-length corruption. Text-rich but fragmented
  OCR now routes to vision OCR instead of being treated as clean fast-PDF text.
- Chunking: clean fast-PDF pages split at paragraph, sentence, newline, or word
  boundaries with bounded overlap; document title, heading path, and page remain
  contextual embedding and citation metadata, never synthetic evidence text.
- AI parity: vision OCR now supports the production Cloudflare AI Gateway BYOK
  transport without direct provider keys. A real rendered page returned 906
  characters of Markdown through the Gateway. The local image declares Poppler,
  ImageMagick, and Ghostscript, matching the production renderer contract.
- Canonical memory quality: the extraction prompt now unambiguously separates
  standalone claim `f` from verbatim `source_quote`; the atomicity guard reads
  the canonical `f` field and splits only claims containing at least three
  independent sentences. Entity context, exact quote validation, typed claim
  structure, Updates/Extends/Derives graph semantics, citations, and tenant
  scoping remain intact.
- Eight-file evidence: all supplied OCR PDFs were classified concurrently; all
  eight correctly failed the clean-text gate (61-90 pages, 74-86% single-letter
  tokens in their raw text layers). Existing durable data remains unchanged.
  Recall canaries found the expected fact in seven of eight query sets; the one
  miss and off-target top ranks are attributable to the already-ingested damaged
  OCR and are the reason future/reprocessed versions use the new OCR route.
- Preview recovery: the control plane and Core now share a generated local-only
  non-placeholder internal key, so documents, billing usage, and health proxy
  checks return 200. The redundant top-bar 30-second health poll and status pill
  were removed; required Memories/Knowledge and billing reads remain.
- Verification: 116/116 focused backend tests, 18/18 quality/context tests,
  Memories scope 4/4, frontend optimized build, real AI Gateway page canary,
  and local proxy read canaries passed. Local Core source is read-only mounted so
  JS-only changes require restart rather than image rebuild; manifest/native/
  Prisma changes still require a build.

## feature-20260830T120000Z — Production-gated durable ingestion and preview email login

- Local status: tested on `codex/knowledge-ingest-workflow-v1`; production and
  `singulance-main` remain unchanged until a separately governed canary release.
- Authentication: `next.preview.singulancelabs.com` uses the existing approved
  one-time-email link flow. Google is not rendered or invoked in preview. The
  production login path is not changed by this local-only UI branch.
- Production safety gate: the hosted ingestion client activates in production
  only when `KNOWLEDGE_INGEST_WORKFLOW_ENABLED=true`,
  `KNOWLEDGE_INGEST_WORKFLOW_ENVIRONMENT=production`, `NODE_ENV=production`,
  local mode is false, and
  `KNOWLEDGE_INGEST_PRODUCTION_ACK=enable-cloudflare-workflow-v1`. Flagship must
  independently enable `knowledge_ingest_workflow_v1` for the tenant; failures
  remain fail-closed.
- Production resource contract: Worker
  `hivemind-knowledge-ingest-production`, Workflow
  `hivemind-knowledge-ingest-workflow-production`, Queue/DLQ
  `hivemind-knowledge-ingest[-dlq]-production`, and R2
  `hivemind-ingest-artifacts-production`. These names are isolated from local
  resources and are declared but not provisioned or deployed by this entry.
- Verification: focused ingestion suite `120/120`; frontend preview-login
  contract `2/2`; Worker types/check and production Wrangler dry-run passed.
  The dry run used the production API hostname and production bindings without
  creating resources or changing traffic.
- Rollback: disable the tenant Flagship decision or set
  `KNOWLEDGE_INGEST_WORKFLOW_ENABLED=false`; new admissions remain on BullMQ.

## feature-20260831T013000Z — Grok-style persistent HyperAgent runtime foundation

- Session status: implemented and verified on `codex/grok-hyperagents-v1` at
  pushed commit `e4cee2b4`; not yet merged into `singulance-local`, enabled in
  Flagship, deployed, or released to production.
- Flag: cumulative multivariate `hyperagents_grok_agents_v1`, fail-closed to
  `off`, with the admission decision latched immutably on each HyperTurn.
- Runtime: roster-first capability manifests, stable organization-scoped
  Cloudflare Agent identities, deterministic Room Workflows, PostgreSQL turn
  and WorkOrder leases, and fail-closed real participant execution in
  `real_tools+`. Shadow mode remains diagnostic-only.
- Recovery: Workflow messages contain identifiers only; duplicate starts reuse
  `room-{turn_id}-v{processing_version}` and WorkOrders retain their existing
  `(turn_id, order_key)` idempotency boundary.
- Verification: Prisma schema validation/generation, 15 Employees tests under
  Python 3.12, 25 affected Core route/recovery tests, 2 Core runtime tests,
  Worker typecheck, 4 Worker contract tests, and a Wrangler local dry run all
  passed. Shared local containers and production were not changed.
