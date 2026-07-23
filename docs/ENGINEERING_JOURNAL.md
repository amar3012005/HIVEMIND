# HIVEMIND Engineering Journal

This is the human-readable index of committed work and accepted production
releases. Git is the source of truth; every entry must cite immutable commit
SHAs, release IDs, and verification evidence. Do not record plans, guesses,
or uncommitted changes as completed work.

## Required Session Protocol

1. At session start, read the latest entries, `git log origin/hivemind-main`,
   `docs/PRODUCTION_RELEASE.md`, and `docs/PRODUCTION_RELEASE_PROTOCOL.md`.
2. Before coding, add a `Started` entry with the branch, owner, scope, and
   base SHA. Do not claim an outcome yet.
3. After a pushed code commit, append a `Committed` entry that links only the
   pushed SHA and affected files/services.
4. After production acceptance, append an `Accepted release` entry with the
   immutable release ID, running image digests, verification evidence, and
   rollback tag. Update `PRODUCTION_RELEASE.md` in the same commit.
5. If a release fails or is rolled back, append the failure and rollback
   reference. Never edit, delete, or rewrite older entries.

## Entry Template

```md
## YYYY-MM-DD UTC - Short outcome

- State: Started | Committed | Accepted release | Rolled back | Blocked
- Owner: Claude | Codex | Human
- Branch: `branch-name`
- Base / commit: `base-sha` -> `pushed-sha`
- Scope: files and production services changed
- Verification: exact command, test, curl, or `not run`
- Production: release ID, image digest, and runtime tag; `not deployed` if absent
- Rollback: immutable tag or `not applicable`
- Next: one concrete next action
```

## Current Git Baseline

## 2026-07-23 UTC - Claude instruction system refresh

- State: Started
- Owner: Codex
- Branch: `codex/claude-instructions-v2`
- Base / commit: `b457c4f2a32b921924ed7e4f3eefc14fcce95946` -> `pending`
- Scope: `.claude` instruction entrypoints, decision records, HyperAgents
  context, executable workflows, and release/branch guidance.
- Verification: JSON, shell, relative-link, secret, stale-reference, graph, and
  diff checks; no product runtime or production mutation.
- Production: not deployed
- Rollback: not applicable
- Next: finish rebase, validate the combined current HyperAgents context, then
  push the task branch for review.

## 2026-07-23 UTC - Claude instruction system refresh committed

- State: Committed
- Owner: Codex
- Branch: `codex/claude-instructions-v2`
- Base / commit: `b457c4f2a32b921924ed7e4f3eefc14fcce95946` ->
  `2fda7d9fe8298d836fc95e23e03abfe639c37680`
- Scope: replaced legacy auto-loaded Claude instructions and mutating host
  helpers; added current decision records; preserved and reconciled the newer
  HyperAgents closed-loop program; fixed branch/release authority links.
- Verification: `jq` validation, shell syntax, 74-file relative-link audit,
  secret-pattern scan, code-review-graph change audit, and `git diff --check`
  passed. No product code or frontend gitlink changed.
- Production: not deployed
- Rollback: revert `2fda7d9fe8298d836fc95e23e03abfe639c37680`
- Next: review and merge the branch into `singulance-main`; no service rebuild
  is required because this is agent/documentation configuration only.

## 2026-07-19 UTC - SINGULANCE deployment governor started

- State: Started
- Owner: Codex
- Branch: `codex/singulance-01`
- Base / commit: `3cca4b6b24ede1647a69a133c17a248a88000f0d` -> `pending`
- Scope: repository deployment governance, deprecated legacy operator, and
  cache-preserving `scripts/quick-deploy.sh`; no application service change.
- Verification: shell syntax, diff check, and static policy checks pending.
- Production: not deployed
- Rollback: not applicable
- Next: verify, commit, push the session branch, then integrate separately.

## 2026-07-19 UTC - SINGULANCE deployment governor committed

- State: Committed
- Owner: Codex
- Branch: `codex/singulance-01`
- Base / commit: `3cca4b6b24ede1647a69a133c17a248a88000f0d` -> `484b9dcb`
- Scope: `DEPLOY_GOVERNOR.md`, governing agent instructions, and
  `scripts/quick-deploy.sh`; cache-preserving service selection, exclusive
  deployment lock, and fetched-commit image-label verification.
- Verification: `bash -n scripts/quick-deploy.sh`, `git diff --check`, and
  production host availability check for `/usr/bin/flock` passed.
- Production: not deployed
- Rollback: not applicable
- Next: integrate a focused frontend release and deploy through the governed
  quick-deploy path.

## 2026-07-19 UTC - Cache-preserving frontend release accepted

- State: Accepted release
- Owner: Codex
- Branch: `singulance-main`
- Base / commit: `3cca4b6b24ede1647a69a133c17a248a88000f0d` -> `0705d294`
- Scope: removed two verified-unused landing videos and deployed the governed
  frontend image; Core, Control, Employees, and TARA were unchanged.
- Verification: Docker dependency install was cached; the image label matched
  `0705d2947adcbec5e29be75811a46dc2a0cec0ba`; both removed files were absent
  from `/srv`; `/hivemind` and `/hivemind/m/chat` returned `200`; no fresh
  frontend fatal/error log lines were found.
- Production: `0705d294`, `hivemind/fe:latest-single`; `/srv` reduced to
  `73.6M` from `100.7M`.
- Rollback: `hivemind/fe:stable-single` via
  `/root/quick-deploy.sh --rollback fe`.
- Next: replace CRA with Vite or move frontend compilation to CI/image
  publishing; the current full CRA compilation took about 93 seconds.

## 2026-07-16 UTC - Contextual durable-memory ingestion

- State: Started
- Owner: Codex
- Branch: `codex/contextual-durable-ingestion`
- Base / commit: `3bf522e63ac7f76703c8252770c2a1211ae750d5` -> `pending`
- Scope: `core/src/knowledge/document-first-ingestion.js` and its focused
  promotion contract test; no frontend or production service change.
- Verification: `node --check core/src/knowledge/document-first-ingestion.js`
  and `git diff --check`; focused test awaits the production-image release gate
  because this clean worktree has no installed dependencies.
- Production: not deployed
- Rollback: not applicable
- Next: commit, push, review, then release from the post-merge `hivemind-main` SHA.

## 2026-07-16 UTC - Contextual durable-memory ingestion committed

- State: Committed
- Owner: Codex
- Branch: `codex/contextual-durable-ingestion`
- Base / commit: `3bf522e63ac7f76703c8252770c2a1211ae750d5` -> `62f697e0b86e4c8fa3062acf41070a61f29615d1`
- Scope: document-level curated memory cap, contextual extraction and curation
  contracts, OpenRouter-aware metered curator routing, and source-provenance test.
- Verification: `node --check core/src/knowledge/document-first-ingestion.js`
  and `git diff --check` passed; focused test is deferred to the production
  image because this isolated worktree has no dependency installation.
- Production: not deployed
- Rollback: not applicable
- Next: push the branch, obtain review, merge, and run production-image plus
  authenticated upload/recall acceptance from the merged SHA.

## 2026-07-16 UTC - Canonical maps and Elements baseline

- State: Committed
- Owner: prior release session
- Branch: `hivemind-main`
- Base / commit: `19fa016d` -> `3a500111c3ae8fbe62aef12604cf95bdb629af51`
- Scope: Google Maps connector catalog, HyperAgents Elements frontend, and
  release-ledger documentation.
- Verification: Git remote history only; this entry does not claim live
  runtime acceptance.
- Production: consult `docs/PRODUCTION_RELEASE.md` and the running image tags.
- Rollback: not applicable
- Next: reconcile any new feature branch into `hivemind-main` before release.
## 2026-07-19 UTC - Deterministic chat orchestration hardening

- State: Started
- Owner: Codex
- Branch: `codex/chat-orchestration`
- Base / commit: `3cca4b6b24ede1647a69a133c17a248a88000f0d` -> `pending`
- Scope: shared Core `/api/chat` orchestration, intent and scope planning,
  event-driven recall/tool hops, connector authorization, and focused regression
  coverage; no frontend or production service change yet.
- Verification: not run
- Production: not deployed
- Rollback: not applicable
- Next: map the current V2 path and convert the reported failures into focused
  deterministic tests before implementation.

## 2026-07-19 UTC - Deterministic chat orchestration verification

- State: Verified on session branch; not release-accepted
- Owner: Codex
- Branch: `codex/chat-orchestration`
- Base / commit: `3cca4b6b24ede1647a69a133c17a248a88000f0d` -> `pending`
- Scope: deterministic language/history-aware intent overlay; bounded event
  lifecycle; exact-source and complete-aggregate retrieval; project, memory-ID,
  connector, and approval scoping; versioned memory updates.
- Verification: `node --check` for all changed JavaScript; `git diff --check`;
  105 focused and adjacent Node tests passed.
- Production: not deployed; not accepted. Canonical route convergence, pre-route
  scope admission, and legacy fallback removal remain release gates.
- Rollback: revert the eventual session-branch commit before integration.
- Next: rebase on `origin/singulance-main`, rerun the focused suite, publish the
  session branch, and open the remaining route gates as explicit follow-up work.

## 2026-07-19 UTC - Structured LLM chat router and unified toolkits

- State: Started
- Owner: Codex
- Branch: `codex/chat-orchestration`
- Base / commit: `3cca4b6b24ede1647a69a133c17a248a88000f0d` -> `pending`
- Scope: replace reachable English phrase routing in Core `/api/chat` with one
  required structured fast-model decision; select lazy AgentScope-style native
  and connector toolkit groups; fail connector writes closed; emit one bounded
  event lifecycle; preserve project, entity, source, memory, and approval scope.
- Verification: changed JavaScript syntax and `git diff --check` passed; 12
  router, toolkit, authorization-surface, and end-to-end orchestration tests
  passed after the final fail-closed event changes. The broader adjacent suite
  will be rerun after rebasing onto `origin/singulance-main`.
- Production: not deployed; not accepted
- Rollback: revert the eventual session-branch commit before integration
- Next: commit the isolated branch, rebase it onto current
  `origin/singulance-main`, rerun all focused and adjacent tests, then push for
  review without deploying.

## 2026-07-19 UTC - Structured chat orchestration committed

- State: Committed
- Owner: Codex
- Branch: `codex/chat-orchestration`
- Base / commit: `ed90a2e8e6bb635c1b164e813c0edad394748934` ->
  `ce24b7b891ccd48bca8740f489f7990cbb0d07ff`
- Scope: canonical Core `/api/chat` fast structured intent decision, lazy
  AgentScope-style HIVEMIND and connector toolkits, event lifecycle, scoped
  source/entity/project recall, versioned memory mutation, and external-write
  authorization migration and middleware.
- Verification: rebased successfully onto `origin/singulance-main`; all changed
  JavaScript passed `node --check`; Prisma schema validation and
  `git diff --check` passed; 126 focused and adjacent Node tests passed. Local
  test logs contained expected missing optional retrieval telemetry tables and
  unavailable localhost Qdrant diagnostics, with zero test failures.
- Production: not deployed; not accepted
- Rollback: revert `ce24b7b891ccd48bca8740f489f7990cbb0d07ff`
- Next: review and merge the pushed branch, then run the additive migration and
  authenticated `/api/chat` canaries through the production release protocol.
