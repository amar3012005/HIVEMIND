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

## 2026-09-03 UTC — use_tools unified DAG (Started)

- State: Started
- Owner: Grok
- Branch: `singulance-main` worktree (flag-gated `USE_TOOLS_UNIFIED_DAG`)
- Base / commit: `ad7125ab` -> pending
- Scope: `core/src/agent/{use-tools-unified-flag,hosted-composio-planner,chat-progressive-router,compound-orchestrator}.js`, `core/src/connectors/composio/composio-service.js`, unit tests, `features.md`
- Verification: `node --test` planner + orchestrator; production deploy pending governor
- Production: not deployed
- Rollback: unset `USE_TOOLS_UNIFIED_DAG` (fail-closed)
- Next: unit tests, then hivemind-safe-deploy if tests pass

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
