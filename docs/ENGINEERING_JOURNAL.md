# HIVEMIND Engineering Journal

## 2026-09-01 UTC — connector runtime and organic campaigns globally enabled

- Production inspection established that Connector Runtime V1 was already
  enabled for Chat, HyperAgents, TARA, and MCP with no connector allowlist.
  The remaining runtime surface, durable connector sync, was enabled with
  `CONNECTOR_RUNTIME_SYNC=true`.
- AI Campaigns now permits governed execution for every organization via
  `CAMPAIGNS_V2_ORG_IDS=*`. The enabled execution channels are the supported
  organic surfaces: X organic, LinkedIn, Instagram, Facebook, TikTok, YouTube,
  Pinterest, Reddit, Threads, Bluesky, and Google Business.
- This grants capability, not automatic publication. Provider connection,
  execution readiness, campaign approval, channel worker gates, and audit
  receipts remain mandatory. Paid X advertising remains blocked by
  `X_ADS_API_APPROVED=false`; the provider-approval safety gate was not bypassed.
- Governed Core-only release `b42ea7a610e64b5bdb6faece6fabf77cc8b453ed`
  runs image digest
  `sha256:dcbb3195563fdde259b812816502e980bd7c9f39e32e49da8d6f6bd3e6d86341`.
  Manifest: `/root/releases/manifests/b42ea7a6/20260901T073247Z/RELEASE_MANIFEST.json`.
- Two tenant contexts returned campaign capability HTTP 200 with
  `enabled=true`, `execution_enabled=true`, and every organic channel planning
  ready. Both also received authenticated HyperAgents capability tokens with
  the complete registered connector set. Core/API/campaign-page health passed,
  durable sync mounted, and the fresh critical-log scan was empty. No external
  campaign was published during acceptance.

## 2026-08-31 UTC — short-PDF routing and Workflow restart recovery

- Production recon found a second, independent latency cause: valid short
  text-layer PDFs were treated as image-heavy because the fast-path threshold
  required hundreds of characters. They entered whole-document vision and
  then Docling, even though native text was already usable.
- Canonical Core release `1765ad96bfd726e1fe358e5bc6aaf589ece99420`
  recognizes coherent Unicode text layers without a length/density threshold,
  keeps selective visual-page enrichment independent, and uses the configured
  Cloudflare Gemini route for vision fallback. A focused 49-test suite passed.
- Core startup recovery now requeues every current-version in-process Workflow
  checkpoint, rather than only capacity checkpoints. The Worker treats a
  pending materialization receipt as an idempotent redispatch. Focused Core and
  Worker suites passed 31 and 5 tests, and Worker typecheck passed.
- Worker version `e64dc93f-065a-4512-b5db-5435ecfaee2a` is deployed at 100%
  with the production R2, Queue, Workflow, Flagship, and secret bindings. Core
  manifest is `/root/releases/manifests/1765ad96/20260831T230417Z/RELEASE_MANIFEST.json`.
- Three interrupted jobs automatically resumed to `ready`. A fresh simultaneous
  three-PDF burst completed in 11–17 seconds with every checkpoint at attempt
  1, overlapping extract/embed/promote execution, and fast-PDF routing for all
  files. Live PNG job `f379e597-ab8d-403e-bf0f-a34698753454` also completed on
  attempt 1 with one canonical memory; retained JPG/JPEG jobs remain ready.

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

## 2026-08-06 UTC - Ingestion fail-proofing, scope routing, and the last silent data-loss path

- State: Committed; Accepted release for the changes listed here (verified live
  on `singulance`). The release also carries a parallel session's `.amr` and
  welcome-tour work that this entry does NOT vouch for.
- Owner: Claude (Fable workflow)
- Branch: `fix/kb-quote-ws-normalize` -> `singulance-main`
- Base / commit: `9e16bdd6` -> `7e1b07b9` (39 commits; frontend `Da-vinci` -> `42c6703`)
- Scope:
  - P0.1 REPLAY. Dead jobs were unrecoverable AND invisible: `_process` unlinked
    the raw file on the final attempt, so the module's own "raw file kept for
    replay" promise was false, and no endpoint listed a failed job. Terminal
    failures now retain their bytes, bounded by a sweeper that walks the real
    `KB_STORE_DIR/<org>/<checksum>/<file>` layout — a flat readdir, my first
    attempt, would have swept nothing. Added `GET /api/knowledge/jobs` with a
    `replayable` flag and `POST /api/knowledge/jobs/retry`, reusing
    upload-service's existing retry state machine rather than inventing a second.
  - P0.2 SEGMENT RECONCILER — the last silent data-loss path. The reconciler
    guarded memories only; a segment whose ingest-time heal also failed stayed in
    Postgres with `vector_stored=false`, permanently unsearchable while the
    document looked healthy. `healUnembeddedSegments()` reuses `_embedSegments`
    (per-tenant collections, batched upsert, remote `.amr` path) and rides the
    existing drift-guard tick. Measured 1 of 2096 segments affected.
  - P1.3 DUPLICATE INGESTION. The BullMQ worker ran on the default 30s
    `lockDuration` while real ingests take 30-134s, so a lapsed lock could
    re-deliver a job and ingest the same document twice. Now equals the job budget.
  - P1.4 was already fixed (`7bcc1def`) — found before re-implementing it.
  - SCOPE. The upload modal collapsed every non-personal scope to `organization`
    and passed the project via `containerTag`, which the upload route ignores, so
    project uploads were stored org-wide. It now sends the tier the user picked
    plus the project UUID. A stale `activeProjectId` from localStorage caused
    `scope_not_found` (surfacing as a 404) and is now validated against loaded
    projects. Duplicates are checked PER SCOPE, so one file may live in My Space
    and in a project but not twice in one scope, and deleting a document no longer
    blocks re-uploading it.
  - FORMATS. `pptx/ppt/doc/xls` withdrawn from `KB_EXTENSIONS` — no seam handler
    and no direct tier, so they fell through to Docling (measured 479s returning
    chunks=0, and a 600s convert timeout). Refused instantly instead.
  - VISION. Both providers returned `content || empty` on HTTP 200, so an empty
    reply counted as SUCCESS and the ladder never reached the configured
    OpenRouter fallback — the single cause of the scanned-PDF failures, not the
    model choice.
  - QUALITY. Facts are selected by salience rather than array position; table rows
    merge into one contextual memory (a 5-page budget went from 31 memories
    averaging 154 chars to 17-20 averaging ~235); `governanceAgentState` upserts.
- Verification: `node --check` on every changed file; unit assertions for the
  grounding locate (9/9), page mapping (6/6), date extractor (9/9), routing guard
  (9/9), salience selection (6/6) and the raw-file sweeper (8/8, proving what it
  does NOT delete). Live: a real 2.5MB customer PDF uploaded to a project landed
  `scope_type=project` with document, memories and segments all carrying the
  project scope; the same file was accepted into a second scope and refused in the
  same one; re-upload after delete succeeded; `pptx` returned 415 instantly;
  delete verified across seven tables, all zero.
- Production: deployed to `singulance`; core `prod-20260806-7e1b07b9d117`,
  frontend `prod-20260806-e0be490e8888-single`. restarts=0, oom=false, no fatals.
- Rollback: `hivemind/core-api:rollback-20260806-100604`,
  `hivemind/fe:rollback-20260806-100604-single`.
- Next: verify the vision ladder on a genuine scanned PDF (mechanism fixed, not yet
  observed succeeding); route `pptx/odt/rtf/epub` through LibreOffice -> PDF so
  Docling can be deleted; instrument cross-doc linking, which produced 63 edges on
  one document and 0 on another with the same code. SECURITY: a live GitHub PAT is
  embedded in `/opt/HIVEMIND/core`'s git remote URL and needs rotating.

## 2026-08-06 (late) — KB formats, slide citations, and a deploy that lies

Committed: `e51c4c83` (pptx restored + empty-extraction guard for all formats),
`8a0e73b1` (FE gitlink -> Da-vinci `7f51e7d`, client-side pptx accept),
`a6441e71` (page markers from docling provenance). All pushed to
`origin/singulance-main`.

Accepted release: core **running** `hivemind/core-api:prod-20260806-0a677a890b9b`
(a parallel session's build, which contains `a6441e71` — verified by ancestry AND
by grepping the running container), FE `hivemind/fe:prod-20260806-8a0e73b1-single`,
`hm-docling` pinned by digest `sha256:69f7c33d…` off mutable `:latest`.
`singulance-main` had already advanced to `ff7dc7ef` when this was written; the
ledger records what RUNS.

Verified end-to-end on production, not from logs: real 15-slide pptx uploaded
through `/api/knowledge/upload` -> docling -> 9 segments -> memories -> embedded ->
recall returned a cited memory. `with_page` went 0/9 -> 6/9 and the
`no start_page on ANY segment` warning disappeared; `parseText` stayed 5009 chars,
so no content regression. Delete cascade re-verified twice (21 and 16 memories,
no orphans); content-hash dedup correctly refused the same bytes under a new
filename. Both test documents were deleted afterwards.

THE FINDING THAT MATTERS: `release-singulance.sh` reports success over a container
still running the previous image. The compose files hardcode image tags and
nothing reads `${VERSION}`, so the script builds `core-api:<RID>`, bumps `VERSION=`
in `.env`, and `docker compose up -d` recreates the container **from the old tag** —
the env change alone is enough to force a recreate, so the log reads
`Recreated / Started` and the health check passes. Hit twice today; caught only by
`docker exec … grep` for a string from the diff. Until the script is fixed, the
compose tag must be updated by hand after every build (procedure in
`.claude/decision-docs/KB_PIPELINE_ARCHITECTURE.md` §9.1).

Four earlier "findings" this session were WRONG and are recorded so nobody
re-litigates them: the async submit/poll path, the task-vanished/OOM guard, the
empty-extraction fallback for PDF, and the reasoning-retry were all already
implemented. They looked missing because the benchmark used a standalone sync
harness instead of the production path. Read `docling-adapter.js` before
"fixing" docling. Likewise `DOCLING_SERVE_MAX_NUM_PAGES`/`MAX_FILE_SIZE` were
added and reverted (the docling service has no `env_file`; its config is inline in
compose) and `KB_QUEUE_CONCURRENCY` 6->3 was reverted (a measured note says the
serial point is the sidecar, not the queue). `.env` diffed identical to backup.

Corrections to earlier journal entries: the prior "next steps" item about routing
`pptx` through LibreOffice->PDF is unnecessary — docling parses OOXML natively via
python-pptx/python-docx/openpyxl (100% word recall, 0.2-12.4s). Only legacy binary
`ppt/doc/xls` need LibreOffice, and it would go in the **docling** image, not core.
Cross-doc linking is NOT uninstrumented: `[kb-unified]` and `[kb-hybrid-rel]`
already emit facts/pairs/edges counters (`40 gray-zone pairs -> 12 edges`).
The claimed GitHub PAT in `/opt/HIVEMIND/core`'s git remote does not exist on
SINGULANCE — that path has no `.git` at all, and every clone on the box has a
tokenless remote. The Groq key printed in session output is still worth rotating.

Next: fix `release-singulance.sh` to update the compose tag and to compare commits
rather than 8-char tag strings in its acceptance gate (it prints a false FATAL);
decide an owner for the 1M/day governance token pool, which is stopping dreaming
partway through the day for two orgs; improve the pptx anchor so the 3 of 15
slides that find no unique anchor get a page instead of `null`.

## 2026-08-07 UTC - Composio connector integration (LIVE-mode toolkits)

- State: Committed; Accepted release, verified live on `singulance`.
- Owner: Claude (Fable workflow)
- Branch: `feat/composio-connectors` -> `singulance-main` (frontend
  `fe/composio-connectors` -> `Da-vinci main`)
- Base / commit: `ac21aed1` -> `a47803b1` (frontend `Da-vinci` `eee44a86` ->
  `64ef37ae`)
- Scope:
  - New `core/src/connectors/composio/composio-service.js` — Composio wrapper
    for LIVE/on-demand connectors, complementing Nango. Nango stays the OAuth
    broker for every INGESTION connector (Gmail sync, Drive index, Slack
    history — anything with a scheduled batch pull into memories/Qdrant),
    because Composio has no batch-sync concept at all: every call is a live,
    on-demand tool execution. Sessions, connect links (with on-demand
    auth-config auto-provisioning for toolkits with no ops-curated config),
    tool execution, toolkit catalog browsing (~1,089 toolkits), disconnect.
    Raw `fetch` against the REST API, no `@composio/core` SDK dependency —
    same rationale as `nango-service.js`. Every function hand-verified live
    against the real Composio API (connected accounts, auth configs, connect
    links, tool execution, toolkit listing, auto-provisioning) before being
    wired in.
  - `control-plane-server.js`: `GET /v1/connectors` composio overlay (same
    connected/needs_reauth/available vocabulary the Nango overlay already
    uses); `POST /v1/connectors/composio/:toolkit/connect` (OAuth2,
    redirect-out — Composio hosts its own consent page, not embeddable);
    `POST .../connect-api-key` (plain API-key toolkits); `GET
    /v1/connectors/composio/toolkits` (proxied catalog browse/search, hides
    `COMPOSIO_API_KEY` from the frontend); disconnect route composio branch.
  - `connectors/catalog.js` (+ frontend mirror): `provider:
    'nango'|'composio'|'native'` on every entry (additive, verified via
    plain `diff` — zero deletions); new `linkedin` entry, `mode: ['live']`
    only (Composio cannot do ingestion sync).
  - Frontend: LinkedIn tile wired to the new connect flow; new
    `ComposioToolkitBrowser.jsx` — the full toolkit catalog as a deliberate
    dark visual island (squared cards, official brand logos, tool/trigger
    counts, auth-scheme badges, Composio-managed-auth shield, version tag,
    plug-icon connect button) matching Composio's own dashboard rather than
    the app's light theme, plus a matching dark Browser Intelligence banner.
- Verification: `node --check` on every changed backend file; `esbuild` +
  `CI=false npm run build` green on every changed frontend file; every
  `composio-service.js` function exercised live against the real Composio
  project (not mocked) before merge. Post-deploy: image tags on `hm-core`
  and `hm-control` match the release SHA; `docker exec grep` for
  distinctive strings from the change (`composio_managed_auth_schemes`,
  `composioConnectMatch`, `composioToolkit`) confirmed present in BOTH
  running containers' `/app/src` — not just the image tag. The served
  frontend bundle (`grep` inside `hivemind-next-frontend-1`'s `/srv`, then
  fetched that exact chunk over HTTPS) contains `listComposioToolkits`.
  `GET /v1/connectors/composio/toolkits` and `POST .../connect` return 401
  (session-gated, not 404) confirming the routes are live.
- Production: deployed to `singulance` as `prod-20260807-a47803b1bff9`
  (core, control-plane, frontend all rebuilt and recreated; core-api digest
  matches the fetched SHA, resolved from GitHub per the fixed
  `quick-deploy.sh`, not a local clone).
- Env (not in repo): `COMPOSIO_API_KEY` added to `/root/hivemind/.env`
  (backed up first to `.env.bak-composio-key-20260807121317`), `hm-core` and
  `hm-control` recreated via `docker compose --env-file ../.env -f
  infra/docker-compose.hetzner.yml up -d --no-deps --force-recreate core
  control-plane` to pick it up. Verified present via `docker exec printenv`
  on both containers (not printed/logged) before and after; both came back
  healthy. Before this, every Composio route correctly 503'd
  ("Composio is not configured on this deployment") rather than crashing —
  the `isComposioConfigured()` gate worked as designed.
- Rollback: core `rollback-20260807-000547` (an earlier same-day tag; the
  running core-api content was verified directly rather than relying on
  this timestamp matching), control-plane `rollback-20260807-120152`,
  frontend `rollback-20260807-120152-single`. Revert the listed commits;
  frontend gitlink back to `eee44a86`. Removing `COMPOSIO_API_KEY` from
  `.env` and recreating `core`/`control-plane` reverts the env change alone
  without touching code.
- Next: task 5 from the original plan (merging Composio's per-org tool list
  into the `/chat` ReAct router and HyperAgents tool registry, so agents can
  actually call connected tools mid-conversation, not just connect
  accounts) is still open — everything shipped this entry is connect/browse
  infrastructure, not yet wired into agent tool-calling.

## 2026-08-07 UTC - Composio toolkit browser: day-mode redesign, old grid retired

- State: Committed; Accepted release (fe-only), verified live on `singulance`.
- Owner: Claude (Fable workflow)
- Branch: `fe/toolkit-browser-daymode` and `fe/remove-old-curated-grid` ->
  `Da-vinci main` (`048aed47`, `9d4f3307`); gitlink bumps
  `fe/toolkit-browser-daymode-gitlink` and `fe/remove-curated-grid-gitlink`
  -> `singulance-main` (`05e03a8e`, `06413492`)
- Scope:
  - `ComposioToolkitBrowser.jsx` reverted from an earlier dark-theme
    exploration back to the app's real light design system (white cards,
    `#e3e0db` borders, `#117dff` accent, squared corners) — matches the
    curated grid it sits below rather than being a visual island. Removed
    the duplicate dark Browser Intelligence banner (the real light-theme
    one already renders above this section).
  - New `isSelfServeConnectable()`: a toolkit only gets a working Connect/
    Add-key button when Composio can actually broker the auth itself (its
    own managed OAuth app, a plain API key, or no auth). Anything else
    (an auth scheme Composio lists but has no managed app for — e.g.
    Salesforce) gets a "Request access" mailto instead of a button that
    would just 400.
  - Retired the old category-tab-filtered curated grid
    (`filteredConnectors.map(renderConnectorCard)`) entirely — it showed
    the same toolkits twice in two different visual languages once the
    Composio browser existed. Kept: Browser Intelligence card, the pinned
    "AI Assistants" grid (ChatGPT/Claude — MCP-client setup, a different
    concept, not covered by Composio at all), then the Composio browser
    for everything else. `filteredConnectors`/`renderConnectorCard`/
    `CONNECTOR_CATEGORIES`/`activeCategory` are kept in the file (the
    AI-assistants grid still uses `renderConnectorCard`), just unused by
    the retired section — restoring a management view later is a
    render-only change.
  - KNOWN GAP, accepted deliberately: any Nango-connected INGESTION
    account (Gmail sync, Drive index, Slack history) had its
    connected/reauth/error status and Disconnect button rendered only in
    the now-removed grid. That management UI is gone for existing
    connections; the sync itself is untouched and still runs server-side.
- Verification: `esbuild` + `CI=false npm run build` green on every commit;
  `ui-preview` screenshots (light theme, mixed Connect/Add-key/Request-
  access/No-auth states, real Composio logo URLs) matched intent before
  each push. Post-deploy: `hivemind-next-frontend-1` image tag matches the
  release SHA; `docker exec grep` for `isSelfServeConnectable` and
  `Request access` confirmed present in the running container's `/srv`;
  that exact served chunk fetched over HTTPS (200) with
  `Cache-Control: public, max-age=31536000, immutable` — confirming both
  the new feature AND the separately-fixed static-asset caching are live
  together.
- Deploy note: `/root/hivemind-main` (the box's canonical preflight
  checkout) was mid-use by a concurrent session on `feat/social-session-
  crawl` with an uncommitted `frontend/Da-vinci` gitlink change pointing
  *backward* to `fd67a44` (older than canon, unrelated to that session's
  backend feature — incidental drift, not real work). `git stash` would
  not touch it (git stash does not include submodule-gitlink-only
  changes by default); resolved with `git submodule update
  frontend/Da-vinci` to restore the committed pointer, deployed from
  `singulance-main`, then switched back to `feat/social-session-crawl`
  afterward — verified clean, nothing lost.
- Production: `prod-20260807-064134925694` (frontend only; core/
  control-plane unchanged this release).
- Rollback: frontend `hivemind/fe:prod-20260807-3a1714a835c3-single` (the
  prior release, itself already the fixed-cache one from the parallel
  session's PR #94). Frontend gitlink back to `d631d6a`.
- Next: same open item as the prior entry — Composio tools are still not
  merged into the `/chat`/HyperAgents tool registry.

## 2026-08-07 UTC - Composio: real redirect-back, real connected state, tool-list popup

- State: Committed; Accepted release, verified live on `singulance`.
- Owner: Claude (Fable workflow)
- Branch: `fe/composio-callback-and-toolkit-detail` -> `Da-vinci main`
  (`07e35be8`); `feat/composio-callback-detail` -> `singulance-main`
  (`ff6cddd2`)
- Scope:
  - Composio genuinely redirects the browser back to `callback_url` with
    `?status=success&connected_account_id=...` appended once OAuth
    completes (confirmed against Composio's docs, not assumed). Both
    connect flows (curated LinkedIn tile, toolkit browser) switched from
    `window.open('_blank')` to a full-page redirect so that real
    redirect-back lands on this same Connectors page instead of stranding
    in an unwatched tab. A mount-time effect reads the three params once,
    marks the toolkit connected, then strips them from the URL.
  - `GET /v1/connectors/composio/toolkits` now also calls
    `composioService.listConnectedAccounts(orgId)` and annotates each
    returned toolkit with a real `connected` boolean — state survives a
    reload instead of only living in local component memory. The frontend
    sorts connected toolkits to the top (stable sort, within whatever page
    is currently loaded) and gives them a blue-glass fill + "Connected"
    badge instead of the plain white card.
  - New `GET /v1/connectors/composio/toolkits/:slug/tools` — full tool
    list (name + description, toolkit's own slug prefix stripped for
    readability) for one toolkit. Backs a new click-a-card detail popup
    ("what can the agent actually do with this" beyond the tool-count
    badge), triggered anywhere on the card except the Connect/Request-
    access controls (`stopPropagation` on those).
- Verification: `node --check` on the backend file; `esbuild` + `CI=false
  npm run build` green on every frontend file; direct calls to
  `getToolkitTools('linkedin')` confirmed the prefix-strip naming logic
  (an earlier version of it was buggy — greedy regex ate everything but
  the last word — caught before shipping, not after). `ui-preview`
  screenshots confirmed sort-to-top + glass styling with mixed
  connected/available toolkits, and a click-through screenshot of the
  detail modal showing a real toolkit's tool list. Post-deploy: all three
  image tags (`hm-core`, `hm-control`, `hivemind-next-frontend-1`) match
  the release SHA; `docker exec grep` for
  `getComposioToolkitTools`/`composioToolkitToolsMatch` (core+control) and
  `onOpenDetail` (frontend bundle) confirmed present in the running
  containers; the toolkit-tools route returns 401 (session-gated, not
  404) and the served frontend chunk returns 200 over HTTPS.
- Deploy note: `/root/hivemind-main` was again mid-use by the concurrent
  `feat/social-session-crawl` session, this time with a clean working
  tree (no uncommitted gitlink drift like the prior release) — switched
  to `singulance-main`, deployed, switched back afterward, verified
  clean both times. `git submodule update frontend/Da-vinci` is the
  correct fix whenever the gitlink shows modified after a branch switch
  on this checkout (plain `git checkout -- frontend/Da-vinci` does NOT
  update a submodule's checked-out commit, only `git submodule update`
  or `git -C frontend/Da-vinci checkout <sha>` do).
- Production: `prod-20260807-ff6cddd24c2d` (core, control-plane, frontend
  all rebuilt).
- Rollback: core/control-plane `hivemind/*:prod-20260807-064134925694`
  tags did not exist for core/control (fe-only release before this one) —
  rollback is the prior core/control-plane images from release
  `prod-20260807-a47803b1bff9`. Frontend gitlink back to `9d4f3307`.
- Next: same open item — Composio tools are still not merged into the
  `/chat`/HyperAgents tool registry (task 5 from the original integration
  plan).

## 2026-08-15 UTC - Recall transport and recovery hardening started

- State: Started
- Owner: Codex
- Branch: `codex/recall-reliability-e2e`
- Base / commit: `b584f3562199c1b0f8fc9ceb872e70402a2bd29a` -> `pending`
- Scope: Core recall deadlines and cancellation, Memory Box transport and
  availability semantics, stale-agent lifecycle, Core/agent capability
  negotiation, bounded reranker failover, ingestion completeness gates, and
  read-only `use_tools:false`/`use_tools:true` acceptance.
- Verification: baseline live Core and Memory Box probes captured; implementation
  tests pending.
- Production: not deployed
- Rollback: not applicable
- Next: implement and verify request-scoped deadlines with real cancellation.

## 2026-08-15 UTC - Recall transport and recovery hardening committed

- State: Committed
- Owner: Codex
- Branch: `codex/recall-reliability-e2e`
- Base / commit: `b584f3562199c1b0f8fc9ceb872e70402a2bd29a` -> `9b4f7b39`
- Scope: one inherited cancellation deadline across chat/tool/recall/rerank/
  Memory Box/Qdrant; per-tenant transport bulkhead; typed unavailable results;
  maintenance-only stale-box quarantine; agent capability handshake; bounded
  two-attempt reranking; Cohere v4-fast production default; query optimization
  on every native retrieval turn.
- Verification: 34 focused route/policy/transport/reranker/ingestion tests pass
  locally; Cohere v4-fast and Voyage each score 10/10 on the retrieval corpus,
  with v4-fast faster on both the small corpus and 150-document benchmark.
- Production: not deployed
- Rollback: not applicable
- Next: run Linux native-AMR suites and real authenticated acceptance before
  landing on `singulance-main`.

## 2026-08-15 UTC - Recall transport Linux verification completed

- State: Committed
- Owner: Codex
- Branch: `codex/recall-reliability-e2e`
- Base / commit: `b584f3562199c1b0f8fc9ceb872e70402a2bd29a` -> `8e104bd6`
- Scope: preserve typed timeout/unavailable coverage after escalation and refuse
  to start retrieval work after the inherited chat deadline has expired.
- Verification: 67/69 selected Linux assertions pass. The two failures
  (`evidence-packet` named-source window predicate and the base quick-recall
  evidence count characterization) reproduce unchanged on the base SHA and are
  not regressions from this branch. New expiry and Memory Box outage assertions
  pass, as do route, model-policy, transport, vector-recovery, reranker-budget,
  and ingestion-integrity suites.
- Production: not deployed
- Rollback: not applicable
- Next: land through PR, deploy the agent capability endpoint before Core, and
  run authenticated upload -> recall -> chat acceptance.

## 2026-08-15 UTC - Progressive chat latency repair started

- State: Implemented, pre-production verification
- Owner: Codex
- Branch: `codex/chat-orchestration-fast`
- Base: `92c6421efbc026de92fd3f6c0e8917ef1a900339`
- Decision: structured chat performs one compiled remote vector retrieval and
  one unified memory-plus-evidence rerank. Generic insufficiency reveals the
  retained ranks 6-15; only true zero coverage may perform one distinct
  recovery retrieval. Per-tenant transport saturation queues bounded work
  instead of rejecting the fifth internal read.
- Model: native final synthesis defaults to `openai/gpt-oss-20b:nitro`;
  Nemotron is retained only as an explicit canary.
- Verification: focused synthesis, progressive recall, and remote transport
  suites pass locally (24/24); Linux/native and authenticated production
  acceptance remain required before promotion.
- Production: not deployed
- Rollback: current immutable `prod-20260815-92c6421e` release.

## 2026-08-15 UTC — strategy trace on operating cycle brief

- State: Committed and accepted release
- Branch: `feat/hq-strategy-trace-brief`, PR #284, squash-merged to `singulance-main` at `c1ddd4058dc91760659ef3d042a32a4ca8d38f01`
- Decision: extend the existing `operating_cycle_brief` (not build a new mechanism) to surface `growth_stage_id`/`constraint_id`/`success_measure` already present on `HqTodo.context` since creation — closing the "why was this built" half of the strategy→objective→artifact→metric graph.
- Explicitly rejected: joining to `RuntimePerformanceMetric` by `stageId` for the "did it move a number" half. Grep across all writers confirmed `stageId` there is always a playbook execution stage id, never a `GrowthStage.id` — a join would silently return empty. No outcome metric exists against a growth stage anywhere in the codebase today. Recorded as an open gap, not built as a hollow feature.
- Verification: 69/69 mocked-prisma tests pass. Deployed to control-plane, `hm-control` recreated healthy, byte-verified (`projectStrategyTrace` present, 2 matches) in the live container. Four public health checks 200.
- Accepted release: `prod-20260815-c1ddd4058dc9`.

## 2026-08-16 UTC — cross-lane parallelism (in-flight case) + deploy-path process correction

- State: Committed and accepted release
- Branch: `feat/hq-cross-lane-parallelism-in-flight`, PR #287, squash-merged to `singulance-main` at `8e7e21c1f7b1d546559925c8d175e957495c91a3`
- Decision: extend the idle-only cross-domain parallelism (PR #281) to admit a genuinely free lane while another Room is already running, via `freeLaneReadyTodo`/`occupiedLaneEffectClasses` — fail-safe on unattributable occupancy. Reused the existing burst-dispatch loop by merging the gate condition rather than duplicating the ~230-line dispatch body.
- Incident during deploy: an ad-hoc `scripts/release-singulance.sh` run from `/root/hivemind-main` reported success and byte-verified clean, but `docker inspect hm-control` afterward showed a DIFFERENT image than the one just built — a concurrent session's canonical release of an older, unrelated PR (#286, meetings fix) had landed on the box in the same second and silently won. Root cause: this session used the wrong deploy entrypoint all along. The repo's own governor (`DEPLOY_GOVERNOR.md`) mandates `/root/quick-deploy.sh singulance-main` exclusively; `release-singulance.sh` from `/root/hivemind-main` is a different, non-canonical path with no shared lock against the real one.
- Corrected and redeployed via `/root/quick-deploy.sh singulance-main` (→ `scripts/release-canonical.sh` at the exact SHA). All 4 services (core, control-plane, employees, frontend) recreated, healthy, revision label `8e7e21c1` confirmed on every one.
- One gate false-positived (`playbook fixture catalog mismatch`) — investigated live rather than dismissed: every fixture file hash matched byte-for-byte; only the aggregate list order differed due to a `sort -z` locale-collation difference between host and container shells. Recorded as a pre-existing verify-script bug, not a real drift.
- Verification: 165/165 unit tests. Byte-verified `freeLaneReadyTodo` and the merged gate condition live inside `hm-control`. Four public health checks 200.
- Accepted release: all 4 services on `8e7e21c1f7b1d5`.

## 2026-08-19 UTC — hm-extract deployed as a narrow, flag-gated docling tier

- State: Committed and accepted release
- Branch: `claude/hm-extract-integration`, squash of 5 commits, fast-forward-pushed to `singulance-main` (no local `singulance-main` ref touched — another worktree/session had it checked out; pushed the remote ref directly)
- Base → final commit: `cfd9ea64` → `48fc40059633cf56f9ce2b8f11160b0bafd7e118`
- Decision: hm-extract (standalone anydoc-based extraction, built and locally e2e-verified across an earlier session) moved into this repo at `hm-extract/`. Original ask was to replace docling and "the legacy pipeline" wholesale; reading the CURRENT `doclingAdapter.parseBuffer` tier ladder in `core/src/server.js` (not the far staler branch an earlier session last saw it from) showed docling is already bypassed for most formats by dedicated, measured-better tiers — sheet-direct/csv-direct keep a real structured cell grid docling drops entirely, a mammoth "seam" tier already fixes docx heading loss, fast-pdf+groq-vision already beat docling on PDF while hm-extract itself measured zero page numbers there. Scope narrowed, with the user's explicit sign-off, to pptx/ppt/pptm/ppsx/ppsm and legacy doc/docm/odt/rtf/epub only — formats where docling genuinely is still the primary path today. New tier lives in `core/src/knowledge/enterprise/hm-extract-adapter.js`, inserted right before the docling call, same shape/fallback behavior as the existing seam tier. Gated entirely on `KB_EXTRACT_URL` (unset by default = zero behavior change); includes a circuit breaker (5 consecutive failures → 60s cooldown).
- Also extended the production release engine itself — hm-extract was not a known deployable service before this: added to `infra/docker-compose.hetzner.yml` (internal network only, no published port), `scripts/release-canonical.sh` (CONTAINER/IMG maps + build_cmd), `scripts/verify-deployed.sh` (health + source-hash verification). Not in the `COUPLED` atomicity group — independent standalone service.
- Two real bugs caught and fixed during the FIRST production deploy attempt, not found in local testing:
  1. Compose `healthcheck:` override used `wget`, which doesn't exist in the `node:22-slim` base image — made a genuinely healthy, listening container report unhealthy. Removed the override; the Dockerfile's own `node -e "fetch(...)"` healthcheck is correct and was already working.
  2. `verify-deployed.sh`'s playbook-fixture-catalog check false-positived (`FATAL: core playbook fixture catalog mismatch`) — same known bug already documented in this journal on 2026-08-16 and never actually fixed: `sort -z` orders filenames by shell locale, which differs between host and container, producing a different aggregate hash for identical file content. Verified live both times (again here) that every individual file hash matched byte-for-byte. Fixed for real this time: pinned `LC_ALL=C` in both `fixture_hash_local` and `fixture_hash_container`, verified directly against the real release worktree and the live `hm-core` container that both hashes now agree exactly.
- Verification: hm-extract's own test suite (26/26, golden + atomicity) verified from its new repo location before wiring. `hm-extract-adapter.js` unit-tested directly against a real running instance: correct format gating (pptx/doc/odt admitted; pdf/xlsx/csv/docx correctly excluded), a real SOLVIS pptx parsed correctly, circuit breaker opens after threshold and recovers after cooldown against a genuinely unreachable endpoint. Production: all 5 services (core, control-plane, employees, frontend, hm-extract) healthy/running, correct SHA label, source-hash verified. Confirmed `hm-core` can reach `hm-extract` over the internal network at the exact address the adapter expects.
- Production: `KB_EXTRACT_URL` is NOT set in production — the tier is deployed but inert. Enabling it (a real behavior change for pptx/legacy-doc uploads across all tenants) is an explicit follow-up decision, not made in this session.
- Rollback: `hivemind/hm-extract:rollback` and the other four services' rollback tags preserved per the release script's standard behavior; `hm-extract` itself can also simply have `KB_EXTRACT_URL` left unset, which is already the deployed state.
- Next: decide whether/when to set `KB_EXTRACT_URL=http://hm-extract:8088` in production; if enabled, monitor error rate/latency/fallback-trigger rate before considering any scope expansion beyond the current narrow format allowlist.

## 2026-08-19 UTC — hm-extract flag verified live (brief, reversible) + a real allowlist gap found

- State: Verified, no code change (env-only, reverted)
- Scope: real functional proof of the hm-extract tier, since local docker-compose e2e was blocked by pre-existing native-binary issues on this Mac (`singulance-amr`/mneme: no arm64 binary; under amd64 emulation, missing `libmvec.so.1` — both unrelated to hm-extract).
- With the user's explicit go-ahead, temporarily set `KB_EXTRACT_URL=http://hm-extract:8088` in `/root/hivemind/.env`, recreated only `hm-core` (same image, `sha-48fc4005`, no rebuild), confirmed healthy, then called the real deployed `hm-extract-adapter.js` directly inside the live `hm-core` container against a real SOLVIS pptx: `isHmExtractEnabled('pptx')=true`, `isHmExtractEnabled('pdf')=false`, `parseWithHmExtract` returned `tier=hm-extract:pptx, chars=9091, segments=26` — matching local measurements exactly. Reverted immediately after: `.env` restored from backup, `hm-core` recreated again, confirmed `KB_EXTRACT_URL` unset, same healthy state as before the test.
- Real gap found while locating the upload endpoint for this test: `core/src/knowledge/upload-contract.js`'s `KB_EXTENSIONS.document` allowlist is `['pdf','docx','xlsx','pptx','txt','md','markdown','csv','tsv','html','htm']` — doc/docm/odt/rtf/epub are NOT in it at all, and only `pptx` (not ppt/pptm/ppsx/ppsm) is admitted. The file's own comment explains why: "STILL WITHDRAWN: ppt, doc, xls (legacy binary)... need LibreOffice... OpenDocument (odt/ods/odp) is untested." This means most of the hm-extract-adapter's narrow allowlist (everything except pptx) is currently DEAD CODE via the real upload path — those formats get rejected at the contract layer before parsing ever starts. Not fixed in this session; recorded as an open gap for whoever decides to actually enable and use this beyond pptx.
- Production: unchanged from the 2026-08-19 hm-extract deploy entry above — `KB_EXTRACT_URL` unset, tier live but inert.
- Next: either widen `KB_EXTENSIONS.document` to admit doc/docm/odt/rtf/epub (a real, separate decision — those formats were deliberately withdrawn before for LibreOffice/untested reasons unrelated to hm-extract, so admitting them now needs its own review) or narrow `KB_EXTRACT_FORMATS`'s default to just `pptx` to match what's actually reachable today.

## 2026-08-19 UTC — hm-extract activated and accepted through real uploads

- PR #443, canonical SHA `6764d157beea886b361f69b513fa65cddf58bf50`.
- Closed the reachability gap by admitting only `doc,docm,odt,rtf,epub` in
  addition to the already-admitted PPTX. Added ZIP/OLE/RTF signature guards.
  Legacy PPT/PPTM/PPSX/PPSM/XLS/ODS/ODP remain rejected.
- Enabled `KB_EXTRACT_URL=http://hm-extract:8088` and deployed only Core via
  the immutable release runner with the explicit divergence override; no
  Runtime/Room envelope changed, so Control, Employees and frontend were not
  rebuilt. Rollback env backup: `.env.pre-hm-extract-20260819T094516Z`.
- Local/live-service validation: 26/26 anydoc golden, atomicity, admission and
  memory-budget tests; 22/22 upload contract/service/route/quota tests.
- Real tenant E2E project `27362239-f287-4829-b160-f9e755b5adcd`: complete
  55-file SOLVIS folder, 53 unique ready jobs + two duplicates, zero failures;
  totals 703 pages / 1,862 segments / 727 candidates / 703 memories.
- The two SOLVIS decks used `hm-extract:pptx` (not Docling), with 22/26 service
  segments and 290-350ms Core parse-boundary latency. Both final jobs were
  ready with 11/15 evidence segments and 24 memories each.
- Legacy canary project `e959f666-5c4a-45f8-8d2f-c9dc5ea561c4`: DOC, DOCM,
  ODT, RTF and EPUB all used hm-extract and reached ready.
- Scoped recall was hybrid (memory + evidence) at 0.84-1.01s internal; grounded
  chat returned cited answers for WP-storage benefits and detailed Solvis
  product families. Fresh fatal/hm-extract failure logs: zero.
- Honest separate findings: some large-document memory extraction windows had
  fact shortfalls; one embedding attempt hit the 1s primary timeout and healed
  through fallback with zero failed segments. Evidence remained persisted and
  recallable. These are not parser failures and were not hidden in acceptance.
## 2026-08-29 UTC — shared Cloudflare Agent Memory deployed

- State: Committed and Worker deployed; repository integration pending.
- Branch: `codex/cloudflare-agent-memory`.
- Commits: `f9926c93` (service and project-wide memory discipline), `ac424cab`
  (generate runtime types during checks instead of tracking the generated file).
- Decision: use one Cloudflare Agents SDK instance named `hivemind`, backed by
  Durable Object SQLite, as the cross-worktree engineering-memory index. Expose
  it through an authenticated stateless MCP endpoint. Git, decision documents,
  and release ledgers remain authoritative; remote memory does not replace them.
- Managed-product finding: `wrangler agent-memory namespace list --json`
  returned Cloudflare API code `10018 Not allowed`; the account token exposes
  the private-beta permission but the account is not enabled. The Agent/SQLite
  fallback uses stable public Workers and Agents SDK primitives and is isolated
  behind a bearer secret.
- Deployment: Worker `hivemind-agent-memory`, version
  `6acf23c5-4868-412c-905b-c9b27d15e371`, endpoint `/mcp`. The token is stored
  as a Worker secret and as the Windows user environment variable
  `HIVEMIND_AGENT_MEMORY_TOKEN`; it is not committed or logged. Codex global MCP
  entry `hivemind-agent-memory` reads that variable, so all worktrees inherit it
  after process restart.
- Verification: `npm run check` passed; `wrangler deploy --dry-run` passed with
  69 ms measured Worker startup on deployment. Local MCP acceptance returned
  401 without auth, initialized with auth, listed six tools, persisted a record,
  retrieved it by FTS, and updated health from 0 to 1. Remote acceptance returned
  401 without auth, persisted decision ID
  `5f47afd5-46ba-4487-9137-19a899321adf`, retrieved it by FTS, and reported
  `{ok:true, project:"hivemind", total:1, active:1, schema_version:1}`.
- Production: no SINGULANCE application containers or customer data changed.
- Next: merge the branch into `singulance-main`; restart Codex so the new global
  MCP connection loads the user-level bearer token; use `memory_health` and
  `memory_search` at the start of future HIVEMIND tasks.

## 2026-08-29 UTC — Day 1 durable lifecycle accepted through production canary

- State: Committed and accepted release.
- Branch/worktree: `codex/d1-production-release` in `C:\Users\AMAR\Documents\ChatGPT\HIVEMIND-d1-release`; feature commits through `6f9087886c91fd2b9f19e76ca5337a66b98f8703`, fast-forwarded to `origin/singulance-main`.
- Decision: a Room verifier status of `blocked` means the sealed report contains explicit evidence gaps, not that no report exists. Day 1 therefore delivers sealed `complete` and `blocked` final reports verbatim, while failed or unsealed turns remain non-deliverable. This matches the requirement to send whatever report the HyperAgents Room actually produced without hiding its caveats.
- Verification: 12/12 focused backend tests; Worker TypeScript check; Wrangler production dry-run. Governed release manifest `/root/releases/manifests/6f908788/20260829T200403Z/RELEASE_MANIFEST.json`; no migrations; three selected services healthy on the exact revision.
- Production E2E: exact Flagship canary only, one existing task, one sealed deterministic turn, one Cloudflare Workflow instance, one accepted email/PDF, persisted report SHA-256 and length, and a duplicate trigger no-op. No arbitrary customer organization was used.
- Local isolation: `singulance-local`, preview environment files, and local Docker settings were not merged into or referenced by production configuration.
- Agent Memory note: the globally configured memory MCP was not exposed to this already-running Codex task, so Git, tests, the release manifest, this journal, and runtime receipts are the authoritative record. Record/supersede this release in Agent Memory when the connector is available.

## 2026-08-29 UTC — canonical email colors and platform notification parity

- State: Committed and accepted release.
- Branch/worktree: `codex/humation-email-colors` in `C:\Users\AMAR\Documents\ChatGPT\HIVEMIND-email-colors`; commit `d843a66885878a605c4bc6d9589e207d568433b4`, fast-forwarded to `origin/singulance-main`.
- Root cause: Humation SVGs exposed the correct palette through CSS custom properties, but some mailbox renderers/image proxies ignore those properties and use black/white fallbacks. Email wrappers also used one generic pink ring. Because the public URL was immutable, mailbox proxies could retain the old result.
- Decision: direct path fills are the email-safe source of truth; lane ring/background metadata comes from the same shared palette; version the immutable URL whenever avatar bytes change. Every accepted canonical email also projects into the existing organization-scoped platform inbox, deduplicated by provider receipt.
- Verification: 30/30 focused tests. Governed release manifest `/root/releases/manifests/d843a668/20260829T202438Z/RELEASE_MANIFEST.json`; no migrations. One operator-owned Cloudflare send was delivered and created exactly one unread platform notification. Five live lane endpoints returned direct expected fills and no CSS-variable fills. Three affected containers healthy on the exact revision; fresh critical log scan empty.
- Scope boundary: recipients without a registered platform account have no platform inbox, so invitation/external-only email cannot create an in-app notification until they join. No local-preview or frontend settings were changed.

## 2026-08-29 UTC — Day 1 lifecycle promoted to default-on

- State: Committed and accepted release.
- Branch/worktree: `codex/humation-email-colors` in `C:\Users\AMAR\Documents\ChatGPT\HIVEMIND-email-colors`; feature-registry commit `f48d42b33c2f6890cc86cebe41360ac2e0c33914`.
- Decision: enable Flagship flag `day1_first_move_v1` for every context by using
  the `on` default variation with no targeting rules. Preserve two independent
  rollback controls: Flagship disable and the backend
  `HIVEMIND_D1_WORKFLOW_ENABLED` master gate. Keep reconciliation bounded to
  five organizations per cron run.
- Production verification: three eligible organizations started through the
  authenticated deterministic lifecycle endpoint and all three Cloudflare
  Workflow instances completed. PostgreSQL recorded three linked
  `lifecycle.email.sent` notifications with three distinct dedupe keys and zero
  duplicate-key groups.
- Local acceptance: `singulance-local` commit
  `b15b4ceb5d354f9281626cad9bd863c153a1ae6c`; 30/30 focused tests passed and
  `hivemind-control-plane-local` rebuilt with its existing Day-1 overlay and
  reached healthy. No production database or local deployment setting crossed
  the branch boundary.

## 2026-08-30 UTC — public AI discovery policy accepted in production

- State: committed and accepted. Parent `fe71aa3c173359659e0a3144df9aef3c0fde6eda`;
  Da-vinci `main` `93b15206d276c798993d57a63fd5694ff9609685`; Worker
  `hivemind-web` version `acc99047-4b86-41ca-b1b4-d00c55d6c75e`.
- Verification: public robots/llms/source-guide paths returned 200; private
  discovery paths returned 403; private login HTML returned `noindex`; API
  health returned 200.
- Cloudflare WAF ruleset `06fb27e2007640bea0a590a353797322` blocks only four
  discovery paths on private Worker hostnames. Public marketing traffic remains
  available. The governed canonical service release `40e3b3d1` completed with
  Core, Control Plane, and Employees healthy; no migrations occurred.
## 2026-08-29 UTC — enterprise canonical ingestion lifecycle started

- State: Started
- Owner: Codex
- Branch: `codex/knowledge-ingest-workflow-v1`
- Base / commit: `8b4af294bd24ad738d70cebb3ac715e737895f00` plus
  `origin/singulance-main` merge `c83de650c896c4f2f8eeacaa0e54361cb8df48cb` -> pending
- Scope: local-only durable Knowledge Base orchestration using Cloudflare
  Workflow, Queue, R2, Flagship, PostgreSQL checkpoints, and the existing
  canonical memory/evidence/entity funnel; public upload payloads remain
  unchanged.
- Verification: baseline and implementation tests pending.
- Production: not deployed; production resources and `singulance-main` are
  explicitly out of scope.
- Rollback: disable `knowledge_ingest_workflow_v1` or
  `KNOWLEDGE_INGEST_WORKFLOW_ENABLED` to retain the existing BullMQ path.
- Next: freeze the existing upload/status contract in tests before adding the
  additive checkpoint schema and local Worker.

## 2026-08-30 UTC — enterprise canonical ingestion lifecycle accepted locally

- State: local implementation and Cloudflare acceptance complete; production
  unchanged. Branch `codex/knowledge-ingest-workflow-v1`, worktree
  `P:\HIVEMIND-worktrees\knowledge-ingest-workflow-v1`.
- Compatibility: upload/precheck/status routes, multipart fields, response
  keys, `X-Job-Id`, 50 MB limit, duplicate behavior, scope enforcement, and
  BullMQ fallback remain unchanged.
- Durability: jobs latch orchestrator/source references; ten canonical receipts
  are processing-version, digest, lease, and lease-token fenced. Queue messages
  contain identifiers only; R2 reads verify ETag plus SHA-256.
- Canonical convergence: entity and claim projection are awaited. Covered
  connector/chat adapters cannot persist memories or entities outside the
  canonical service. Concurrent canonical entity creates converge through a
  database-unique identity key.
- AI parity: local Core used the production model policy and Cloudflare AI
  Gateway. Chat extraction rejects BGE embedding/reranker routes. The BGE-M3
  canary returned 1024 finite dimensions.
- Cloudflare: created only the `-local` Queue, DLQ, R2, Workflow, and Worker;
  deployed Worker version `ad64498c-2489-459c-a664-7de235a7bd38`. Flagship is
  true only for organization `47e2ba84-1b9f-4e1b-804b-7bd77d4eea0f`.
- Runtime: evidence-only job `7ae4c69c-8c2c-40a7-b764-e88b156d5c8b`
  completed with 10/10 vectors and zero memories. Paolo job
  `cca99f31-fcfd-4707-b0ba-2d84de3f9d9c` completed with one document, two
  segments, ten candidates, eight memories, nine citations, ten receipts, and
  one canonical Paolo entity. Duplicate hosted starts completed once with
  stable counts; recall returned two memories and one exact evidence result.
- Verification:
  - Focused backend command covering `tests/knowledge/*.test.js`, the knowledge
    route, canonical entity/routing, LiteLLM/Gateway, and local proxy contracts:
    133 passed, 0 failed.
  - Worker `npm test`: 2 passed; `npm run check`: passed; `npm run dry-run`:
    passed with only `-local` bindings.
  - Frontend `npm run test:ai-discovery`: 3 passed; `npm run build`: compiled
    successfully.
  - `npx prisma generate`, `npx prisma validate`, and three additive local SQL
    migrations: passed/applied.
- Repository baseline: unfiltered `npm test` remains red for unrelated existing
  runner/environment defects (Vitest collected by Node, retired paths/modules,
  Windows without native AMR, and legacy unrelated assertions). Feature-scoped
  gates are green.
- Rollback: disable Flagship `knowledge_ingest_workflow_v1` or set
  `KNOWLEDGE_INGEST_WORKFLOW_ENABLED=false`. No production deployment ran.

## 2026-08-30 UTC — durable canonical ingestion accepted in production

- State: accepted release. Candidate branch `codex/knowledge-ingest-production`
  was built from the latest `origin/singulance-main` and fast-forwarded only the
  ingestion commits; unrelated `singulance-local`, preview, Dreaming, and
  frontend commits were excluded. Canonical SHA:
  `5a979b736c2e02214cae8e95785446e66748dff7`.
- Static verification: focused Core command reported `tests 141; pass 141;
  fail 0`; Worker tests reported 2/2; Worker TypeScript and production Wrangler
  dry-run passed; Prisma generate/validate and `git diff --check` passed. The
  first Windows `npm ci` attempt hit the repository's Lightpanda `|| true`
  portability defect; `npm install --ignore-scripts` plus explicit Prisma
  generation provided the complete dependency tree used by the passing tests.
- Release: the mandatory governor claimed session
  `knowledge-ingest-prod-20260830`, built immutable Core, Control Plane, and
  Employees images, applied all three additive migrations, recreated only those
  services, and verified exact revision labels plus health. Manifest:
  `/root/releases/manifests/5a979b73/20260830T143237Z/RELEASE_MANIFEST.json`.
- Cloudflare: production-only R2, Queue, DLQ, Workflow, and Worker were created.
  Worker version `cb297a0d-7025-4440-bd4c-a4f6e9c1ce5f` contains the shared
  secret binding. Unauthorized `/enabled` returned 401. Flagship remains
  default-off with environment-qualified local and production canary rules.
- E2E evidence: job `60828bf4-4578-48c4-948e-a9affebdde0a`, document
  `ddcf42c9-44a3-4326-818f-4c2c67c72f11`, and deterministic Workflow instance
  `kb-60828bf4-4578-48c4-948e-a9affebdde0a-v1` reached `ready`. Persisted
  verification found 10/10 successful receipts, 1/1 evidence vector, five
  memories, five citation links, canonical Paolo Meridian and Singulance
  Operations entity links, four related graph edges, and exactly three usage
  settlements. Two duplicate starts returned the same completed Workflow and
  left all counts unchanged. Persisted-hybrid recall returned the canary memory.
- Runtime proof: public API health and login returned 200. Fresh Core, Control
  Plane, and Employees critical-log scans were empty. Running image labels equal
  the canonical SHA.
- Backup: `/root/releases/backups/post-knowledge-ingest-5a979b73-20260830T150239Z.sql.gz`,
  199 MB compressed / 321,010,151 bytes uncompressed, SHA-256
  `4f517652dc07696ba43576c51e139f61265a98a6ba539a905149a872754828af`.
  An initial 20-byte failed pipeline artifact was removed before this verified
  backup was created.
- Rollback: Flagship canary removal is immediate. Backend kill switch is
  `KNOWLEDGE_INGEST_WORKFLOW_ENABLED=false`. Environment backup:
  `/root/hivemind/.env.pre-knowledge-ingest-20260830T143208Z`; canonical prior
  images are `sha-40e3b3d1`.

## 2026-08-30 UTC — BYOD graph routing completed for ingestion canary tenant

- Committed: `812397915495bf551d0ddb94b5d3596a6db22d73` latched agent
  routing on remote hydration; `048fba06cb0437c77ff2c26ddd132509883c57d0`
  carried the authoritative scoped-org decision through every graph projection.
- Test command: `node --test tests/unit/relationship-route-persistence.test.js
  tests/memory/relationship-semantics.test.js
  tests/unit/quick-deploy-service-scope.test.js` → `tests 20; pass 20; fail 0`.
- Accepted release: governor session `byod-graph-final`, Core-only manifest
  `/root/releases/manifests/048fba06/20260830T173838Z/RELEASE_MANIFEST.json`.
  `hm-core` is healthy on `sha-048fba06`; `hm-control` and `hm-employees`
  remained healthy on `sha-b3616eb4`.
- Runtime proof: tenant-scoped BYOD create and explicit Updates requests both
  returned 201. Relationship hydration returned the Updates edge and a
  canonical-entity Mentions edge; the old memory was non-latest; entity tags
  included `paolo-meridian`, `heidelberg`, and `atlas-memory-box`.
- Flag proof: the production Worker `/enabled` returned true for the designated
  org/user pair and false for a different user in the same org. All exact
  production canary memories were deleted afterward (8 tag-selected rows plus
  the non-latest predecessor); a final critical-log scan was empty.
- DECISION: preserve Flagship default-off and exact two-dimensional targeting.
  This is reversible and prevents an untested tenant-wide rollout.

## 2026-08-30 UTC — ingestion canary targeting expanded

- Added one production-only, exact org-and-user rule to
  `knowledge_ingest_workflow_v1`: org
  `bfbdd2bc-e214-44e5-80d4-e3284256d0c0`, user
  `e35811aa-4bcd-44bb-b829-a437895a42eb`.
- Runtime verification through the production Worker `/enabled` endpoint:
  requested pair `true`; same org with a different user `false`.
- Audited Day 1 without mutation: `day1_first_move_v1` is enabled with
  `default_variation=on` and zero targeting rules; production backend master
  gate is true. No deployment was required for either check.

## 2026-08-30 UTC — exact canonical entities and Workers AI BGE-M3 accepted

- Committed and deployed Core SHA `a4b0448cc42b7ea7c98d656efaa9a640798a34f0`.
  The canonical promotion schema now requires a subject and entity array, and
  the materializer deterministically merges source-supported generated
  entities, the claim subject, and relationship endpoints before tags,
  metadata, vectors, evidence metadata, and canonical projection are written.
- Root cause: this was a schema/materialization gap, not merely model quality.
  The prompt requested names, but optional output fields and disconnected
  projection paths allowed a valid model response to lose a query-worthy name.
- Embeddings: production now uses Cloudflare Workers AI
  `@cf/baai/bge-m3` through AI Gateway `hivemind-prod`, with OpenRouter
  `baai/bge-m3` as the same-model secondary. Provider-local timeouts now fail
  over; caller cancellation remains fail-fast.
- Verification commands: `node --test tests/unit/embedding-fallback-contract.test.js
  tests/claim-structuring-rows.test.js tests/unit/kb-upload-integrity.test.js`
  reported `tests 20; pass 20; fail 0`; focused materialization tests reported
  `tests 3; pass 3; fail 0`; all changed files passed `node --check` and
  `git diff --check`.
- Production proof: pre-release Workers AI probe returned HTTP 200 and a
  1024-dimensional vector. Post-release factory acceptance logged
  `cloudflare -> openrouter`, returned a finite 1024-dimensional vector, and
  materialized exactly `Apple Vision Pro/product` and `Amira Patel/person`
  while rejecting an unsupported invented entity. Public login and API health
  passed; fresh critical-log count was zero.
- Release: governor session `codex-cf-bge-entity`, Core-only manifest
  `/root/releases/manifests/a4b0448c/20260830T180454Z/RELEASE_MANIFEST.json`.
  No frontend, Control Plane, Employees, database, Flagship, Worker, or local
  deployment setting changed. Environment rollback backup:
  `/root/hivemind/.env.before-cf-bge-20260830T180445Z`.

## 2026-08-30 UTC — transient Knowledge Base connectivity noise fixed

- Root cause: the durable status loop correctly retried a missed poll, but the
  shared Axios interceptor first converted that same expected miss into a
  global `Connection problem` toast. Independently, TopBar declared `Offline`
  after one failed background health probe.
- Frontend commit `3fb492ac6e69008f19bc71bbe9fc81878e806b2f` suppresses
  global outage notifications only for retrying status polls and background
  health probes. User-initiated upload failures and real 5xx responses remain
  visible. TopBar now requires three consecutive failed probes and recovers on
  the first success.
- Verification: focused Jest suite `2 passed`; optimized production build
  compiled successfully; Wrangler dry-run passed. Cloudflare Worker
  `hivemind-web` version `288561fd-e001-4132-a82c-7e8f0711d9e3` was deployed.
  The served lazy application chunk contains both the status route and
  `suppressServiceError` marker; public login returned 200.
- Scope: frontend only. No Core, Control Plane, Employees, database, Workflow,
  Flagship, or local-preview resource was rebuilt or changed.

## 2026-08-30 UTC — Phase 0 Canonical Knowledge Foundation accepted

- Committed: parent `singulance-main`
  `bccbf73fdc1fdb40b1699d1251e7df12e6a15ce0`; frontend `main`
  `59f3779b8291d5136a72a18867b5b4076ed46172`.
- Tests: canonical/proxy suites 12/12; Cloudflare Worker 11/11; frontend claim
  normalizer 2/2; optimized frontend production build compiled successfully.
- Migration `20260830190000_canonical_knowledge_foundation` applied. Verified
  backup `/root/backups/hivemind-pre-phase0-20260830T192734Z.dump`, SHA-256
  `d76a7e0d13425f2beedc3c4f5d2e340f29ba5961e617e633f2a5d6d3241a3ffd`.
- Accepted runtime: Core `sha-bccbf73f` digest
  `sha256:8f4c6b3632e637e80ca109d4ae1f2b01cef99cc8cf16b16ab63705a37db62269`;
  Control `sha-346586be` digest
  `sha256:285a4fdf44ee625ed0ad3f64807c6931b7623258cec4aa6d2d0b1abcc4061fbe`.
- Cloudflare: canonical Worker `c8461f69-d815-4ea5-bba3-82fc644a3f3c`,
  frontend Worker `0ff3c24a-f722-4510-808c-dc50af597602`, Workflow
  `claim-74fb72fc-08da-41cc-8c56-598eae67bfee-v3` complete.
- Production proof: one teaches claim, two entities, correct endpoint roles,
  exact quote, 2026-08-31 validity, `user_asserted`, zero lineage, replay 1/2/0,
  authenticated claims HTTP 200, public health 200, live UI markers, and zero
  fresh critical logs. User recall joined Deep Learning and Quantum Computing
  through Uwe without a false lineage edge.
- Rollout: `canonical_knowledge_foundation_v1` default `off`; exact canary
  `full`; non-canary `off`. Rollback is Flagship off, backend kill switch, or
  governor image rollback. Env backup:
  `/root/hivemind/.env.pre-phase0-20260830T1933Z`.

## 2026-08-30 UTC — Durable Cloudflare ingestion enabled globally

- Production mutation: Flagship app
  `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8`, flag
  `knowledge_ingest_workflow_v1`, changed from default `off` to default `on` at
  `2026-08-30T20:52:22.525Z`. Existing targeting rules were preserved. No code,
  Worker, container, database, frontend, Queue, Workflow, R2, or local setting
  changed.
- Preflight command: `wrangler flagship flags evaluate ... --context
  environment=production --context org_id=rollout-preflight-org --context
  user_id=rollout-preflight-user --json` returned
  `value=false, variant=off, reason=DEFAULT` before promotion.
- Acceptance command with valid unrelated UUID context returned
  `value=true, variant=on, reason=DEFAULT`; the authenticated production Worker
  `/enabled` probe returned HTTP 200 and `enabled=true` for the same unrelated
  valid context. Existing canary evaluation remained `on/TARGETING_MATCH`.
- Embedding acceptance: the running Core environment reports
  `EMBEDDING_PROVIDER=cloudflare`, `CLOUDFLARE_EMBED_MODEL=@cf/baai/bge-m3`,
  `CLOUDFLARE_AI_GATEWAY_ID=hivemind-prod`, and
  `EMBEDDING_FALLBACK_PROVIDER=openrouter`. A fresh in-container factory probe
  logged `[embed] chain: cloudflare -> openrouter (dim=1024)` and returned
  `dimension=1024`, `finite=true`, with both links healthy and no fallback log.
- Runtime remained healthy: Core `sha-7dcc5f15`, Control Plane `sha-346586be`,
  and Employees `sha-b3616eb4` were not rebuilt or replaced.
- Rollback: set the Flagship default variation to `off` for immediate admission
  rollback, or set `KNOWLEDGE_INGEST_WORKFLOW_ENABLED=false` as the backend
  master stop. Existing in-flight Workflow instances retain deterministic,
  checkpointed state.

## 2026-08-30 UTC — Knowledge Base canonical projection parity accepted

- Committed and deployed Core-only commits `85926c08cc8cb4d369d6263f69ae97a9cb4b7803`,
  `0bd3215e333ee9541b129ffec7fee7acb08d981e`, and final
  `7dcc5f15687a8088fb44d6938d5d4b1a9305a85f` from `singulance-main`.
- Focused verification command:
  `node --test tests/unit/document-canonical-projection.test.js tests/memory/canonical-knowledge.test.js`.
  Final result: 17 tests, 17 passed, 0 failed. Syntax checks and
  `git diff --check` also passed.
- Production E2E: authenticated canary upload job
  `671712ae-a118-4ba6-ae5c-444ec5da0f84` completed `ready` through
  `cloudflare_workflow` with one document, one segment, three candidates, and
  four memories. All four projection states were `full/complete` with no error.
- Semantic proof: memory `895b16bc-1dbd-4efc-bfa1-ac7b39617d88` produced one
  exact-evidence claim `Professor Uwe Egly (person) -> teaches ->
  Neuro-Symbolic AI course (technology)` plus subject/actor and
  object/technology roles. No factual predicate was written to memory lineage.
- Recall canaries passed for instructor, subject, start date, Quantum Computing,
  and Deep Learning queries. Clean-data chat answered both Quantum Computing
  and Deep Learning with citations. All synthetic canary documents/memories and
  all disposable API keys were deleted/revoked after verification.
- Runtime: `hivemind/core-api:sha-7dcc5f15`, digest
  `sha256:63f8785a4d7216bcb7c70e6f6f84bfd258c3176602f55dc36f6221633ac23929`,
  healthy with revision label `7dcc5f15687a8088fb44d6938d5d4b1a9305a85f`.
  Public API health passed and fresh critical-log count was zero. No migration,
  frontend, Control, Employees, parser, database, Redis, or Qdrant replacement.

## 2026-08-30 UTC — Canonical Knowledge Foundation enabled globally

- Operator decision: the current small user base makes a global core-feature
  rollout preferable to a prolonged percentage rollout. Changed only Flagship
  `canonical_knowledge_foundation_v1` in app
  `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8` from default `off` to default `full`.
- The flag remains enabled with all five variations and the original exact
  canary rule preserved. No Worker, Core, frontend, container, database, Queue,
  Workflow, R2 resource, or secret was changed.
- Wrangler 4.127.1 API evaluation returned `full/DEFAULT` for an unrelated
  production user and a different organization, and `full/TARGETING_MATCH` for
  the original canary. The live production Worker `/enabled` endpoint returned
  HTTP 200 with `mode=full` for both unrelated and canary identities.
- Rollback remains immediate: set the Flagship default to `off` or activate
  `CANONICAL_KNOWLEDGE_KILL_SWITCH=true`. Existing stable-path code remains in
  the runtime; changing the flag does not require a container deployment.

## 2026-08-30 UTC — Parallel recall reliability canary accepted

- Committed and accepted: `7f07fc39cd84d4826f2b73fae3aa38ce0a57d69d`
  plus chat integration fix `319620270b84392d13d3a2c8970c10cb299372ea` on
  `singulance-main`. No frontend commit, migration, or data-service change.
- Focused Core route/client/evidence checks passed 18/18 on Windows. The clean
  Linux Node container passed the 79-test recall/temporal/evidence set and the
  two targeted chat-toolkit flag tests. Worker tests passed 12/12; TypeScript,
  Wrangler production dry-run, syntax checks, and `git diff --check` passed.
- Production Worker `d99c1304-61ff-40c8-a4b5-b0b5c148ce80` exposes the
  authenticated fail-closed flag evaluation route. Unauthenticated access was
  401; exact canary was true; another user in the same org was false.
- Same-user production comparison temporarily served the exact rule off, then
  restored it on after propagation. Both modes returned HTTP 200 with identical
  ordered memory IDs `74fb72fc`, `0d633927`, `932e4b8b`, descending known times,
  and two evidence rows. On exposed four complete lanes; off exposed legacy
  behavior with no lane diagnostics.
- Live chat acceptance returned `2 memories + 1 evidence`, three citations, and
  a grounded Uwe Egly answer. The first chat canary caught an omitted trusted
  internal argument; regression coverage was added before the final release.
- Accepted Core `hivemind/core-api:sha-31962027`, revision
  `319620270b84392d13d3a2c8970c10cb299372ea`, digest
  `sha256:715f48540ef97dc7d51263e22c34476f35fe68542cac964c02e3afd507f36ad4`.
  Control and Employees retained their prior images. Public API, Core, login,
  and homepage returned 200; fresh Core critical-log count was zero. Canonical
  projection sibling check remained `full`.
- Flag default remains off and exact canary remains on. Environment backup:
  `/root/hivemind/.env.pre-recall-reliability-20260830T213044Z`.

## 2026-08-31 UTC — Durable chat session orchestration started

- State: Started; implementation and local verification in progress.
- Owner: Codex.
- Branch: `codex/durable-chat-agent-v1`.
- Base: `bb359330c3dfd336672433847af2559f2670b1b0` (`origin/singulance-main`).
- Scope: additive, fail-closed `durable_chat_agent_v1` turn/checkpoint/event
  ledger; metadata-only Cloudflare Agent session coordination; resumable Core
  event reads; preservation of the existing Native Chat V2 planner, top-5/
  top-15 recall windows, tool execution, grounding, and synthesis behavior.
- Data boundary: customer messages, recall packets, tool results, citations,
  and final answers remain in HIVEMIND PostgreSQL/Memory Box storage. The
  Cloudflare session receives opaque identifiers and execution metadata only.
- Production: not deployed; global default must remain `off` until a separate
  governed rollout is accepted.
- Verification: pending.

## 2026-08-31 UTC — Durable chat session orchestration accepted locally

- State: Committed and pushed as
  `7347cfc3f502fc564b75ae6efee5a6086cf6cc0f`; not an accepted production
  release.
- Branch/base: `codex/durable-chat-agent-v1` from
  `bb359330c3dfd336672433847af2559f2670b1b0`.
- Implemented additive Prisma turn/checkpoint/event state, authenticated cursor
  replay, idempotent admission/final replay, metadata-only Cloudflare Agent
  mirroring, fail-closed multivariate evaluation, and V2-compatible top-5/top-15
  depth behavior. Cloudflare notification is explicitly non-blocking after the
  local transaction.
- The local grounded canary exposed two existing two-stage gaps: an embedding-
  hostile attribute rewrite could miss the correct memory, and a conservative
  graph lookup could return empty while an explicit source claim was present.
  Durable mode now performs one bounded source-record recovery. Relationship
  synthesis remains citation-gated and the prompt still forbids co-mention edges.
- Commands and results:
  - `node --test ...durable-chat*.test.js ...chat*.test.js ...native-chat-v2.test.js`:
    70 passed; three Windows-only loaders failed before tests because
    `singulance-amr` has no `win32-x64` binary. Re-running those tests in the
    Linux image reached 18/21; the three failures reproduce pre-existing contract
    drift/missing isolated embedding configuration and do not touch changed code.
  - Focused durable suite: 9/9 passed, including a permanently stalled edge
    notifier proving Core admission and event persistence remain non-blocking.
  - `npm test --prefix workers/durable-chat-agent`: 12/12 passed.
  - `npm run check --prefix workers/durable-chat-agent`: Wrangler type generation
    and `tsc --noEmit` passed.
  - `prisma validate --schema core/prisma/schema.prisma`: valid.
  - Live local public API: save HTTP 201; fact, source, temporal, detailed,
    comprehensive, and relation turns HTTP 200 in `full`; temporal returned both
    exact dates with two sources; relationship returned the explicit ownership
    claim as grounded. Temporary scoped key was deleted and canary was tombstoned.
  - Replay route: unauthenticated HTTP 401; authorized cursor HTTP 200 with a
    completed turn and ordered next sequence. Cloudflare status endpoint HTTP 200.
- Local Cloudflare Agent version:
  `24cab74d-0e4a-466e-8a12-0b8b0a99aca3`. Production remained untouched and off.
- Rollback: disable `DURABLE_CHAT_AGENT_ENABLED` or serve Flagship `off`; existing
  Chat V2 remains the stable path.

## 2026-08-31 UTC — Durable chat continuation and Workflow accepted locally

- State: verified locally; not a production release. Branch remains
  `codex/durable-chat-agent-v1`; committed as `2d4619d4` and production
  master/Flagship gates remain off.
- Added an additive continuation table and lease-fenced store. Direct E2E proved
  an invalid choice returns HTTP 400 while releasing the token, a later valid
  retry completes it once, duplicate idempotency replays the response, and the
  plaintext continuation token is never persisted.
- Added `hivemind-chat-turn-workflow-local`. Deterministic instances wait for an
  opaque `chat-terminal` event for up to seven days. Live completed and failed
  canaries both reached Workflow `complete`; output was restricted to turn ID,
  status, phase, sequence, and timestamp.
- Stable-path proof used a temporary API container from the same image with
  `DURABLE_CHAT_AGENT_ENABLED=false`: HTTP 200, no additive response field, and
  zero durable-turn rows. The temporary container was removed.
- Query matrix: bounded fact, exact-source/stem, detailed, comprehensive,
  timeline, snapshot, diff, aggregate, relationship, and project operations ran.
  Timeline and ordinary facts grounded successfully. Snapshot/diff correctly
  failed closed where the tenant had no qualified temporal material; project
  listing correctly reported zero authorized projects. Standard used a top-five
  ceiling and detailed/comprehensive a top-fifteen ceiling.
- Commands and results:
  - `node --test tests/unit/durable-chat-agent.test.js tests/unit/durable-chat-continuation-store.test.js tests/unit/native-chat-v2.test.js tests/unit/compound-orchestrator.test.js tests/unit/chat-depth-contract.test.js`: 72/73 passed. The sole unrelated existing connector fixture expects no `instruction` field while runtime now includes it.
  - `npm test` in `workers/durable-chat-agent`: 15/15 passed.
  - `npx tsc --noEmit` and `npx wrangler types`: passed.
  - `docker exec -w /app hivemind-api npx prisma validate`: schema valid.
  - `node --check` for server, chat executor, continuation store, and durable
    turn store: passed.
- Local Worker version `308c14b7-ca86-4539-8abd-15831474515a`; production was not
  touched. Rollback remains the environment kill switch or Flagship `off`.

## 2026-08-31 UTC — Durable Chat V2 exact production canary accepted

- Accepted release `a73cdbc82dc5ea637244d38bda7fb8ea7a96a0f3` through the
  canonical Core-only governor. The release applied two additive idempotent
  migrations and replaced only `hm-core`; Control, Employees, frontend, data
  services, BYOD agents, ingestion workers, and TARA were not restarted.
- Pre-release PostgreSQL backup and checksum:
  `/root/releases/backups/pre-durable-chat-a73cdbc8-20260830T233248Z.sql.gz`,
  `88461757b872cc2d38cec13342697544819a58574a21d34d22d4d731c44c281c`.
- Core image `hivemind/core-api:sha-a73cdbc8`, digest
  `sha256:8d826de5f0c7ff669bc198da15e1453c915890cee8a6fa491a80554cff83e5f6`;
  manifest `/root/releases/manifests/a73cdbc8/20260830T233409Z/RELEASE_MANIFEST.json`
  reports `ok` and the exact revision.
- Production Worker active version
  `c413ed26-533f-4198-8d6f-be03841e1ae3`. The first secret probe failed closed
  because the secret was initially uploaded under a non-source binding name;
  no durable row was created. The source-defined `DURABLE_CHAT_AGENT_SECRET`
  binding was installed, the unused secret was removed, and authenticated mode
  checks then returned exact-canary `full` and unrelated identity `off`.
- E2E: stable flag-off arithmetic returned HTTP 200, original V2 keys, and zero
  durable rows. Exact canary arithmetic returned turn
  `21fbe4c5-2d54-4d3b-be72-781494b440c9`; duplicate
  `X-Idempotency-Key` returned the same turn with `replayed=true`. Its Durable
  Object held only phase/status/sequence/hashed trace metadata; Workflow output
  held only turn/status/phase/sequence/time and completed successfully. Grounded
  recall turn `074d6d72-afff-4006-ae4b-b432a72e7c47` returned three sources,
  two citations, no gaps, and `full/completed`.
- Checks: focused Core 82/82, Worker 15/15, Prisma valid, TypeScript and Wrangler
  production dry-run passed. Four durable tables and 14 indexes exist, both
  migration ledger rows are finished, public homepage/login/API/Core are 200,
  Core/Control/Employees are healthy, and fresh critical-log count is zero.
- Event replay authorization passed: the owning tenant received HTTP 200 with
  six ordered events, a different tenant received HTTP 404 with no events, and
  the unauthenticated public route returned HTTP 401.
- Flag default remains `off`; only the existing operator canary is `full`.
  Rollback is exact rule off, followed if needed by the backed-up Core environment
  kill switch and canonical service-scoped recreation. No global rollout occurred.

## 2026-08-31 UTC — Production OCR ingestion and durable-chat A/B canary

- Uploaded `1981-60th-AnnualTeil2-ocr (1).pdf` (90 pages, 11,886,521 bytes;
  SHA-256 `ef8db3e19feadc0dc7a0bb426b438e324c8e2f8b68be02eba928c9edb2a87c6a`)
  through the production asynchronous Knowledge API for the existing operator
  canary. Job `45f17bf4-b7c1-4b58-84ca-a74005bd5fb6` used the Cloudflare
  Workflow orchestrator and completed `ready` with document
  `380ba44c-60a5-4973-a992-a2e6525d63f4`, 216 segments, 216/216 embeddings,
  30 candidates, 15 promoted memories, verified citation/relationship stages,
  and zero failed embeddings.
- The corrupt text-layer detector selected vision OCR. The initial long Core
  materialization request exceeded the Worker request window; Workflow retries
  were lease-fenced and the original attempt completed. Reconciliation reused
  the persisted receipt and the Workflow completed in five minutes without
  duplicate materialization. This validates recovery but identifies the next
  durability improvement: split heavy materialization into smaller Workflow
  checkpoints rather than one long Core request.
- Ran the same five-query production chat matrix with exact-canary Flagship mode
  `full`, then `off`, then restored `full`. Full mode created durable turns,
  recovered the Pantene/Procter & Gamble relation, and produced broader
  comprehensive coverage (10 sources/14 citations versus 6/6 when off). Off
  mode retained the stable V2 path and answered grounded source facts without
  creating durable turns.
- Source-constrained full-mode canaries returned Jim Adair for HASTY CAKE (1
  source/1 citation), the Mrs Paul's creative roles (1/1), and four grounded
  product/advertisement answers (4/4), with explicit gaps for Kaukauna and
  Westinghouse. Arithmetic remained correct and durable.
- Open defects discovered by the A/B test: a filename beginning with `1981` can
  be misclassified as a temporal snapshot and fail with
  `native_plan_missing_snapshot_time`; an unconstrained director query selected
  a conflicting authorized source (`Karen Brown`) instead of the newly ingested
  source (`Jim Adair`); one relation answer duplicated its sentence; and some
  detailed/role responses found passages but failed citation validation. These
  are shared V2 retrieval/planning/synthesis issues, not failures introduced by
  the durable wrapper.
- Production code and containers were not changed by this test. The global flag
  default remains `off`; exact operator targeting was restored to `full` after
  the comparison.

## 2026-08-31 UTC — Durable chat defects fixed and fresh heavy OCR E2E accepted

- Committed and pushed `d4a45da449301377ed8de465b21f900772ed023d`
  (chat planning/retrieval), `953f3a719aab66aed5b1f479ed6e45f232613761`
  (narrow async materialization proxy), and
  `4371984dccca1ee2666555fcbfee0606618ba3ad` (Cloudflare embedding batch bounds
  and retry-credit settlement healing) to the session branch and
  `singulance-main`.
- Accepted releases through the deployment governor only. Core manifest:
  `/root/releases/manifests/4371984d/20260831T005717Z/RELEASE_MANIFEST.json`;
  Control manifest:
  `/root/releases/manifests/953f3a71/20260831T004847Z/RELEASE_MANIFEST.json`.
  Exact running images are Core `sha-4371984d` / digest
  `2e954b4e4149b9cb7658327ab3231aea57eb5edadf526844dac2fe8649cf7fb0`,
  Control `sha-953f3a71` / digest
  `83ea81bfcb59de74e3955416cb10ddd6a0bafcb7211be582f62a1cab5b0de2a9`,
  and unchanged Employees `sha-b3616eb4`.
- Verification commands and outputs:
  - Focused Core batching/fallback/job-store tests: `22 passed, 0 failed`.
  - Control materialization proxy contract: `2 passed, 0 failed`.
  - Candidate/baseline chat suite: `72 passed, 3 failed` on both revisions;
    every changed/new test passed and the same three unrelated stale assertions
    remained.
  - `wrangler workflows instances describe ...v2`: `Status: Completed`,
    `Duration: 11 minutes`, `Last Successful Step: reconcile coverage and
    settle-1`.
  - Live Cloudflare embedding probe: `{"batches":[45,5],"rows":50,
    "dimension":1024,"finite":true}`.
  - Public checks: `singulancelabs.com 200`, production login `200`, API health
    `200`; fresh Core fatal/panic/unhandled/transport-queue/citation-failure scan
    returned no lines.
- Fresh OCR acceptance: job `85bf1f37-ff77-4865-819a-a4c3bebbf141`, workflow
  `kb-85bf1f37-ff77-4865-819a-a4c3bebbf141-v2`, document
  `483831cf-c694-41bf-b5f5-e51937224801`; terminal `ready`, 90 pages, 221
  segments, 221/221 embeddings, 17 candidates, 15 memories, zero vector
  failures, and settlement timestamp `2026-08-31T01:00:49.027Z`. Temporary host
  and container upload copies were removed after verified terminal settlement.
- Post-ingest chat acceptance:
  - Exact filename + Issue 361 returned Will Hopkins, Ira Friedlander, Robin
    McDonald, David Schaff, Barnaby Conrad III, Gray D. Boone, and Horizon;
    grounded with 2 sources / 2 citations.
  - Unconstrained CITY CYCLES returned David Barry and the correct subject;
    grounded with 2 sources / 2 citations.
- Production A/B retained the safety boundary: exact operator mode was restored
  to `full`; global default remains `off`; flag-off users continue on stable V2
  and do not create durable turns. Rollback images and digests are recorded in
  `docs/PRODUCTION_RELEASE.md`.

## 2026-08-31 UTC — Progressive profile discovery deployed and chat matrix accepted

- Committed and pushed `102b551d2d7ca454b3858b8736decdb86e41dbac`
  (lazy profile discovery), `b284a77ef581e01231f5c8b860e0b105f999a947`
  (tool-enabled profile read/write boundary),
  `62553bc2e566d72920d5480553534138f385cdca` (citeable authoritative empty
  project result), and `9091c1e01d63270a14d668cf60c6634d27469e95`
  (empty-project gap reconciliation) to the session branch and
  `singulance-main`.
- Each production replacement used the deployment governor's Core-only fast
  path. Final image `hivemind/core-api:sha-9091c1e0`, digest
  `258e140bc90f0bd2478371d7d12caf247e88648aa4f8e6eb5e318e8d5a6bb261`;
  manifest `/root/releases/manifests/9091c1e0/20260831T081213Z/RELEASE_MANIFEST.json`.
  Control `sha-953f3a71` and Employees `sha-b3616eb4` retained exact prior
  digests and start times throughout.
- Linux verification: initial lazy-profile release 39/39; final focused matrix
  83/84 with the parent baseline carrying the identical sole stale
  exact-source expected-shape assertion (`kind:null`). All new regressions
  passed; syntax and diff checks passed; no schema diff and no pending
  migration.
- Final authenticated production matrix for user `e35811aa-…` / organization
  `bfbdd2bc-…`:
  - direct arithmetic: `102`, HTTP 200, operation `direct`, no gaps;
  - tool-enabled organization profile: `Singulance Labs`, grounded 1/1,
    operation `profile`, no gaps;
  - exact Teil3 Issue 361 source: Barnaby Conrad III / Gray D. Boone, grounded
    2/2, operation `source_read`, no gaps;
  - Pantene / Procter & Gamble: one grounded relationship sentence, 2/2,
    operation `relation_between`, no gaps;
  - authorized projects: explicit grounded empty result, 1/1, operation
    `projects`, no gaps.
- Additional acceptance before the final sweep covered unconstrained CITY
  CYCLES recall, a detailed Teil2 creative-role synthesis, profile read,
  temporal no-coverage, and exact aggregate no-coverage. Missing complete
  temporal/registry evidence failed closed rather than fabricating an answer.
- Declarative auto-save canary selected `save` without a remember verb, used
  explicit personal scope, preserved three exact entities and
  `provenance:user-assertion`, and wrote through `ingestCanonicalPayload`.
  Tenant-scoped memory/entity rows were inspected, then memory
  `4f9ebe65-c99b-4b30-9736-fb28eac7bc7f` was hard-deleted through the API.
- Final Core/API/homepage health is 200; fresh fatal/panic/unhandled/transport
  queue/citation-failure log scan returned no lines. Release presence is clear.

## 2026-08-31 UTC — Durable chat Flagship default promoted globally

- Production governor updated Cloudflare Flagship app
  `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8`, flag
  `durable_chat_agent_v1`, through GET, precondition verification, and a complete
  PUT. Changelog timestamp `2026-08-31T08:28:06.413Z`; the only diff is
  `default_variation: off -> full`. Cloudflare reported the API operator as
  `updated_by: unknown`.
- Preserved exactly: string variations `off`, `shadow`, `session`, `workflow`,
  and `full`; two targeting rules; description; `enabled:true`. Rollback payload
  is the identical full definition with only `default_variation: off`.
- Production binding verification: existing operator resolved `full` through
  its preserved targeting rule. Two unrelated synthetic production contexts
  matched neither rule and resolved `full` with reason `DEFAULT`, proving the
  global rollout rather than accidental rule matching.
- Authenticated read-only canaries returned HTTP 200: direct response nonempty;
  profile grounded with one source; exact source grounded with one source and
  no gaps; relationship grounded with five sources and no gaps. No unrelated
  real identity had safe profile, parsed-source, and relationship coverage
  together, so no customer data was fabricated for acceptance.
- Core/API/homepage returned 200; critical logs were empty. Core, Control, and
  Employees retained exact images and start times. No build, migration, restart,
  or deployment occurred for this flag-only rollout. Release presence closed
  cleanly.

## 2026-08-31 UTC — Ingestion, recall, chat, and canonical knowledge globally reconciled

- Release session `best-path-global-flags` claimed the shared production
  presence channel and completed without a conflicting release.
- Verified Flagship app `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8`. Final global
  defaults: `knowledge_ingest_workflow_v1=on`,
  `recall_parallel_reliability_v1=on`, `durable_chat_agent_v1=full`, and
  `canonical_knowledge_foundation_v1=full`.
- Governed recall mutation used GET, precondition verification, and a complete
  PUT at `2026-08-31T08:52:20.083Z`. The changelog showed only
  `default_variation: off -> on`; both rules, boolean variations, description,
  type, and enabled state were preserved. The rollback payload is the same full
  definition with only the default restored to `off`.
- Live bound-Worker evaluations returned all four enabled values for the
  operator context and two unrelated synthetic contexts. The operator recall
  result was `TARGETING_MATCH`; both unrelated results were `DEFAULT`.
- Production resources were inspected in place. Canonical projection Worker v7
  is `d99c1304-61ff-40c8-a4b5-b0b5c148ce80`; ingestion Worker v4 is
  `d917d0a1-38fe-4933-a4eb-34bcb891c625`; durable chat Worker v4 is
  `c413ed26-533f-4198-8d6f-be03841e1ae3`. Their configured Workflow, Queue,
  R2, and Durable Object bindings match the current production definitions.
- Read-only E2E evidence: eight ingestion jobs were `ready`; the latest two
  PDFs were terminal at progress 100 and replayable; duplicate checksum groups
  were zero. Recall completed memory lexical (31 candidates), memory vector
  (67 candidates), evidence lexical, and evidence vector lanes with one
  embedding, retrieval, and rerank pass. Result: 3 memories, 12 evidence items,
  15 citations, 17 graph edges, and no degraded state.
- Authenticated direct, profile, exact-source, relationship, and entity chat
  requests returned HTTP 200. Profile/exact-source/relationship were grounded;
  the broad entity result was not grounded, and relationship/entity each
  retained one gap. These remain semantic-quality follow-ups rather than
  orchestration failures.
- Core `sha-9091c1e0`, Control `sha-953f3a71`, and Employees `sha-b3616eb4`
  retained exact images, start times, and zero restart counts. API and homepage
  returned 200; the 20-minute critical log scan returned zero matches. No build,
  migration, restart, container replacement, or Worker deployment occurred.

## 2026-08-31 UTC — Invitation lifecycle and My Company preview accepted

- Accepted invitation release `daddc0cbee911964e9a1adb99d1ec144e87a2958`
  with frontend `0309ac2f2ad8446e1b4a84d9d142e9d08b129b00`. Draft creation is email-free,
  delivery requires explicit Send, public invitation URLs are canonical, and
  first-time workspaces enter My Company. A synthetic draft-only canary was
  revoked without a provider send.
- Accepted preview release `afd9786705f87b851482004e3f79e8df748671b6`
  with frontend `bd777304ecfd1f1f4e61a990c846c887ee225268`. Playwright-first capture,
  bounded fallback, eager image loading, and awakening-copy spacing passed
  focused tests and the optimized build.
- Production proof: authenticated My Company returned an existing
  Playwright-backed screenshot; the deployed 12-second/150-ms renderer probe
  produced a valid image; served chunks contained the new loading/layout
  markers; all affected containers were healthy at exact revisions; public
  checks were 200 and fresh critical logs clean. No customer side effect was
  exercised.
- Release manifests and rollback versions are recorded in
  `docs/PRODUCTION_RELEASE.md`. Agent Memory release records:
  `d21c3d7c-d8c7-42b6-adb0-a24a5cae0451` and
  `db045133-a2ae-4c28-a04e-41c0000d33a7`.

## 2026-08-31 UTC — Existing HyperRoom fast-planner production canary accepted

- Committed `4a6b8105` on `codex/prod-fast-planner-canary`, then merged and
  pushed canonical `singulance-main` SHA
  `e2e2c055e56ed7d8a18bb7a0b099503f987b9f6a`. This release does not include
  or enable the Grok-style HyperAgents runtime.
- Added the fail-closed Flagship flag `hyperagents_fast_planner_v1`. Production
  default is `off`; only org `f0cb77ef-e62b-4f8c-a1da-066611fc3b36` plus user
  `b457c254-38a0-4c43-8280-b026f1a78b04` resolves `glm_no_reasoning`.
  Wrong-user and wrong-org live Worker probes both resolved `off`.
- The enabled existing Room path uses `@cf/zai-org/glm-5.3-flash` for profile,
  planning, and verification through Cloudflare AI Gateway. The transport
  forces `chat_template_kwargs.enable_thinking=false`; synthesis and worker
  personas remain on the stable production policy.
- Plain marketing copy now has a text execution profile. The profile selector
  preserves a current-evidence query and only requests the visual renderer for
  an explicitly visual deliverable. Enabled journal persistence uses a
  deterministic compact entry rather than another model call.
- Verification: Employees focused suite 54/54; canonical Worker 14/14 plus
  typecheck and dry-run; Core client 1/1; Prisma schema valid. A live Gateway
  GLM probe returned choices, and the production flag endpoint returned
  target=`glm_no_reasoning`, mismatches=`off`.
- Accepted release: Worker version `9346733c-5ce7-4c6f-8cdf-50a676091f56`;
  migration `20260831224500_hyper_fast_planner_flag`; governed manifest
  `/root/releases/manifests/e2e2c055/20260831T182301Z/RELEASE_MANIFEST.json`.
  Core, Control, and Employees are healthy at the exact canonical revision;
  public health passed and the fresh critical-log scan was empty.
- Rollback: set the exact canary rule to `off` first. Container rollback images
  are `sha-afd97867` for Core, Control, and Employees; Worker rollback uses the
  previous canonical-projection version. The additive latch column is safe to
  retain.

## 2026-08-31 UTC — HyperRoom canary planner moved to Gemini Unified Billing

- Committed `0389cc80` and merged canonical production SHA
  `8d35d3c26eb3170f35364fbc0e056512486f3522`.
- Replaced Workers AI GLM planning with
  `google/gemini-2.5-flash-lite` through Cloudflare's `/ai/v1/chat/completions`
  Unified Billing endpoint. Requests carry the configured Gateway ID but no
  OpenRouter provider key or BYOK alias, so they spend the Cloudflare credit
  balance and avoid the exhausted OpenRouter key limit.
- The existing default-off exact canary flag and stable non-canary behavior are
  unchanged. No Grok runtime feature was enabled.
- Verification: 55 focused Employees tests passed; pre-release and post-release
  live Gemini probes returned choices; Core, Control, and Employees are healthy
  at the exact revision; public health passed; fresh critical logs were empty.
- Governed manifest:
  `/root/releases/manifests/8d35d3c2/20260831T192956Z/RELEASE_MANIFEST.json`.
  Rollback images are Employees/Control `sha-e2e2c055` and Core `sha-f4107cc8`.
- The first release attempt stopped before build at the 25-GB disk guard. The
  governed retention script removed three unused old Core tags and recovered
  6 GB; running images, volumes, and the manifest-selected rollback targets
  were preserved.

## 2026-08-31 UTC — Cloudflare ingestion v2 remediation prepared

- Globally disabled `knowledge_ingest_workflow_v1` in production before code
  work. Default and both production rules serve `off`; local-only targeting was
  preserved. No Worker/container restart occurred during rollback.
- Root cause: Groq HTTP 400 billing responses were inserted into per-page HTML
  comments and persisted as evidence. Production direct Cloudflare REST probes
  proved `google/gemini-2.5-flash-lite` accepts text and image input through
  gateway `hivemind-prod`; the unrelated OpenRouter quota is not on this route.
- Session branch `codex/knowledge-ingest-production-v2` adds one-time admission,
  no silent BullMQ fallback on admission outage, a fenced global processing
  lease, real evidence/promotion checkpoints, direct Cloudflare Gemini vision,
  and parser-error contamination rejection.
- Pre-release verification: focused Core 24/24, evidence/chunking 28/28,
  Worker 4/4, Worker TypeScript, production Wrangler dry-run, Prisma schema
  validation, and direct production transport probes. The feature remains off;
  this is committed implementation evidence, not an accepted release.

### Failed first production canary and rollback

- Candidate `ff80d612` deployed Core and Worker with the flag off, then enabled
  only the authorized canary. The Workflow stopped at acquisition because the
  unqualified lease migration created `public.knowledge_ingest_leases` while
  production Prisma queries `hivemind.knowledge_ingest_leases`.
- No parser, evidence, memory, entity, relationship, citation, or billing stage
  ran. The canary flag was restored off; Worker and Core were rolled back to
  their exact prior versions. Control and Employees were untouched.
- Follow-up migration `20260901000500_fix_knowledge_ingest_lease_schema`
  removes the empty public table and creates the lease table and indexes in the
  authoritative `hivemind` schema. The first candidate is not an accepted
  release and must not be described as one.

### Failed second canary and rollback

- The corrected schema canary acquired and renewed its fenced lease. Real
  `materialize_evidence` and `promote_memories` receipts succeeded, proving
  restartable stage separation. Reconciliation then hit the existing database
  enum constraint because stored promotion returned the new internal string
  `memory_generation_yield_zero`.
- The flag was restored off and Core/Worker rollback began before acceptance.
  The fix maps zero-yield promotion to the already documented and permitted
  `extraction_yield_zero` value, preserving the existing API/status contract
  instead of widening it with another public enum.

### Accepted final canary and governed release

- Final canonical SHA `f4107cc82490a1ddf57a7b215955be6184d4038b`
  deployed Core-only through the governor. Core digest is
  `sha256:77083aab6997bfbda1a9ddbf2d0294396197528ccd399c90b4ccbcef7713c217`;
  Worker version `d8547ac3-6609-4b47-bf87-32cd9d9c185a` is active at 100%.
  Control and Employees retained their prior images and start times.
- A valid disposable PDF completed Workflow
  `kb-577defcf-94d4-48e5-ad46-866dba0ed358-v1`: all five durable receipts
  succeeded once at attempt 1, reconciliation reached ready, and its lease was
  removed. Hybrid recall returned the unique fact with filename and exact
  document citation. Identical replay returned 409 for the same job/checksum
  without a second parse or dispatch.
- The canary produced evidence but zero promoted memories, reported through the
  existing `extraction_yield_zero` reason. The real promotion checkpoint
  succeeded and source-backed recall was proven; this is not represented as a
  positive memory-yield test.
- The accepted document, failed-canary orphan, and all associated R2 objects
  were deleted and verified absent. Flagship was restored globally off after
  the latched job completed; operator and unrelated contexts evaluate off.
- Direct Cloudflare Gemini multimodal REST verification returned 200. Public
  health and fresh critical-log scans passed. No customer artifact, email, or
  other external side effect was produced.
- Rollback: keep the flag off; Core
  `e2e2c055e56ed7d8a18bb7a0b099503f987b9f6a`; Worker
  `d917d0a1-38fe-4933-a4eb-34bcb891c625`; verified database backups are in the
  production release ledger.

## 2026-08-31 UTC — Knowledge ingestion v2 enabled globally

- Explicit operator authorization promoted only Flagship
  `knowledge_ingest_workflow_v1`. A precondition GET captured the entire
  rollback definition before mutation. Default and the two production rules
  now serve `on`; conditions, priorities, local behavior, variations,
  description, and enabled state are unchanged.
- CLI and bound-Worker evaluations passed for both prior production targets and
  two unrelated synthetic contexts; local targeting also remained on. Runtime
  image/version/start-time checks, API/home health, and critical logs passed.
- This was a flag-only promotion: no build, restart, deployment, upload,
  customer content, or external delivery occurred. Rollback is the captured
  full definition with default and production priorities 2/3 restored to off.

## 2026-08-31 UTC — HyperAgent GPT-OSS 20B Bedrock-first routing

- Session branch `codex/prod-hyper-gptoss-routing` replaced the obsolete
  Novita-only pin for `openai/gpt-oss-20b:nitro` with OpenRouter endpoint order
  `amazon-bedrock`, `amazon-bedrock/eu-west-1`, `groq`, then `together`.
  Calls remain behind Cloudflare AI Gateway with cross-provider fallback.
- Focused Python 3.12 tests passed 11/11. A pre-release live Gateway probe
  returned HTTP 200 from Amazon Bedrock.
- Canonical SHA `97afbd87760771789b5a8adab651027dd18d51a1` was released through
  the governor. Core, Control, and Employees are healthy at that revision; no
  migrations were pending. The deployed HyperAgent transport returned choices
  from Amazon Bedrock, public API health passed, and fresh critical logs were
  empty.
- This changes provider routing only. Gemini planner targeting and the
  Grok-style runtime rollout state are unchanged.

## 2026-08-31 UTC — durable ingestion stage pipeline and global rollout

- Runtime evidence showed that Cloudflare Queue admission was capped at one
  consumer and Core held an extract lease across parsing plus evidence
  embedding. A burst therefore left later documents at `queued` even while the
  server had capacity for a different stage.
- Canonical commit `22f549a3c300cf46c3bcb0ed412ff85cadd61e4e`
  pipelines independent extract, embed, promote, and project/reconcile capacity.
  Queue consumer concurrency is 5; Core remains protected by per-stage global
  and tenant caps. PostgreSQL's transaction-scoped advisory lock is the only
  slot mutex; redundant Serializable isolation was removed after a live burst
  reproduced write-conflict retries.
- Verification passed 48 focused Core tests, Worker typecheck, 5 Worker tests,
  and a production Wrangler dry-run. Two production three-PDF bursts completed
  all six jobs. The accepted burst visibly overlapped parsing, embedding, and
  memory generation; all checkpoints completed on attempt 1, fresh slot
  conflicts were 0, and fresh fatal errors were 0.
- Core is healthy at the exact revision above. Worker deployment
  `9225e2b9e0884df5ba44cbba3d76b3ee`, Workflow version
  `ab5db32d-d295-43c3-8dc3-47f6ce6c6664`, and Queue consumer
  `55511ec7533d45f7a9fc4e96458c5250` are active. Flagship
  `knowledge_ingest_workflow_v1` now serves `on` by default and every retained
  production rule also serves `on`; the Core environment gate remains the kill
  switch.
- Retained image incident jobs `73477d60-f51b-40f0-a3e0-305a977f5ddb` and
  `96892760-0026-4401-91c0-48e358f15dfa` were replayed from their existing R2
  sources as processing version 2. Both reached `ready` with exactly one
  canonical memory and no source re-upload.

## 2026-08-31 UTC — immediate durable ingestion dispatch

- Production inspection confirmed Cloudflare admission was healthy, but Core
  still serialized work at two internal boundaries: stage capacity waiters
  retried by time, and all PDF rasterization shared one process-wide slot.
- Canonical release `da923a8c9bae63b72d7d5fc70b707c91c011f548`
  replaces capacity polling with indexed durable FIFO checkpoint rows plus
  immediate release notifications. Extract, embed, promote, and project pools
  remain independently tenant-bounded. Scheduler transactions contain only an
  advisory lock, bounded lease rows, and one indexed queue-head lookup.
- The stale reconciler now uses current processing-version checkpoints,
  `updated_at`, unexpired leases, and authoritative Cloudflare Workflow state.
  A status-service outage is never interpreted as a dead Workflow.
- Text-native PDFs continue to skip vision. Visual-page rendering uses a
  bounded pool of two and Gemini 2.5 Flash Lite through AI Gateway
  `hivemind-prod`; successful pages survive isolated provider failures.
- Verification: 54 focused Core tests, 44 final scheduler/client/stale/vision
  tests, valid Prisma schema, one Da-vinci image-upload regression, and a full
  Da-vinci production build. Migration
  `20260831224000_ingest_stage_wait_queue` applied successfully.
- Production canary `42fea1d8-c269-41d1-8bd9-36dcfaf4bc71` used
  `cloudflare_workflow`, reached `ready` with one segment and three canonical
  memories, and every checkpoint succeeded at attempt 1. Extract→embed handoff
  was 4 ms and embed→promote handoff was 3 ms. Fresh critical logs were empty.

## 2026-08-31 UTC - ingestion throughput final acceptance and incident repair

- Canonical `e9fca76f6e8d66398d195f87d431645a56b1b058` released only the
  affected Core, Da-vinci frontend, and knowledge-ingest Worker. Exact live
  versions, migration, backups, rollback artifacts, and acceptance evidence are
  recorded at the top of `docs/PRODUCTION_RELEASE.md`.
- The first recorded operator target had been deleted; its canary stopped on an
  API-key foreign-key constraint before admission. The alternate established
  controlled target was verified present. An eight-document text burst first
  proved the per-org cap and 360/360 vector completion. The final required
  four-PDF run then passed every ingestion, receipt, billing, vector, recall,
  and cleanup gate. One harness-only receipt model typo and one single-file
  minimum-count assertion were corrected in disposable acceptance tooling;
  neither failure was in production code and both `finally` cleanup paths ran.
- Vision route verification read only presence/configuration, never tokens:
  Cloudflare account and token are present, gateway is `hivemind-prod`, and
  model is `google/gemini-2.5-flash-lite`. A live multimodal request returned
  200 with output. The parser converts provider failures to control-plane errors
  and the canonical boundary rejects historical provider-payment text.
- The two incident jobs had already completed immutable v1 materialization but
  their released reservations made old Workflow reconcile retries fail. After
  a fresh full backup, the exact released reservations were revived, job states
  were resumed at `reconciling`, and the existing v1 reconcile receipts were
  completed. Document IDs, segment counts, vector counts, and materialize
  attempts did not change. One old Workflow observed the receipt and completed;
  the other stale exponential-backoff instance was terminated after terminal
  database and billing verification.
- At `2026-08-31T20:30:08.888Z`, explicit operator authorization promoted the
  full preserved Flagship definition to default/global `on`. An unrelated
  context evaluated `on/DEFAULT`, and a post-global PDF smoke passed. Rollback
  is the captured full definition with only default and production rule outputs
  restored to `off`; the backend master gate is unchanged.
## 2026-09-01 UTC — Runtime and Social frontend access enabled globally

- Production inspection found that backend Runtime and organic campaign
  capabilities were globally enabled, but Da-vinci still intercepted Runtime
  navigation with `RuntimeWaitlistModal`, rewrote direct Runtime URLs to the
  company dashboard, and sent Social navigation to a coming-soon modal.
- Da-vinci commit `b231ec8350e97edba162358f2c7d5c273124a672` removes those
  presentation-only gates. Runtime now opens `/employees/runtime`, while Run
  your Social Media opens `/employees/campaigns`, for every authenticated
  workspace. Parent release declaration
  `2ea1d984a45d03d2c2a58cdcf741e0ed4c3674cf` advances the frontend gitlink.
- Focused contract tests passed 2/2 and the Cloudflare production build
  completed successfully. Cloudflare Worker version
  `d5c1c0f8-034b-4966-a9a1-35aadc9f2300` is deployed on
  `next.singulancelabs.com`.
- Live verification returned HTTP 200 for the Runtime deep link and loaded
  `main.ee8121ef.js` plus `8810.e05cca62.chunk.js`; the deployed HyperAgents
  chunk contains neither the early-access CTA nor either coming-soon string.
  No backend container, database, migration, or tenant data changed.
## 2026-09-01 UTC — targeted post-onboarding Runtime introduction

- The live post-onboarding Runtime introduction in `CompanyDashboard` remained
  disabled at its `HyperAgents` call site after Runtime itself became globally
  routable. Da-vinci `40c7747bfb3db5106609ab1a4d5a961e1d9378ef`
  enables the introduction only when both requested viewer identifiers match:
  user `b457c254-38a0-4c43-8280-b026f1a78b04` and organization
  `f0cb77ef-e62b-4f8c-a1da-066611fc3b36`.
- The introduction uses a versioned one-time browser receipt and its successful
  action opens the live Runtime route. It does not restore the waitlist or
  restrict Runtime access for any other user.
- Four focused access/targeting tests passed and the production bundle built.
  Cloudflare Worker `e85c67ef-0f25-4a92-9bb3-a7f091894835` is live; its served
  HyperAgents asset contains the exact target, introduction, and version marker,
  contains no early-access CTA, and the company route returned HTTP 200.

## 2026-09-02 UTC — Day 1 research lifecycle recovery and onboarding contract

- Committed and released `bd01edd9ebe0bced647d1951abb8b07e37acf06f` from
  `singulance-main`. Focused command:
  `node --test tests/unit/day1-first-move.test.mjs` — **15 passed, 0 failed**;
  syntax checks for the Control Plane and lifecycle module plus `git diff --check`
  were clean before release.
- Root cause: Day 1 only accepted `todo` research tasks. A valid first-life
  research task that was already active with a sealed report was rejected as
  `day1_research_task_not_found`, despite being the report Day 1 was meant to
  deliver.
- Fix: prefer the deterministic website-onboarding competitor/local-market
  task, otherwise adopt the existing active/done research room and its latest
  turn. A new Day 1 launch includes the saved company HQ / operating location
  in both the room goal and kickoff message.
- Production verification: governed release rebuilt `core`, `control-plane`,
  and `employees` at immutable `sha-bd01edd9`; all three reported healthy.
  The affected lifecycle recovery returned `completed` for the existing sealed
  turn, and the idempotent delivery endpoint accepted exactly one Cloudflare
  Email Service send. The queued Cloudflare retry may later observe the stored
  `sent` receipt but cannot duplicate delivery.

## 2026-09-02 UTC — reusable lifecycle Queue admission released

- Committed and released `69c46eaed2c35014c58aae2fb653f0487e3d5d82` from
  `singulance-main`; Cloudflare Worker version
  `ed9b1a9e-fbe0-49da-b777-20141915ccb4` provisioned
  `hivemind-lifecycle-admission-v1` and its DLQ.
- Verification: `node --test tests/unit/day1-first-move.test.mjs` — **16
  passed, 0 failed**; Control Plane and lifecycle syntax checks clean;
  Worker TypeScript check and `wrangler deploy --dry-run` passed.
- Operational contract: due lifecycle work enters the Queue with identifiers
  only, the consumer processes at most ten launch invocations concurrently,
  each message has explicit ack/retry/DLQ behavior, and the five-minute
  reconciliation admits up to 500 persisted receipts. A failed completion
  event re-admits the receipt rather than assuming a Workflow restart is proof
  of delivery.
- Production smoke: an existing already-sent receipt returned `202 admitted`
  through the Worker and remained `sent` on the idempotent Control Plane read;
  no duplicate room task or email occurred. All three coupled runtime services
  are healthy at `sha-69c46eae`; fresh fatal-error scan was empty.

## 2026-09-02 UTC — Knowledge Base browser admission limits released

- Frontend `main` SHA `0bac95492a2e6f3e8ea6b77e26c4902f19c9acbf`; parent
  release declaration `c46ebeac65159318b62cf9f287ffdc32ea84f302`.
- Cloudflare Worker `hivemind-web` version
  `764cc740-78f2-4a64-b561-6c11087e9dab` was deployed with
  `--keep-vars`; no backend service, flag, database, or Cloudflare binding was
  changed.
- Knowledge Base now accepts individual files only, rejects files above 10 MB
  before the scope dialog, and rejects PDFs with unreadable page counts or more
  than 100 pages. The final browser-side network boundary repeats the check.
- Verification: JSX syntax parse, Cloudflare Worker asset/discovery tests,
  guarded Wrangler dry-run/build, public Knowledge Base route HTTP 200, and
  live lazy-bundle marker verification. The legacy folder picker marker is
  absent from the live chunk.
- Rollback: Cloudflare Worker version
  `6fd6b92c-90fd-408e-8844-498f4ed7b371`.

## 2026-09-02 UTC — Day 2 Visual Intelligence callback and capture recovery

- Committed release chain: `7bb6e1d28568a793436747729edf23d354c2e4b9`,
  `3cc46b8acca2ecae663db3df3332a39b34867432`, and
  `6b7979e297f41396f4d29aae8e85f3b319f20429`. The Worker is version
  `06a498c5-8add-435e-b372-8ee0fffdfb57`; governed coupled services run
  immutable `sha-6b7979e2` images.
- The Worker now calls TLS-valid `core.singulancelabs.com` through its dedicated
  service credential. It skips crawler rows lacking a screenshot receipt, but
  fails retryably when no verified visual receipt remains. Failed Day 2 runs
  release only their matching room scheduling claim.
- Verification: focused Core tests passed 4/4; Worker tests passed 2/2; Wrangler
  dry-run passed. The authorized E2E canary completed all eight persisted stages,
  stored one protected rendered report, created a workspace notification, and
  obtained a delivered Cloudflare Email Service receipt. Fresh Core fatal/panic/
  uncaught/OOM/migration scan was empty.

## 2026-09-03 UTC — Day 2 evidence-quality gate and report recovery

- Committed and released `05c9b3ba16db9cfe6a1b3b5fb192fd79e1ddae04` and
  `04400290ecc8101beaecdbe658e89697e97648d2` from `singulance-main`. Core runs
  immutable `hivemind/core-api:sha-04400290`; the coupled Playwright runtime runs
  `hivemind/hm-playwright:sha-05c9b3ba`; the visual-intelligence Worker is version
  `d7f14982-4ee2-4b44-8d0b-82768fe7f109`.
- The capture policy now preserves a screenshot receipt for every accepted page,
  requires at least three verified visual receipts, and allows only the root
  hostname plus its subdomains. A shallow or invalid structured extraction no
  longer publishes a customer report. Complete capture can use the bounded,
  evidence-derived repair path when a model omits a non-semantic response field;
  the path is marked in the artifact rather than treated as an unverified model
  success.
- Verification: `node --test core/tests/unit/playwright-service-runtime.test.js
  core/tests/unit/durable-visual-intelligence.test.js` — **8 passed, 0 failed**;
  Worker tests — **2 passed, 0 failed**; Worker Wrangler dry-run passed. A live
  production crawl captured **16/16** screenshot receipts, including the approved
  `next.singulancelabs.com` subdomain. The authorized Day 2 recovery run completed
  all eight persisted stages, stored 16 source receipts and a protected rendered
  report, created the workspace notification, and completed its idempotent
  notification stage.

## 2026-09-03 UTC — Day 2 editorial report and delivery alignment

- Committed and released `f0bbbf260985d10bbbee98903e52a39385568f3b` and
  `110bb69801c1bb96d005bafa83369aba76969ce3` from `singulance-main`; Core is
  healthy on immutable `hivemind/core-api:sha-110bb698`, Playwright remains on
  the compatible `hivemind/hm-playwright:sha-f0bbbf26`, and the Worker is version
  `624c959c-4f37-453d-a081-825be58090e1`.
- Day 2 now retains the existing Singulance/Day label and Humation header, then
  uses the shared editorial Brand-DNA structure: visual screenshot reference,
  palette and typography cards, composition and voice cards, one reusable
  creative brief, and the source ledger. The report agent strip uses the public,
  cache-versioned Humation avatar contract. Customer logo capture has broader
  safe DOM selectors and falls back to a customer wordmark when a standalone
  mark is not present.
- The delivery email mirrors that editorial card order after the lifecycle
  header. Its PDF attachment now renders the protected, evidence-rich Day 2
  report (including the screenshot mosaic) rather than the legacy text-only
  portrait; temporary artifact-read failure safely falls back to the proven
  lifecycle PDF without failing delivery.
- Verification: Day-1 lifecycle + visual intelligence focused unit suite —
  **24 passed, 0 failed**; JavaScript syntax and `git diff --check` passed.
  The governed Core-only release completed healthy, and a fresh fatal/panic/
  uncaught/OOM/migration scan returned no findings.

## 2026-09-03 UTC — Day 2 reusable lifecycle contract

- Committed and released `3368591bef6c37514a70f458fc302b5afb520a38` and
  `fbe770a059beb80b7738a4e15352d6708694673e` from `singulance-main`; Core is
  healthy on immutable `hivemind/core-api:sha-fbe770a0`.
- Day 2 is formally an independent durable Brand-DNA workflow: it does not
  create a Room task or prompt. When admitted as lifecycle Day 2 it requires a
  same-tenant Room reference only for company, recipient, and Humation context;
  the reference is ownership-validated. The completed artifact is explicitly
  reusable as `company_brand_dna` for visual artifacts, brand intelligence, and
  HyperAgent context.
- Verification: focused Day-1/visual suite — **22 passed, 0 failed**; a B&B
  no-email canary completed every durable stage with 16 visual receipts.
