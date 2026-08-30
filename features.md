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
