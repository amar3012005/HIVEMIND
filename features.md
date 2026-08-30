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
