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

## 2026-08-30 UTC — durable Dreaming v2 session candidate

- State: implemented and statically verified on `codex/dream-lifecycle-v2` in
  `P:\HIVEMIND-worktrees\dream-lifecycle-v2`; local integration and runtime
  acceptance remain pending. Production was not touched.
- Added an isolated Cloudflare Cron/Queue/DLQ/Workflow/R2 package, fail-closed
  Flagship evaluation, authenticated internal stage callbacks, PostgreSQL
  checkpoints/candidates/profiles/revisions, conservative visibility inheritance,
  deterministic replay healing, review APIs, notifications, and additive UI state.
- Verification completed before commit: Prisma validate/generate passed; Node
  syntax checks passed; focused cognition tests passed 16/16; Worker TypeScript
  passed; Wrangler local dry-run resolved only `-local` resources; the Da-vinci
  optimized production build compiled successfully.
- Agent Memory and code-review-graph MCP capabilities were not exposed to this
  session. Git, current code, tests, and repository documents were used as the
  authority; no unverified completion or secret was recorded externally.
- Three broader Windows-only test entrypoints (`dream-retention`,
  `entity-overdream-guard`, and `recall-dreams-first`) could not load because
  `singulance-amr` has no `win32-x64` prebuilt binary. The remaining focused
  suite passed; these three require the Linux local-container acceptance run.

## 2026-08-30 UTC — durable Dreaming v2 integrated into local truth

- State: pushed to `singulance-local` at merge `2b2510a3`; frontend source is
  `4f0f24bcf02c06fd509e6148f7e76b32170fc167`. Production remains unchanged.
- Merged-state checks: focused cognition tests passed 16/16 after Prisma client
  generation; schema validation, Worker TypeScript, Wrangler local dry-run, and
  the optimized Da-vinci build passed.
- Cloudflare local resources created: `hivemind-dream-trigger-local`,
  `hivemind-dream-trigger-dlq-local`, `hivemind-dream-artifacts-local`, and
  `hivemind-dream-workflow-local`. Worker version
  `f01a3baa-b481-4ba0-bdaf-ecb36563198f` is deployed. All eight local Flagship
  flags default off and target only the documented test organization.
- Runtime blocker: the shared `hivemind-api` container currently runs the
  parallel ingestion session's unmerged `knowledge-workflow-local` image.
  Rebuilding it here would overwrite another session's test runtime, so database
  migration, shared-secret wiring, browser E2E, restart injection, and local
  container acceptance are intentionally deferred until that session integrates.

## 2026-08-30 UTC — heavy-document Workflow production-parity acceptance

- State: committed local candidate; production unchanged. Branch
  `codex/knowledge-ingest-workflow-v1`, worktree
  `P:\HIVEMIND-worktrees\knowledge-ingest-workflow-v1`, commit
  `1ae13c022db72927aebef43ecdaa6230c5fd24a7`.
- Affected files: Cloudflare ingestion client, document-first ingestion,
  projection replacement, parser provenance, upload job failure recording,
  local Compose parity, the heavy-file canary runner, and focused tests.
- Production-parity boundary: inference/model names, embedding policy, parser
  configuration, and Cloudflare AI Gateway were read from production without
  printing or committing secrets. All stateful services and Cloudflare
  ingestion resources remained the isolated local variants.
- Runtime command: `node scripts/run-local-heavy-ingest-canary.mjs <eight OCR
  PDFs>` with the local API/user/org variables and `HIVEMIND_CANARY_FORCE=true`.
  Final database verification output:

  ```text
  jobs=8 ready=8 pages=691 segments=1722 memories=113 vectors=1722
  citation_links=113 receipt_memories=113 min_successful_receipts=10
  max_settlements_per_job=3
  ```

- Incident and repair: six first-pass R2 writes admitted while two concurrent
  writes exceeded the former fixed 120-second timeout. The two durable jobs
  were terminally recorded, then replayed from the same job identities after
  adding bounded idempotent upload retries. Both completed; no substitute job
  rows were created. The run also proved forced projection replacement and
  healed parser provenance (`parsed`, `pdf-parse`, structure extracted) for all
  eight documents.
- Focused test command: PowerShell expanded
  `Get-ChildItem tests/knowledge/*.test.js` into `node --test`. Output:
  `tests 105`, `pass 105`, `fail 0`.
- Static verification: Node syntax checks passed for every changed module and
  runner; PowerShell parser returned `powershell_parse=ok`; Compose returned
  `compose_config=ok`; `git diff --check` returned no errors.
- Runtime verification: API health reported DB and Qdrant ready with
  document-first ingestion and evidence retrieval enabled. A cross-tenant job
  status request returned 404. Filename recall returned `count=8`,
  `search_method=persisted-hybrid`, one exact filename match, and eight cited
  results.
- Baseline note: unfiltered `npm test` remains red for existing unrelated
  collection/runtime failures including Node collecting Vitest files, missing
  retired modules and absolute paths, and no Windows AMR native binary. The
  feature-scoped suite and Linux container runtime are green.
- Rollback: disable the Flagship flag or local master gate. No production
  release, production database mutation, or production Cloudflare resource
  mutation occurred.
## 2026-08-30 UTC — durable Dreaming v2 local runtime recovery acceptance

- State: the parallel canonical-ingestion branch is fully integrated and the
  shared API is now owned by the permanent `HIVEMIND-local-main` worktree.
  Dreaming runtime wiring and the provider-outage guard are committed as
  `276d2203` and integrated locally by merge `76a134fe`. Production was not
  modified.
- Cloudflare evidence: isolated local Worker version
  `249788ca-2a2f-400c-80d9-d68f1c237860` admitted manual, recovery, and
  duplicate trigger messages. Trigger `duplicate-acceptance-1` produced one
  run and one attempt for every completed stage despite duplicate delivery.
- Runtime evidence: manual run `a4b43088-d7f7-458f-a583-556c52769c14`
  completed all twelve stages; subject selection found 19 profiles and nine
  eligible graph bundles. This zero-candidate run exposed that total provider
  failure was incorrectly treated as successful completion.
- Recovery patch verification: focused lifecycle tests passed 6/6. Recovery
  run `39b8eb5f-fef0-42b7-86b6-9c45ce012b65` now remains at
  `generate-candidates`; PostgreSQL records the retryable structured error
  `candidate_generation_provider_unavailable` and attempt 2 instead of a false
  terminal success. Cloudflare Workflow instance
  `dream-local-47e2ba84-1b9f-4e1b-804b-7bd77d4eea0f-provider-outage-retry-1788058404-v2`
  is running its bounded exponential retry policy.
- External blocker: the production-parity LiteLLM credential expired on
  2026-08-24 and the current OpenRouter credential is rejected. No credential
  value was logged or committed. Candidate grounding, derivations, profiles,
  vectors, notifications, UI publication, and success-path restart acceptance
  remain unverified until those provider credentials are rotated.
- Build note: the canonical Docker rebuild was cancelled after dependency
  installation stalled. For the recovery canary only, the committed lifecycle
  file was copied from the permanent integration worktree into the existing
  local container and that container restarted healthy. This is runtime test
  evidence, not an immutable-image acceptance receipt.

## 2026-08-30 UTC — Dreaming Workflow exhaustion closes PostgreSQL run

- State: patch `e924850a`, local merge `f582bb5d`, and isolated Worker version
  `b6c01ba1-0420-44e4-b36d-26b04cb416e5`; production remains untouched.
- The Workflow now writes a durable terminal-failure receipt after stage retries
  are exhausted. The authenticated backend transition is idempotent and never
  overwrites completed, cancelled, or already failed runs.
- Verification: lifecycle unit tests passed 7/7, Worker TypeScript passed, and
  Wrangler local dry-run resolved only local bindings. Provider-outage run
  `39b8eb5f-fef0-42b7-86b6-9c45ce012b65` transitioned from running to error at
  `generate-candidates` with `recovery_status=retry_exhausted`, a safe terminal
  reason, and `finished_at` populated. No candidate was published.

## 2026-08-30 UTC — terminal Dreaming runs are immutable

- State: patch `718b0117`, local merge `c314c713`, isolated Worker version
  `7c21bf84-11b3-4b66-8126-6e679da944a1`; production remains untouched.
- A delayed retry from an older Workflow version exposed that `finalize` could
  overwrite an already failed run as completed. Stage execution now returns
  every terminal receipt unchanged, including finalize, and the Worker aborts
  when it observes error or cancelled state.
- Verification: lifecycle tests passed 8/8, Worker TypeScript and local Wrangler
  dry-run passed, and the local canary was restored to terminal error with zero
  published candidates. The shared API restarted healthy.
