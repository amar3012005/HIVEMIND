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

## 2026-07-25 UTC - TARA Grok voice implementation started

- State: Started
- Owner: Codex
- Branch: `codex/tara-grok`
- Base / commit: `699377a88` -> `pending`
- Scope: parallel xAI Grok Voice adapter, provider-aware Core contracts, TARA
  UI/provider routing, additive call-ledger migration, and guarded deployment
  configuration; no production deployment.
- Verification: pending focused adapter, Core, frontend, compose, and diff checks.
- Production: not deployed
- Rollback: not applicable
- Next: implement and verify the isolated branch, then push frontend before its
  parent gitlink.

## 2026-07-25 UTC - TARA Grok voice implementation committed

- State: Committed
- Owner: Codex
- Branch: `codex/tara-grok`
- Base / commit: `699377a88` -> `dff830deb`, `9e13ecc20`
- Scope: parallel `tara-grok` xAI Voice adapter, capability-scoped Core events
  and provider configuration, additive TARA call/campaign schema, provider
  toggle UI, HyperAgents provider snapshots, and guarded Compose/Caddy inputs.
- Verification: Python compilation; Core JavaScript syntax checks in the Core
  image; Prisma 5.22 schema validation; local Grok `/health/live`,
  `/health/ready`, and catalog checks; Grok image build; frontend production
  image build; `git diff --check`.
- Production: not deployed
- Rollback: disable Grok in Core, preserve `/voice2`, and remove only
  `tara-grok` using `TARA_GROK_DEPLOYMENT.md`.
- Next: review, merge, apply the additive migration, provision scoped secrets,
  then use the runbook's single-service canary sequence.

## 2026-08-06 UTC - KB grounding, evidence scope, and bi-temporal hand-off

- State: Committed; Accepted release for the changes listed here (verified live
  on `singulance`). The wider release `47d0122f` also carries a parallel
  session's `.amr` work that this entry does NOT vouch for.
- Owner: Claude (Fable workflow)
- Branch: `fix/kb-quote-ws-normalize` -> `singulance-main`
- Base / commit: `c615e4a3` -> `9ac8203b`, `91f7de36`, `dc27db94`, `72ca0a83`,
  `3dd12bee`, `b154c460`, `18309611`, `befb025f`, `c024cd57`, `2447e610`
  (frontend `Da-vinci` `d9fbb83` -> `a60762b`)
- Scope:
  - KB grounding: `content.includes(source_quote)` demanded byte-exact equality,
    so any quote spanning a re-wrapped line was discarded silently. This was the
    real cause of "kept 0 facts from a window holding 14/15 fact-bearing
    sentences" — long misattributed to the extraction model. Added a
    whitespace/unicode-tolerant locate that repairs the quote to the real
    section bytes, plus per-condition drop counters so a future zero-fact window
    names its cause. Same fix applied to evidence-segment binding.
  - Upload precheck: a `ready` ingest job outlives its document, so a
    since-deleted file was reported "Already in your knowledge base" forever.
    Precheck now confirms the document still exists.
  - Evidence scope: every segment carries `scope`/`scope_key`/`project_id`/
    `team_id`/`document_title` (both the semantic-upload and
    `ingestConnectorRecord` paths), so scope lenses apply to memories AND
    evidence on central and `.amr` alike.
  - Doc-summary prompt: stopped inventing an umbrella entity out of the
    filename ("The WrapTest DE project establishes...") and pinned same-language
    output.
  - MCP bi-temporal: `hivemind_at`/`hivemind_diff` posted a nested
    `time:{...}` that `/api/recall` never reads, so the filter was dropped —
    `hivemind_at` returned the whole corpus (356 memories / 1.7MB) while looking
    correct, and `hivemind_diff` compared two unfiltered sets. Sent top-level
    with the route's real key (`transaction_at`), and capped output with the
    documented `limit` (default 20).
  - Chat bi-temporal: routing was already correct, but `hivemind_context` is a
    `strict` tool whose every property is required, so the model satisfied the
    schema with null dates; `plan.time` came out null and every diff question
    fell through to a version-chain walk. Added a deterministic
    ISO/English/German date extractor used ONLY when the model supplies no date.
    The bi-temporal engine itself is untouched.
  - FE: the upload scope modal gated the org tier on `user.role`, which bootstrap
    never populates (role is `org.role` / `user.orgRole`), so the tier was
    unselectable for every user including owners.
- Verification: `node --check` on every changed file; 9/9 grounding assertions
  (newline + smart-quote drift recovered, hallucinated quote still rejected),
  9/9 page/segment assertions, 9/9 date-extractor assertions (ISO, `Aug 4,
  2026`, bare `Aug 4`, `4. August 2026`, `15. Marz 2026`, dedup, no false
  positives). Live: three documents uploaded at personal/project/organization
  each stored the right `scope_key`, and `scope_filter` recall returned only the
  matching tier (project failed closed). Live chat traces show
  `hivemind_diff` for a range question and `hivemind_at` for a point-in-time
  question, with a read-only regression pass (greeting, recall, source
  discovery, projects, relation) showing zero temporal leak. The precheck fix
  was verified on the real blocked file, flipping `duplicate:true` to
  `duplicate:false` with `stale_job`.
- Production: deployed to `singulance`; core ran through
  `prod-20260806-2447e610058e`, frontend `prod-20260806-c024cd5700a3`. Live core
  is now `sha-47d0122` (a later parallel-session deploy that carries these
  commits).
- Env (not in repo): `MEMORY_PROCESSOR_MODEL` and
  `ENTERPRISE_EXTRACTION_MODEL` moved off `deepseek-v4-flash-0731` to
  `google/gemini-2.5-flash-lite`; `KB_UNIFIED_FALLBACK_MODELS` deliberately left
  two-family (`deepseek,gpt-oss-120b`) so one provider outage cannot take out
  extraction.
- Rollback: revert the listed commits; frontend gitlink back to `d9fbb83`.
- Next: `docs/PRODUCTION_RELEASE.md` still records `prod-20260720-bc40fcaa` and
  needs whoever verifies the FULL `47d0122f` release to update it — this entry
  deliberately does not claim acceptance for the `.amr` changes it did not
  verify. Open items: the upload scope modal is proven at API and bundle level
  but not yet click-verified in a logged-in session; the hosted MCP connector
  used from Claude points at a different host that still runs the pre-fix
  `hivemind_at`/`hivemind_diff`.
