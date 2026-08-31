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

## 2026-08-29 UTC — `singulance-local` integration line established

- State: Committed; local integration branch created; production unchanged.
- Branch: `singulance-local`, permanently checked out at
  `C:\Users\AMAR\Documents\ChatGPT\HIVEMIND-local-main`.
- Commits: `0dc20707` established the protocol; merge `b476710a` integrated the
  already-tested `codex/local-preview-setup` history.
- Decision: `singulance-main` remains production truth. Production flows into
  `singulance-local`; private session branches rebase on `singulance-local` and
  merge serially through the clean permanent worktree. The shared local branch
  is never rebased, force-pushed, or deployed to production.
- Verification: `git diff --check` passed; `node --check` passed for
  `core/src/control-plane-server.js` and `core/src/email/email-service.js`.
  The currently deployed local control-plane contains the integrated preview
  source, is healthy, and the public preview email-auth request returned HTTP
  202 with correct CORS and successful email-gateway acceptance.
- Docker finding: a canonical-worktree image rebuild reached the final image
  permission layer but stalled after Docker reported a missing BuildKit
  snapshot while calculating cache usage. The build was interrupted without
  replacing the healthy running container. No Docker cache was deleted because
  destructive cache cleanup was not required to establish the branch.
- Production: no production branch, server, container, Worker, DNS record, or
  customer data changed.

## 2026-08-29 UTC — Day 1 Cloudflare Workflow local-cloud canary passed

- State: Committed and locally accepted; not production-released.
- Branch/commit: `codex/d1-workflow-production` at pushed SHA `ceb9beed`.
- Feature control: isolated Flagship app `hivemind-local-development`; production
  Flagship configuration was not changed. Backend remains fail-closed behind
  `HIVEMIND_D1_WORKFLOW_ENABLED=true` in the local-only Compose overlay.
- Real E2E evidence: Workflow instance
  `d1-local7-251af4c6-7ea0-4e44-9fe1-4074028bf3b2` reused room
  `daa06ae7-fe9e-4798-bea1-a0d886de64a3` and sealed turn
  `3cd03bde-b9e0-43a7-9f54-e7c2b06cac76`; it rendered through the canonical
  Day 0 `hm-playwright /v1/pdf` path and Cloudflare Email accepted delivery.
  Evidence hash `3e4912694bd0a7987b5d0cbd07b32a53ad31a7ce798258f7cd79465feef90c04`,
  length 4,831 bytes. A repeated deterministic start returned the completed
  instance and same provider receipt; it created no duplicate delivery.
- Verification: `node --test core/tests/unit/day1-first-move.test.mjs` passed
  9/9; Worker `npm run check` passed; merged local Compose configuration passed
  `docker compose ... config --quiet`.
- Local iteration rule: Core source is bind-mounted into the uniquely named
  Day 1 control-plane image, so ordinary JS changes use `docker compose up -d
  --no-deps --force-recreate control-plane` without rebuilding. Rebuild only
  when dependencies, Dockerfile, native modules, or build artifacts change.
- Production rule: rebase onto current `origin/singulance-main`, pass the
  production protocols/governor, then run one controlled canary before calling
  this feature production-accepted.

## 2026-08-29 UTC — reusable lifecycle email/PDF renderer visually accepted

- State: Committed and locally accepted; not production-released.
- Branch/commits: `codex/d1-workflow-production` at pushed SHAs `98d8bb92`
  (renderer), `43131bba` (mobile/logo hardening), and `1274e12e` (shared
  lifecycle-email robustness contract).
- Rendering contract: Day 1 now wraps reusable lifecycle-completion email and
  portrait-report renderers. Pipe tables are semantic and aligned; long cells,
  code, and URLs wrap; unsafe HTML remains escaped; UTF-8 content is preserved.
- Identity: persisted company-team IDs deterministically produce the exact
  Humation characters used by Day 0. Email uses the public SVG endpoint; PDF
  embeds the same generated SVG directly. Names and roles appear in the hero.
- Visual verification: the canonical local `hm-playwright /v1/pdf` renderer
  produced a one-page A4 QA report with no clipping or orphan page. Latin,
  Japanese, Indic, Arabic, currency, symbols, and emoji rendered; a four-column
  table remained legible; the long URL wrapped; all four portraits rendered.
- Mobile/logo verification: email CSS includes 620px and 360px breakpoints for
  compact typography, portraits, and table cells, with safe wrapping plus
  horizontal touch scrolling where supported. The canonical logo PNG returned
  HTTP 200 as `image/png`; tests also require the email PNG URL and the PDF's
  inline Singulance mark.
- Automated verification: `node --test tests/unit/day1-first-move.test.mjs`
  passed 10/10. A fresh Node import inside `hivemind-control-plane-local`
  confirmed `{table:true, avatar:true, unicode:true}` against the bind-mounted
  production module. The preview avatar endpoint returned HTTP 200 SVG.
- Reuse rule: future lifecycle episodes must call the shared completion
  renderers with episode metadata, sealed output, destination URL, and
  participating characters. They must not fork the parser or PDF service.
  Mobile, Unicode, image, table, character, and logo resilience is centralized
  in `lifecycleEmailShell`/`lifecycleRichContentStyles`; it is not Day-1 CSS.

## 2026-08-29 UTC — Day 1 lifecycle integrated into `singulance-local`

- State: Locally integrated and validated; production unchanged.
- Source: pushed session branch `codex/d1-workflow-production` through
  `66787f09`; merge commit `0ee092bd` in the permanent clean
  `HIVEMIND-local-main` integration worktree.
- Conflict resolution: preserved both the existing Cloudflare Agent Memory and
  local-integration journal history and the Day 1 lifecycle history; combined
  all ignored local artifact patterns without dropping either side.
- Merged-state verification: Day 1 unit suite passed 11/11; Worker TypeScript
  check passed; the three-file local Compose configuration passed `config
  --quiet` after ignored local environment files were copied into the clean
  integration worktree without displaying or committing secrets.
- Policy recorded: Day 3 is a versioned data-defined growth-experiment episode;
  shared local Docker and preview Cloudflare deployments originate only from
  `singulance-local`. Production remains exclusively `singulance-main` via the
  production release protocol and deployment governor.
- Local deployment: recreated only `hivemind-control-plane-local` with the
  existing image and no build. Its `/app/src` bind mount now resolves to the
  permanent `HIVEMIND-local-main` worktree, health returned `ok`, and an in-
  container render check returned
  `{shared:true,mobile:true,logo:true,table:true}`. Commit `e2ae0741` adds the
  missing `HIVEMIND_ADMIN_SECRET` Compose mapping; a random local-only value is
  stored in the Windows user environment and is neither printed nor committed.
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

## 2026-08-30 UTC — public AI discovery policy integrated locally

- State: committed local integration; production unchanged.
- Branch/worktree: `codex/ai-crawl-visibility-local` in
  `C:\Users\AMAR\Documents\ChatGPT\HIVEMIND-ai-crawl-visibility-local`,
  integrated serially in the permanent
  `C:\Users\AMAR\Documents\ChatGPT\HIVEMIND-local-main` worktree.
- Source: parent candidate `7f23ecd5402a5ad0a45752ccfc87ae505ad9be82` and
  frontend source `880962c7215732d004c6abb21b9fcc81bdd48ed0`. This adds public
  AI discovery files and prevents them from being served on private hosts.
- Merged-state verification: `npm run test:ai-discovery` passed 3/3. The full
  CRA build passed earlier on the same immutable frontend SHA. No shared Docker
  service was rebuilt or recreated.
- Safety decision: public pages remain discoverable while training/fine-tuning
  is disallowed by content signals and private hosts are `noindex`. A Cloudflare
  crawler guard remains deferred until production Worker verification.
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

## 2026-08-30 UTC — canonical ingestion merged-state acceptance

- State: feature commit `58ec7ff8` and merge candidate `42d2bcc0` were pushed
  on `codex/knowledge-ingest-workflow-v1` from
  `P:\HIVEMIND-worktrees\knowledge-ingest-workflow-v1`. The candidate contains
  the latest `origin/singulance-local` (`5e602f95`) and leaves production
  unchanged.
- Merged verification: the backend ingestion/Gateway/Dreaming suite passed
  138/138; Da-vinci AI-discovery tests passed 3/3 and its optimized build
  compiled; Prisma schema validation passed; local PostgreSQL exposes both
  `cognition_steps` and `knowledge_ingest_steps`, including the fenced
  `lease_token` column.
- Runtime verification: the local control plane was restarted after the merge
  and reported healthy with scheduler and playbooks ready. The isolated
  BuildKit builder produced the feature image; a final merged image build was
  started from the merged checkout so the shared local runtime can include both
  durable ingestion and durable Dreaming without overwriting either feature.
- Final local runtime: image
  `sha256:daab197a497e5a33d2d1924bd3ccc6d78e07411e02bd4ca8fe8a0c673770cc8d`
  is running healthy with PostgreSQL and Qdrant ready, Cloudflare Workflow and
  AI Gateway gates enabled, and both merged lifecycle modules present. The
  existing Paolo canary retains all ten successful checkpoint receipts.
- Startup hardening: the merged server correctly failed closed when the local
  Compose service omitted its OAuth session-signing secret. The Compose contract
  now forwards `HIVEMIND_OAUTH_SESSION_SECRET` from process or local env; a new
  random local-only value was injected at runtime, never printed, persisted, or
  committed. API and control-plane health passed after recreation.
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

## 2026-08-31 — Grok HyperAgents production-current local candidate

### Committed candidate

- Merged current `origin/singulance-main` (`c561f75c`) into a fresh branch from
  `origin/singulance-local`, then applied the complete runtime as candidate
  `962d57c3` on `codex/grok-hyperagents-integrated`.
- Integrated and pushed Da-vinci commit `f47d945` on
  `codex/grok-hyperagents-ui-integrated`; the parent gitlink points only to that
  pushed commit.
- The flag remains fail-closed and unenabled. No local shared container,
  Cloudflare resource, Flagship targeting, or production service was changed.

### Verification

```text
Prisma validate/generate: passed
Core syntax + runtime/HyperRoom routes: 7 passed
Employees changed-file Python compilation: passed
Worker TypeScript: passed
Worker contract tests: 5 passed
Wrangler local dry-run with Browser/Sandbox: passed
Sandbox next-python image build: passed
Integrated Da-vinci optimized build: compiled successfully
```

## 2026-08-31 — Grok HyperAgents accepted in local full-mode canary

### Committed

- Runtime integration and local wiring were committed on `singulance-local` as
  `e4c1983f4cc8cdf6eeb47b3be0eab38b6180f626`.
- The change fixes Director propagation of the latched runtime mode and real-agent
  hook, roster matching across lanes and role archetypes, Cloudflare AI Gateway
  BYOK headers for AgentScope, isolated Browser tool registration, and local
  service-to-service Employees routing.
- The checked-in additive Grok runtime migrations were applied to the existing
  local database. `prisma migrate deploy` could not baseline that pre-existing
  schema (`P3005`), so only the two reviewed migration SQL files were applied;
  production was not touched.

### Local Cloudflare acceptance

- Flagship flag `hyperagents_grok_agents_v1` has all cumulative modes from `off`
  through `full`. Its default is `off`; only local canary org
  `47e2ba84-1b9f-4e1b-804b-7bd77d4eea0f` and user
  `3b56a01a-7caf-4348-964a-566f52d8c437` resolve to `full` when
  `environment=local`. An unknown identity resolved to `off`.
- Local Worker resources are `hivemind-hyperagents-grok-local`, Room Workflow
  `hivemind-hyper-room-run-local`, assignment Workflow
  `hivemind-hyper-agent-assignment-local`, and sandbox container
  `hivemind-hyperagents-grok-local-sandbox-local`.
- Final turn `4bc77624-17da-444b-9619-a6cd2fb467b1`, Workflow
  `room-4bc77624-17da-444b-9619-a6cd2fb467b1-v1`, reached PostgreSQL status
  `complete` and phase `SEALED`. Two WorkOrders and two WorkResults completed.
  Assignment Workflows `agent-b2d214dc-2db5-4e6e-a07d-ee44c0182f25-v1` and
  `agent-78d747d3-90af-44e9-b9a7-174bf05ab861-v1` completed. A transient Room
  execute timeout retried and reused the terminal state without duplicate work.
- The direct Cloudflare Browser canary returned HTTP success, an isolated session,
  title `Example Domain`, the expected URL, and rendered text. Local model and
  embedding requests used production-equivalent Cloudflare Gateway/provider
  routing, but credentials were not written to Git or this journal.

### Verification

```text
workers/hyperagents-grok-local: 1 test file, 5 tests passed
Employees focused suite: 39 passed in 2.90s
API health: http://localhost:3000/health 200
Control health: http://localhost:3001/health 200
Employees health: http://localhost:8060/health 200
Authenticated recall: 1 memory + 2 evidence
git diff --check: passed (line-ending warnings only)
```

### Release boundary and rollback

- This is a local acceptance only. No production service, production flag target,
  production database, or `singulance-main` branch was changed.
- Rollback is to remove the local targeting rule or resolve the flag to `off`;
  flag-off turns remain byte-compatible with the existing runtime.
- Cloudflare Agent Memory was unavailable in this session, so this evidence is
  recorded in Git and must be mirrored to Agent Memory after service recovery.

## 2026-08-31 — Grok HyperAgents enabled for every local user

- Updated Flagship rule priority 1 for `hyperagents_grok_agents_v1` from the
  original canary org/user conjunction to the single condition
  `environment equals "local"`, serving variation `full`.
- The flag's default variation remains `off`; no unconditional or production
  targeting rule exists.
- Independent evaluation using arbitrary org/user context returned `full` with
  reason `TARGETING_MATCH` for `environment=local`, and returned `off` with
  reason `DEFAULT` for `environment=production`.
- Rollback remains deleting priority rule 1 or changing its served variation to
  `off`. This was a Flagship targeting change only; no service was rebuilt and
  no production deployment occurred.

## 2026-08-31 — Local branding artifact admission restored

- A local branding Room failed before agent work with
  `visual_artifact_path_disabled`: execution profile `branding.artifact.v1`
  required `branding_artifact`, while the Employees container lacked the
  independent visual-path environment switch.
- Commit `83f57630e6fa400b2d8ac547e42d3715772a65c3` defaults
  `VISUAL_PATH_IN_HYPERROOMS=true` only in the shared local Compose overlay.
- Recreated only `hivemind-employees-local`; no image rebuild or other service
  recreation was performed. Runtime inspection returned
  `visual_path_enabled=true`, `_visual_artifacts_enabled()=True`, and Employees
  health HTTP 200.
- The application image does not include pytest, and the host Python lacks the
  service dependency set, so those two attempted focused-test commands were
  environment-invalid rather than test failures. Existing artifact-path tests
  remain unchanged; the deployed runtime gate itself was directly verified.
- Production configuration and targeting were not changed. Rollback is setting
  `VISUAL_PATH_IN_HYPERROOMS=false` in the local environment and recreating only
  Employees.

## 2026-08-31 — Local governed model configuration restored

- The next branding retry passed artifact admission but returned no answer because
  the Employees-only recreation had discarded previously process-injected AI
  Gateway variables. Logs showed `no governed model provider configured`, followed
  by a verifier `NoneType.get` error.
- Restored the same governed Cloudflare AI Gateway configuration used by production
  into the local Employees process without printing or persisting secret values.
  A direct model probe returned a valid choices object; the renderer gate remained
  enabled and Employees health returned HTTP 200.
- Added `scripts/recreate-local-employees-production-parity.ps1` so future
  Employees-only recreations securely load only the approved provider variables
  through `ssh singulance`, recreate only Employees, verify health, and erase the
  variables from the calling process afterward.
- The verifier now turns an absent provider response into the explicit error
  `governed verifier model returned no response` rather than leaking an internal
  `NoneType.get` exception into the Room result.

## 2026-08-31 — Full-mode Rooms no longer escape into legacy debate

- Root cause: the admitted turns correctly latched `grok_runtime_mode=full` and
  started the Room Workflow, but a planner response with no work orders could
  still enter the historical lead-agent/debate path. The visible discussion was
  therefore legacy behavior despite a correct Flagship decision.
- Commit `7fd1fc86e94dcb17304a8894c2a5fee3b2038e4e` normalizes missing planner
  modes, creates a domain-neutral durable assignment when a task omits work
  orders, converts planner assignments to dependency-aware steps, and replaces
  requested/profile-mandated debate with an independent reviewer assignment.
- Every real agent receives the original Room request plus its bounded WorkOrder.
  Evidence-required assignments receive one bounded repair attempt and fail
  explicitly when no verified tool receipt exists; prose can no longer masquerade
  as execution evidence.
- Cloudflare Browser registration is idempotent for cached employee toolkits.
  Browser calls now write assignment-scoped receipts containing adapter, session,
  URL, title, rendered-text excerpt, and Live View reference. Receipts are
  persisted in `HyperWorkResult.evidence` and included in downstream review and
  synthesis context.

### Live local evidence

- Reproduced the user's exact browser-pricing task under full mode. Canary turn
  `3777124a-6237-4b82-b56f-77cdecfdb48b` produced four persisted WorkOrders
  (three bounded execution steps plus an independent reviewer), each with stable
  agent/workflow identities. This proved the legacy debate escape was closed.
- Final receipt-enforcement canary `60918052-947c-40f7-8f4f-5db661b6e662`
  executed Cloudflare Browser successfully against three public pages and stored
  three Browser evidence receipts on the execution result. A dependent Priya
  reviewer assignment also completed with persisted evidence.
- The final canary correctly remained `blocked`: Browser supplied rendered-text
  evidence, not screenshots, and two selected pages did not yield comparable
  official pricing. The verifier also rejected unsupported numbers. This is a
  truthful task-level evidence gap, not a runtime fallback or missing tool.
- Python AST parsing passed for all three changed runtime modules; Employees
  health remained HTTP 200. Production was not changed.

## 2026-08-31 — Local Grok Room browser evidence and synthesis repair

- Fixed a terminal crash where a legacy Boolean `dead_end` marker was treated as
  an object (`AttributeError: 'bool' object has no attribute 'get'`). New durable
  failures persist a structured reason/gap payload; the renderer remains backward
  compatible with old Boolean rows. Commit `3e199550`.
- Fixed local production-parity model routing. The Employees Compose service now
  forwards the governed HyperAgent/LLM/LiteLLM policy variables while retaining
  local PostgreSQL, Redis, Core, Control Plane, and tenant data. Cloudflare AI
  Gateway activation and model-policy parity were verified without printing or
  persisting secrets. Commits `4f82c987` and `66b7fd39`.
- Browser receipts are now deduplicated by canonical URL, newest successful
  observations supersede older blocked/404 observations for synthesis, and the
  complete bounded receipt set is protected from mid-source truncation. The
  subject company cannot count as one of its own competitors in repair, review,
  or final synthesis. Commit `4004519d`.
- Durable agent execution now serializes provider-heavy assignments by default,
  retries only the retryable OpenRouter in-flight-budget condition with bounded
  backoff, and caps AgentScope completion reservations at 4,096 tokens instead of
  its 64,000-token default. Commits `6b37efce`, `d2efc8bf`, `d3212cf6`, and
  `d112a63b`.

### Verification evidence

- `python -m py_compile` passed for the changed Room engine, Room API, and
  AgentScope factory modules.
- In-container regression probes passed for Boolean/structured dead-end rendering,
  newest-per-URL receipt selection, preservation of three bounded receipt sources,
  Cloudflare AI Gateway activation, and `max_tokens=4096`.
- Exact-prompt canary `f8a2a24f-6c8b-45d0-89ba-76d2624d72db` completed real
  Cloudflare Browser assignments plus independent review. Its final verifier
  correctly blocked unsupported price/performance claims instead of showing a
  false green result.
- Exact-prompt canary `acf42bec-1472-4a87-a694-2c74b6eac1f0` proved the reviewer
  rejects the subject company (Apple) as its own competitor, catches invalid dates,
  and requests exact SKU evidence.
- Final canary execution was blocked externally after OpenRouter reported genuine
  account credit exhaustion (`weight_exceeds_budget` / `openrouter_credits`). Two
  orphaned local assignments were cancelled and Employees returned healthy. No
  production deployment or configuration change was performed.
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

## 2026-08-31 — HyperAgent Workers AI GLM migration (local)

- Retired legacy `claude-haiku-*` participant settings from the HyperAgent model
  policy. They now resolve to Cloudflare Workers AI
  `@cf/zai-org/glm-5.3-flash` instead of OpenRouter.
- Added an authenticated Cloudflare AI Gateway compatibility target for Workers
  AI. The SDK sends `workers-ai/@cf/zai-org/glm-5.3-flash` through the configured
  account/gateway and fails closed when Gateway configuration is absent; it does
  not fall back to a direct provider or OpenRouter. Commit `141b8ea6`.

### Verification evidence

- `PYTHONPATH=src python -m pytest tests/test_ai_gateway.py -q` — `5 passed`.
- `python -m py_compile` passed for `ai_gateway.py`, `model_policy.py`, and
  `agentscope_factory.py`.
- A standalone model-policy probe confirmed both bare and Anthropic-prefixed
  Claude Haiku identifiers resolve to Workers AI GLM and do not require
  OpenRouter.
- Live inference remains pending because Docker Desktop is stopped and the local
  parity env file contains no Gateway credential. No secret was copied, printed,
  or committed, and production was not changed.

## 2026-08-31 — Workers AI GLM live canary

- Docker Desktop recovered with the complete local stack healthy. Using the
  already configured local Employees environment, the authenticated Cloudflare
  AI Gateway returned HTTP 200 from
  `workers-ai/@cf/zai-org/glm-5.3-flash` with the exact canary response.
- A required function-call probe returned exactly one structured
  `lookup_order` tool call with the requested `ABC-123` argument. This verifies
  the selected model's tool-calling surface through the same Gateway.
- The patched package was loaded under an isolated `/tmp/hm-glm-canary` path in
  the Employees container. `_resolve_model` converted a stored
  `claude-haiku-4-5` employee into an `OpenAIChatModel` targeting
  `workers-ai/@cf/zai-org/glm-5.3-flash`; an actual AgentScope SDK inference
  returned `AGENTSCOPE_GLM_OK`.
- The isolated canary did not alter the shared source bind, database, Room state,
  or production. Full Room Workflow/recovery acceptance still requires safe
  integration into `singulance-local`; the permanent integration worktree has
  unrelated uncommitted files and was intentionally not overwritten.

## 2026-08-31 — Grok HyperAgents realtime and bounded cognition (local candidate)

- Added a tenant-scoped Cloudflare `HyperRoomGateway` Agent. Core creates a
  short-lived HMAC-signed WebSocket ticket only after Room authorization; the
  frontend reconnects using fresh tickets while retaining SSE and database poll
  fallbacks.
- Extended persistent hired-Agent coordination state with bounded scalar
  preferences and recent completed assignment identifiers. Customer content and
  artifacts remain outside Cloudflare Agent state.
- Added a bounded LangGraph execute/self-check/repair loop for real-tool
  assignments. It deliberately has no checkpointer because Cloudflare Workflow
  and PostgreSQL remain the durability authorities.
- Replaced a competitor-pricing-specific repair prompt with a domain-neutral
  repair built from the original assignment and exact unmet predicates.
- Frontend commit `61d940ba7442e488948905f5b5429c7a9d115777` was pushed on
  `codex/grok-room-realtime-v1`.

### Verification evidence

- Worker `npm run check` passed; Vitest `5 passed`; Wrangler local dry-run
  listed both Agent bindings, both Workflows, Browser, Sandbox, and Flagship.
- Core runtime client tests: `4 passed`; changed JavaScript syntax checks passed.
- Employees ephemeral Python 3.12 test: `6 passed` for bounded LangGraph and
  Grok runtime suites.
- Da-vinci optimized build passed before the frontend commit.
- Local Cloudflare Worker deployed as version
  `3d2eac64-94ab-458c-843f-7e2dd6bb5e6c`.
- Live canary tenant resolved `full`; Browser capture returned HTTP 200;
  Sandbox returned 403 without authority and `SANDBOX_OK` with authority; the
  Room Agent accepted a valid signed ticket and rejected an invalid ticket.
- Core `npm ci` cannot complete on Windows because Lightpanda's postinstall uses
  POSIX `|| true`; focused tests still ran against the existing dependency tree.
- Integration/rebuild remains pending because the permanent `singulance-local`
  worktree contains unrelated modifications to `core/data/mcp-connectors.json`
  and `docker-compose.local-stack.yml`. Per the local integration protocol they
  were not stashed, reset, overwritten, or merged over.

## 2026-08-31 — Grok assignment budgets and complete lifecycle events

- Added explicit bounded assignment execution metadata for input/output size,
  tool calls, delegations, repairs, parallel assignments, and wall-clock time.
  LangGraph enforces input, output, receipt and timeout bounds; AgentScope uses
  the assignment tool-iteration limit.
- Added durable lifecycle events `agent_tool_started`, `agent_budget_warning`,
  `agent_handoff`, and `agent_recovered`, closing the event vocabulary required
  by the Grok HyperAgents architecture.
- Corrected receipt hydration so URL deduplication no longer replaces the exact
  provider receipt identifier used for audit and synthesis.

### Verification evidence

- Python 3.12 isolated suite:
  `pytest tests/test_langgraph_runtime.py tests/test_grok_runtime.py tests/test_adaptive_director.py -q`
  — `43 passed in 1.55s`.
- The reviewer-repair test now uses a real Researcher and independent Skeptic
  roster. A missing capability remains a deliberate `specialist_requested`
  wait and is not bypassed with an invented persona.
