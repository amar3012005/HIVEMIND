# SINGULANCE Production Release Ledger

## prod-20260716-c34a5469 - Outreach campaign runner (batch email/TARA-call over prospects)

- **Parent:** `hivemind-main` at `c34a5469364cd45a5167c8f41c7930171f7b7862` ("feat(outreach): campaign runner — batch email/TARA-call over prospects with progress + stop/deselect (#39)"). Reconciled ancestry verified linear: `c459a086 → b9d6dc77 → 20b8f3de → c34a5469` (each a direct ancestor).
- **Frontend:** `frontend/Da-vinci` at `9dcc537f718f1bd8f46173a6d5ddf93e5037d170`, pushed on `origin/fe-prospect-stack-on-prod`. CampaignPanel under the prospect stack.
- **Reconciliation note:** the briefed baseline for this release was `prod-20260716-c459a086`, but at start time `hm-core` was already running `prod-20260716-20b8f3de` and `hm-control`/`hm-fe`(legacy 8088) were running `prod-20260716-b9d6dc77` — a prior session had legitimately released both in the interim (confirmed linear ancestors via `git log`, no other active session on `claude-peers`, `hm-core` uptime stable/increasing before proceeding). Rollback tags for this release were therefore cut from the **actually-running** images, not the originally-briefed baseline: `employees`/`hm-fe`(next) from `c459a086`, `tara-deepgram` from `prod-20260715-8aa07a4b`, `core-api` from `20b8f3de`, `control-plane` from `b9d6dc77`.
- **Topology notes:**
  - `hm-core-2` (the second core replica noted in prior sessions' runbooks) is **absent** from the running topology at this release; only a single `hm-core` container exists. Not created — only containers that exist were recreated.
  - Two independent frontend containers are live: `hivemind-next-frontend-1` (compose service `frontend` in `/root/hivemind-next/infra/docker-compose.next.yml`, image `hivemind/fe:${NEXT_VERSION}-single`, port `127.0.0.1:2388`) is the one Caddy actually routes `next.singulancelabs.com`, `personal.singulancelabs.com`, and `enterprise.singulancelabs.com` to, and is the one this and all prior release-ledger entries rebuild/recreate. `hm-fe` (plain `docker run`, no compose labels, image `hivemind/fe:prod-20260716-b9d6dc77`, port `8088`) serves only the legacy `singulancelabs.com` marketing root (redirects `/hivemind*` to `next.*`) and has never been part of any prior release in this ledger (confirmed by grep across all prior entries) — it carries no app code and was intentionally left untouched.
- **Scope:** `hm-core`, `hm-control`, `hm-employees`, `tara-deepgram`, and `hivemind-next-frontend-1` (all rebuilt from the clean worktree). New Postgres tables `hivemind.outreach_campaigns`/`hivemind.outreach_targets`. Core control-plane routes + drain worker (`core/src/outreach/campaigns.js`, registered in `control-plane-server.js`); employees sidecar `/outreach/generate` (`api_outreach.py`); TARA per-prospect call-goal threading (`services/tara-aaas`); FE `CampaignPanel` under the prospect stack.
- **Build:** clean detached worktree `/root/builds/prod-20260716-c34a5469` via `git worktree add --detach c34a5469` in `/root/hivemind-next`; `HEAD` asserted at `c34a5469`, submodule initialized to `9dcc537f` with clean status before building. Built with `scripts/release-singulance.sh c34a5469 core control-plane employees tara-deepgram fe` (the repo-codified one-command release path).
- **Images:** core-api `sha256:89c698a5f9232bd5abe6c46062813df83d3ac2370bfaaf78f00d2c5c50eeb960`; control-plane `sha256:745a2569fd42f4f15994c0b7c3bb5ed0c34efedd5c2f140d5a8469d0e86bf826`; employees `sha256:2f5b1a0595ecafa829e4f04f7feb161306e87ba70920a425933a784f9668398f`; tara-deepgram `sha256:b3bc51e0c923e0471260e2f4d35374ab8efdb57f85f06b3cbdee2ad0673b21ff`; frontend (next, `-single`) `sha256:87fed76e2c6204f2a19d06c4b16c074d12d6402c2097b5c02f7db5ccb0094450`.
- **Migrations:** `core/prisma/migrations/20260716060000_outreach_campaigns/migration.sql` — additive only (two new tables, no changes to existing tables); `down.sql` alongside. PostgreSQL backup before promotion: `/root/backups/hivemind/backup-prod-20260716-c34a5469.dump` (20,393,702 bytes; SHA-256 `ac21d66c51be375778d9d6eff4aaba3636bb521a332aaf4f9c428822b8bfb1ae`). Applied manually via `psql -v ON_ERROR_STOP=1` before promotion (never `prisma migrate dev`/`db push` on prod); verified `\d hivemind.outreach_campaigns` and `\d hivemind.outreach_targets` post-apply — both tables present with expected columns, indexes, and the `outreach_targets → outreach_campaigns` FK.
- **Env:** `VERSION` and `NEXT_VERSION` bumped to `prod-20260716-c34a5469` in `/root/hivemind/.env` and `/root/hivemind-next/.env.embedding-canary-runtime`; both backed up first (`.bak-prod-20260716-c34a5469`). `docker compose config` resolution confirmed for the affected services against the immutable tag before recreation (script-enforced).
- **Recreate order (one at a time, health-gated):** `control-plane` → `core` → `employees` → `tara-deepgram` → `frontend` (next). All five reached `healthy`/`running` before the next recreate. `hm-core-2` not created (absent from topology, see note above); `hm-fe` (legacy 8088) intentionally not recreated (out of scope, no app code).
- **Acceptance:**
  - Public: `https://singulancelabs.com` → 200; `https://next.singulancelabs.com/hivemind` → 200; `https://next.singulancelabs.com/` → 200; `https://api.singulancelabs.com/health` → 200; `https://core.singulancelabs.com/health` → 200; `https://core.singulancelabs.com/voice2/health` → 200.
  - Frontend lazy-chunk release marker: served `index.html` references `static/js/main.0bb055ef.js`; the lazy chunk `static/js/1270.af8884f8.chunk.js` (confirmed present inside the running `hivemind-next-frontend-1` container at `/srv/static/js/`) contains the `CampaignPanel`/outreach-campaign marker — verified via a non-`main.js` chunk.
  - Unauthenticated probe `POST https://api.singulancelabs.com/v1/outreach-campaigns/00000000-0000-0000-0000-000000000000/start` → `401 {"error":"Unauthorized"}` (not 500) — route live and auth-gated.
  - Fresh fatal/panic/uncaught/unhandled/OOM/migration-error count: zero across `hm-core`, `hm-control`, `hm-employees`, `tara-deepgram`, `hivemind-next-frontend-1` over the post-recreate window.
- **Not exercised:** no real outreach campaign was started/sent (no live emails/calls placed); the probe above intentionally used a non-existent campaign ID against an authenticated route to confirm auth-gating only.
- **Aliases:** `hivemind/core-api`, `hivemind/control-plane`, `hivemind/employees`, `hivemind/tara-deepgram` `:stable`/`:latest`, and `hivemind/fe:stable-single`/`:latest-single` all advanced to this release's images after acceptance passed.
- **Rollback:** `hivemind/core-api:rollback-20260716-062447` (pre-release `20b8f3de`), `hivemind/control-plane:rollback-20260716-062447` (pre-release `b9d6dc77`), `hivemind/employees:rollback-20260716-062447` (pre-release `c459a086`), `hivemind/tara-deepgram:rollback-20260716-062447` (pre-release `prod-20260715-8aa07a4b`), `hivemind/fe:rollback-20260716-062447-single` (pre-release `c459a086-single`). Restore path: retag each service back from its rollback tag, restore `/root/hivemind/.env.bak-prod-20260716-c34a5469` and `/root/hivemind-next/.env.embedding-canary-runtime.bak-prod-20260716-c34a5469`, recreate only the affected containers `--no-deps --force-recreate`. Migration is additive-only; `down.sql` available if a rollback ever needs the tables removed (not required for a code-only rollback since old code never references them).

## prod-20260716-20b8f3de - Curator JSON contract fix (retroactive backfill)

- **Parent:** `hivemind-main` at `20b8f3de11371a13429c8fd07a9eccdf51dea165` ("fix(ingestion): enforce curator JSON contract (#38)").
- **Frontend:** unchanged, pinned at the `b9d6dc77` release's frontend SHA (`6bdc4235ad2027405b5d7c252a3f00d302043912`).
- **Scope:** `core/src/knowledge/document-first-ingestion.js` only (`hm-core`) — enforces the curator's JSON contract (8-line diff).
- **Recorded retroactively:** this entry was missing from the ledger; deployed by a prior session between the `prod-20260716-b9d6dc77` and `prod-20260716-c34a5469` releases without a ledger append. Backfilled during the `prod-20260716-c34a5469` reconciliation after confirming via `git log` that `20b8f3de` is a direct ancestor of `c34a5469` and that `hm-core` was observed running `hivemind/core-api:prod-20260716-20b8f3de` (healthy) at reconciliation time. Not independently acceptance-verified by the session recording this backfill entry.

## prod-20260716-b9d6dc77 - KB page-only billing and usage

- **Parent:** `hivemind-main` at `b9d6dc77d0cde9ba4ba2532703e6e92f67654173` ("fix(billing): meter knowledge base by pages only (#35)").
- **Frontend:** `frontend/Da-vinci` at `6bdc4235ad2027405b5d7c252a3f00d302043912` ("fix(usage): remove document upload quota UI").
- **Scope:** `hm-core`, `hm-control`, and `hm-fe`. Knowledge-base document count remains internal telemetry, while KB pages are the only customer-visible and enforced capacity metric.
- **Build:** clean detached worktree `/root/builds/prod-20260716-b9d6dc77`; parent and pinned frontend SHAs verified with a clean status before build.
- **Images:** core `sha256:cdbf6769750ff1d0ded05379706534451bbda31a345a72282238cb7bc4ba7d27`; control `sha256:001c22536ca770be9274dc0b1c84d48216e17c4b118fba35eebf16b6b4c2b096`; frontend `sha256:7a5d7f791297472ab1ce8274f0d6f15ebb0446735da9a1561aece75b0269b49e`.
- **Migrations:** none. PostgreSQL backup before promotion: `/root/hivemind/backups/prod-20260716-b9d6dc77-pre.sql.gz`, SHA-256 `cfac20a9ab3b523296683ea4b3c0c730d750f92c6ba3443b06196359b7ad0697`.
- **Acceptance:** public `next.singulancelabs.com/hivemind`, `/hivemind/login`, `/hivemind/app/usage`, API health, and Core health each returned `200`; protected billing endpoint returned expected `401` without a session; core and control reached `healthy`; no fresh fatal, panic, uncaught, unhandled, OOM, or migration errors in core, control, or frontend logs.
- **Not exercised:** authenticated billing payload inspection was not run because no disposable authenticated session was available; no customer-side upload was created.
- **Aliases:** core, control, and frontend `stable` and `latest` were advanced only after acceptance.
- **Rollback:** `hivemind/core-api:rollback-20260716T052951Z-pre-prod-20260716-b9d6dc77` and `hivemind/fe:rollback-20260716T052951Z-pre-prod-20260716-b9d6dc77`; restore the matching prior runtime env backup and recreate only affected services.

## prod-20260716-c459a086 - HyperAgents outreach: connected-Gmail sender identity + prospect-stack cards

- **Parent:** `hivemind-main` at `c459a0869c5f0724bda1e2057098a18c61b1d02a` ("chore(fe): bump Da-vinci gitlink → prospect-stack cards (00aad39) (#34)").
- **Frontend:** `frontend/Da-vinci` at `00aad39c74f32389f63fabf25cf9dac9effd0722` ("feat(hyperagents): outreach prospect stack cards with email-verified badges"), pushed on `origin/fe-prospect-stack-on-prod`.
- **Scope:** application-only release. Changed services: `employees-service` (engine.py, api_hyper_rooms.py, db.py — connected-Gmail sender identity threaded into synth, robust subject extraction, `get_connected_gmail`) and the frontend (`HyperAgents.jsx` — outreach prospect-stack cards with green "email verified" badges). `hm-core`, `hm-control`, `tara-deepgram`, and all data services were not rebuilt; their prior verified digests were retagged unchanged under this release ID.
- **Build:** fetched into a clean detached worktree `/root/builds/prod-20260716-c459a086` (`git worktree add --detach`); asserted `HEAD` = `c459a086`, working tree clean, submodule initialized to `00aad39` with no `+`/`-`/dirty status before building.
- **Images:** employees `hivemind/employees:prod-20260716-c459a086` = `sha256:844a246f1484f94e1f4de285015d19b84c0a0fc82ee9e64172c13a746e6d45b9` (manifest list digest); frontend `hivemind/fe:prod-20260716-c459a086-single` = `sha256:568fcecd86cc1d4c629aa2eb3799dec28327daa3f8044b3ac42862bd2d943ce3` (manifest list digest). Reused unchanged: `hivemind/core-api:prod-20260716-c459a086` (from running `hm-core`, image id `sha256:9e706bc9bba8...`), `hivemind/control-plane:prod-20260716-c459a086` (from running `hm-control`, image id `sha256:46150e1f5842...`), `hivemind/tara-deepgram:prod-20260716-c459a086` (from running `tara-deepgram`, image id `sha256:382efc7ed893...`).
- **Runtime:** `VERSION` and `NEXT_VERSION` set to `prod-20260716-c459a086` in `/root/hivemind/.env` and `/root/hivemind-next/.env.embedding-canary-runtime`; both backed up first (`.bak.20260715T233900Z`). `docker compose config` confirmed for both `docker-compose.hetzner.yml` (employees) and `docker-compose.next.yml --profile single` (frontend) that the affected services resolve to the immutable tag before recreation.
- **Recreate order:** `employees` recreated first (`--no-deps --force-recreate`), reached `healthy` immediately, zero fresh fatal/panic/traceback/OOM in the post-recreate window; then `frontend` recreated (`--no-deps --force-recreate`), came up healthy with a clean Caddy start and zero errors. Data services (`postgres`, `redis`, `qdrant`, `docling`, `nango`) were not restarted — no migrations in this release (confirmed no pending migration files/errors before promotion), so no backup gate was required.
- **Migrations:** none. No schema change; verified no pending migrations before promoting.
- **Acceptance:**
  - Public: `https://core.singulancelabs.com/health` → 200; `https://core.singulancelabs.com/voice2/health` (TARA) → 200; `https://api.singulancelabs.com/health` (Control) → 200; `https://next.singulancelabs.com/` → 200; `https://next.singulancelabs.com/hivemind/login` → 200; `https://personal.singulancelabs.com/` → 200; `https://enterprise.singulancelabs.com/` → 200.
  - Frontend lazy-chunk release marker: served `index.html` references `static/js/main.14a0fffc.js`; the lazy chunk `static/js/2338.6467b028.chunk.js` resolves live (200) and contains the new "prospect" outreach-card marker string — confirmed via a non-`main.js` chunk, not just the entry bundle.
  - Employees internal health (`hm-employees:8060/health`) → 200; bootstrap round-trip to `hm-control` succeeded (`GET /v1/employees/bootstrap` → 200) with clean reconcile on startup.
  - Fresh fatal/panic/uncaught/unhandled/OOM/migration error count: zero in `hm-employees`, `hivemind-next-frontend-1`, and `hm-core` over the post-recreate window.
- **Not exercised:** a live end-to-end outreach room send (would trigger a real customer-facing Gmail send) was intentionally not run as part of this acceptance; the new code paths were verified via clean health/bootstrap and log inspection only, per "no customer side effect unless explicitly authorized."
- **Ledger backfill:** the two entries below (`prod-20260715-418d3b29`, `prod-20260716-2eb3d1da`) are recorded retroactively — both were real, previously-deployed ancestors of this release that a prior session deployed without updating this ledger. Confirmed via `docker ps` / image digests on `singulance` at reconciliation time before this release.
- **Aliases:** `hivemind/employees:stable`/`:latest` and `hivemind/fe:stable-single`/`:latest-single` retagged to this release's images after acceptance.
- **Rollback:** `hivemind/employees:rollback-20260715T233134Z` (pre-release running image, `prod-20260715-418d3b29`) and `hivemind/fe:rollback-20260715T233134Z-single` (pre-release running image, `prod-20260715-3bf522e6-single`). `hm-core`/`hm-control`/`tara-deepgram` were not replaced, so no rollback tag was required for them.

## prod-20260716-2eb3d1da - Curate richer durable memories from documents (retroactive backfill)

- **Parent:** `hivemind-main` at `2eb3d1da0be0c650d6f49a00fb2c1cbaab313609` ("feat: curate richer durable memories from documents (#28)").
- **Frontend:** unchanged, pinned at `40b69ddf707e4b628c8caddf451301dd59793d1e`.
- **Scope:** `hm-core` only; recorded retroactively from observed runtime state (`VERSION=prod-20260716-2eb3d1da` in `/root/hivemind/.env`, `hm-core` running `hivemind/core-api:prod-20260716-2eb3d1da`, healthy) at the time of the `prod-20260716-c459a086` reconcile. Not deployed or acceptance-verified by the session recording this backfill entry.

## prod-20260715-418d3b29 - Impressum/contact enrichment on places_search (retroactive backfill)

- **Parent:** `hivemind-main` at `418d3b29e30cae4d2fe649db4c2643fe51dbcf1a` ("feat(hyperagents): impressum/contact enrichment on places_search — fetch each firm's Impressum/Kontakt page, attach best real email … (#27)").
- **Frontend:** unchanged, pinned at `40b69ddf707e4b628c8caddf451301dd59793d1e`.
- **Scope:** `employees-service` only; recorded retroactively from observed runtime state (`NEXT_VERSION=prod-20260715-418d3b29` in `/root/hivemind-next/.env.embedding-canary-runtime`, `hm-employees` running `hivemind/employees:prod-20260715-418d3b29`, healthy) at the time of the `prod-20260716-c459a086` reconcile. Not deployed or acceptance-verified by the session recording this backfill entry.

## prod-20260716-351b7220 - Recall source and backend parity

- **Parent:** `hivemind-main` at `351b72205299da4769f162b68e9364f7a29797ee`.
- **Frontend:** unchanged code, pinned at `f0f9a350b83754721885637b49206f811140ae79` and retagged under this release ID.
- **Images:** core `hivemind/core-api:prod-20260716-351b7220` = `sha256:c20f00917bcf547628fe7320fa2a9ff232c27ddc79fcc6d32ba99614a4fd9a1d`; frontend `hivemind/fe:prod-20260716-351b7220-single` = `sha256:9024f45a049787a08f0bf169e7a98c4c7bb33729d69ce973a050421d3f6d2272`.
- **Runtime:** `VERSION` and `NEXT_VERSION` are `prod-20260716-351b7220`; only `hm-core` was recreated. The frontend image was unchanged and remains running.
- **Migration:** verified additive PostgreSQL indexes `memories_org_created_at_idx` and `memories_org_valid_window_idx`; both use `CREATE INDEX IF NOT EXISTS` and were present before promotion.
- **Backup:** `/root/backups/hivemind-prod-20260716-351b7220.dump`, SHA-256 `e783df2f01815b37154a2e78c3fff51832d4b45f6d8b9056f6287e2e38a612bf`.
- **Acceptance:** core healthy with PostgreSQL, Qdrant, and Docling reachable; public Core health returned `ok:true`; `next.singulancelabs.com/hivemind` and `/hivemind/login` returned `200`; no fresh fatal, panic, uncaught, unhandled, OOM, or migration errors were found in the core deployment window.
- **Not exercised:** an authenticated tenant-specific recall/chat request; no customer-side effects were triggered.
- **Aliases:** core and frontend `stable` and `latest` match the images above.
- **Rollback:** `hivemind/core-api:rollback-20260715T215652Z-pre-prod-20260716-351b7220` and `hivemind/fe:rollback-20260715T215652Z-pre-prod-20260716-351b7220`.

## 2026-07-15 - Pre-release lineage reconciliation audit

- This entry records observed state only. It is not a deployment or acceptance claim.
- Runtime parent identity: `VERSION=prod-20260715-f98dce54` and `NEXT_VERSION=prod-20260715-f98dce54`.
- Committed frontend gitlink: `a017b4322aba68b41fca477af7347239a58122bf`, equal to pushed `frontend/Da-vinci` `singulance-main`.
- Core: `hivemind/core-api:prod-20260715-5971bf0f`, image `sha256:3733adcfc1c0a6eb7b4cc71b24d52e05042be63b26fdb090321cfe9b370fbbd6`, healthy, zero restarts.
- Employees: `hivemind/employees:prod-20260715-5971bf0f`, image `sha256:afb87fbdcd2058f8043fcd346a9c847efbdb0222ce33bc134e94411be5c43bbc`, healthy, zero restarts.
- Frontend: `hivemind/fe:prod-20260715-190a56a3-single`, image `sha256:5bac21c091ad210bc9d24252333859a2923bb5bd9029408480af1e4f4330eb0c`, running, zero restarts.
- TARA: `hivemind/tara-deepgram:prod-20260715-f98dce54`, image `sha256:382efc7ed893748f1563b451a7f2a92999aa94f6bdff5cef7f45b17a28e2fa80`, healthy, zero restarts.
- Control: `hivemind/control-plane:prod-20260714-8fa3eebe`, image `sha256:46150e1f5842b7b9fcaaad2934b877f58af859a65d6663111d8662545318a266`, healthy, zero restarts.
- BYOD broker remains `hivemind/byod-broker:next-2d879e77`, image `sha256:ae0fe36a8468690f7c0da07a1af5ae608d069fd3f8b8e1d4d2b6088706340eee`; immutable BYOD release parity remains an explicit unresolved gate.
- The mixed central-service tags are traceable to the last parent commit that changed each service: frontend `190a56a3`, core/employees `5971bf0f`, TARA and runtime identity `f98dce54`, control `8fa3eebe`.
- No build or promotion may start from the dirty shared frontend checkout. Use a clean detached release worktree at the approved parent SHA and exact committed frontend gitlink.

## prod-20260714-68d67a39 — Room METHOD skills + one-company isolation + report depth
- **Date:** 2026-07-14
- **Parent:** branch `feat/room-skills-prod`, SHA `68d67a39caa8f0868cd25d41f90e815a5d32f251`
- **Frontend:** branch `feat/room-skills-prod` (Da-vinci), SHA `d15c81434634c766898db4622f463e9434c40390`
- **Base:** `codex/production-hardening-runtime` @ `fd90e579` + cherry-picks `796cc4b2` (one-company-per-org replace, report-quality synth/debate fixes) and `aec5b47f` (room METHOD skills + self-evolving room playbook; task_tag plumbing adapted out for this line)

### Images (built from clean detached worktree /root/builds/prod-20260714-68d67a39)
| Image | ID | Origin |
|---|---|---|
| hivemind/employees:prod-20260714-68d67a39 | 7eb9773d69e7 | built |
| hivemind/control-plane:prod-20260714-68d67a39 | eed07c5f1622 | built |
| hivemind/fe:prod-20260714-68d67a39-single | 9754bba9934e | built |
| hivemind/core-api:prod-20260714-68d67a39 | bb54067c4e8e | retag of prod-20260714-8f049395 (unchanged) |
| hivemind/tara-deepgram:prod-20260714-68d67a39 | f7e92ff68a9b | retag (unchanged) |
| hivemind/byod-broker:prod-20260714-68d67a39 | ae0fe36a8468 | retag of next-2d879e77 (unchanged) |
| hivemind/hm-playwright:prod-20260714-68d67a39 | 4177c43a4414 | retag of latest (unchanged) |

### Migrations
- `20260714150000_room_playbook` — `ALTER TABLE hivemind.hyper_rooms ADD COLUMN IF NOT EXISTS room_playbook JSONB;` (additive; down = DROP COLUMN). Applied before promotion; verified column exists.
- PG backup: `/root/backups/backup-prod-20260714-68d67a39.dump` (16.7 MB, sha1 `a89357a7…`, .sha alongside).

### Runtime
- `/root/hivemind/.env` VERSION=prod-20260714-68d67a39 (backup `.env.bak-prod-20260714-68d67a39`)
- `/root/hivemind-next/.env.embedding-canary-runtime` NEXT_VERSION=prod-20260714-68d67a39 (backup alongside)
- Recreated one-at-a-time with health gates: hm-employees → hm-control → hivemind-next-frontend-1 (from `-single`). Data services untouched. hm-core/tara containers not recreated (code unchanged; tags provided for compose consistency).

### Acceptance evidence
- Public 200: singulancelabs.com, next.singulancelabs.com, /hivemind/login, api/health, core/health. TARA route 401 = expected privileged-agent gate; tara-deepgram container healthy.
- FE lazy chunk marker: `skill_used` present in `/srv/static/js/8174.fcf43b9e.chunk.js` (not main.js).
- Fresh fatal/panic/uncaught/OOM/migration errors: 0 (hm-employees, hm-control).
- Authenticated (disposable session, internal FOREST org owned by support@singulancelabs.com): `/v1/hyper/company` 200 onboarded.
- Feature e2e turn `58dff37d` (FOREST HQ): `skill_used=competitor-teardown` event emitted, 9 debate reacts, ZERO "(no reply)", seal=complete, deliverable follows ANALYTICAL DEPTH contract (Executive Summary + Key Insight + quantified actions).
- In-container skills registry: 6 kinds / 17 skills load; `resolve_room_kind("Research Competitor Landscape") → market`.
- Second e2e with evo on (turn `d8b6a6c2`): room-playbook learning path exercised (see addendum).

### Rollback
- Tags `rollback-20260714-133714` on employees/control-plane/fe-single; env backups above; DB backup above.
- Procedure: restore env backups → `docker compose … up -d --no-deps --force-recreate` affected services → (only if needed) `ALTER TABLE hivemind.hyper_rooms DROP COLUMN IF EXISTS room_playbook;`

### Intentionally untested external side effects
- No emails/calls placed. Reactor NEED protocol shipped flag-OFF (`HYPER_REACTOR_REACH`). Room-skills catalog ON by default (`HYPER_SKILLS_ENABLED`).

## prod-20260714-d9dfcfe7 — Grounding verification gate + log hygiene + provenance fix
- **Date:** 2026-07-14
- **Parent:** branch `fix/grounding-verifier-hardening`, SHA `d9dfcfe7f0d6d43f9ef27bb0cd3616d8e2190d54` (off `feat/room-skills-prod` @95fce4ba)
- **Frontend:** unchanged, gitlink `d15c81434634c766898db4622f463e9434c40390`
- **Fixes the prod-20260714-68d67a39 acceptance findings:**
  1. Deterministic company-grounding gate: company-scoped turn with missing company brief → grounded_ok=false + met=false + gap (code-enforced, not LLM-trusted); canonical-name substitution likewise blocked (db.get_company_name from persisted _company). Orchestrator retries the brief once (12s) and emits a `company_context_missing` warning event.
  2. Verifier chain-of-thought no longer logged: `AGENTSCOPE_DISABLE_CONSOLE_OUTPUT` defaults true in the sidecar (main.py, set before agent imports). Structured verdict log lines only.
  3. Runtime provenance: ALL app services recreated under the immutable tag — hm-employees/hm-control/hm-core/tara-deepgram/next-frontend all display prod-20260714-d9dfcfe7 (unchanged services = retagged verified digests: core-api bb54067c4e8e, tara f7e92ff68a9b, fe 9754bba9934e; employees rebuilt = sha256:1f1d22d6…).
  4. Migration provability: new `hivemind.schema_migrations_applied` ops ledger table; row for `20260714150000_room_playbook` (sha1 8c6f2cad…, release prod-20260714-68d67a39).
- **Tests:** 5/5 deterministic-gate regression tests (missing-context force-fail, name-substitution block, healthy pass, non-company task unaffected); ast green.
- **Acceptance evidence:** public 200 ×4; turn `817301e5` on FOREST org (canonical company = "Formula 1"): brief recalled 431 chars, verifier returned grounded=false with gap "deliverable never references the company's canonical name (Formula 1) — possible identity substitution", goalkeeper re-round also refused → seal status **escalated** (NOT complete) — the exact blocking behavior required; `(thinking)` occurrences in logs since deploy: 0; fresh fatal/panic/uncaught/OOM: 0 (prior count was a grep false-positive: `-i OOM` matches inside `room=`).
- **Rollback:** tags `rollback-20260714-142631` (all five services) + env backups `.bak-prod-20260714-d9dfcfe7` + DB backup from prior release (no schema change in this release).
- **Untested side effects:** none — no emails/calls; internal test org only.

## prod-20260714-8d74e135 — Reconciled: landing restore + stale-domain sweep + google-native connector OAuth
- **Date:** 2026-07-14
- **Parent:** branch `release/landing-plus-fixes`, SHA `8d74e1352702d60ec695cb360d559a0e2d3163d7` — based on `codex/hyperagents-grounding-guard` @ d103e55e (landing restore, OWNED BY THE CODEX SESSION — reconciled, not overwritten) + cherry-picks d9dfcfe7 (grounding gate) + 837e102e (ledger)
- **Frontend:** branch `fix/connectors-on-landing`, SHA `e754b979e5eca7a8333a0956db955cf4c55ce8e9` — on top of the codex landing FE (7be553d6) + stale-domain sweep (3 commits) + google-native connector routing
- **Why:** the prior 80e8ea0f promote regressed the codex landing release (its branch lacked the landing commits). This release carries BOTH lines.
- **Images:** fe-single rebuilt `sha256:16da1721…`; employees/control/core/tara retagged from d9dfcfe7 (employees source verified byte-identical via sha1 diff before reuse).
- **Key change — Google connector OAuth:** Connectors page now routes gmail/google-* (except google-gemini) through the google-NATIVE path: same `GOOGLE_CLIENT_ID` as login, redirect `core.singulancelabs.com/api/connectors/gmail/callback` — the davinciai.eu account-picker text came from the central-Nango client. Live-verified auth URL: client `…dgtg4`, redirect core.singulancelabs.com.
- **Acceptance:** landing hero "Run your institution as an AI company" present in main.3bfcee9e.js; sw.js hive-shell-v3 preserved; minified bundle carries the native-first routing condition; public 200 ×4; remaining davinciai strings = env-fallbacks + intentional central-Nango fallbacks only.
- **Rollback:** fe rollback tag `rollback-20260714-152221-single`; env backups `.bak-prod-20260714-8d74e135`.
- **ACTION REQUIRED (Google Cloud Console, cannot be done from repo):** the `…dgtg4` OAuth client must list `https://core.singulancelabs.com/api/connectors/gmail/callback` as an authorized redirect URI, or connector connects will fail with redirect_uri_mismatch. Also set the client's consent-screen app name/domain to singulancelabs.com if any davinciai branding remains there.

## prod-20260714-52d388e1 — BRAIN | Operating System | VOICE navbar
- **Parent:** `fix/nav-product-identities` @ `52d388e175b79974c3ecaecf26b4903a3b4949a1` (off singulance-main 76ece631)
- **Frontend:** @ `ee143ebd344a5818d8837c4282d3013cf91010ea` = singulance-main FE + cherry-picks 10c0a5c/ab7cd11 (nav rename, from feature-loop/mobile-app-v2 — first commits of that line to reach prod)
- **Images:** fe-single rebuilt `sha256:eeb283f1…`; backends retagged from 8d74e135 (unchanged).
- **Acceptance:** served chunk 1270.4a55b4e7 carries `label:"Operating System"/"VOICE"/BRAIN`; landing hero intact in main.03a12d1c.js; public 200.
- **Rollback:** fe tag `rollback-20260714-161534-single`; env backups `.bak-prod-20260714-52d388e1`.
- **Note:** feature-loop/mobile-app-v2 holds ~31 further undeployed FE commits (outcomes strip, TARA room-call UI, PWA fixes) requiring the outbound backend — next reconciliation block.

## prod-20260714-9d91226a — Outbound closed-loop + mobile-app-v2 FE (full catch-up onto singulance-main)
- **Parent:** `feat/outbound-closed-loop-port` @ `9d91226a649a09404cb149f12aa54c592480a11a` (off singulance-main a83f1991)
- **Frontend:** `feat/mobile-app-v2-port` @ `9146fbf8fe536203a4e43a561dc457460f6443e0` = FE canon + merge of feature-loop/mobile-app-v2 (33 commits: outcomes strip, TARA room-call UI, PWA hive-shell-v5)
- **Backend picks from feature-loop/outbound-closed-loop:** 8413a647 (ledger + /v1/hyper/outcomes + one-company), f5ec4f22 (gmail reply detection), 814fe230 (emailSends metering; schema conflict union — canon taraSeconds/hyperAgentRuns kept), 10f87fea (company outcomes summary), c876ae96 (call bridge), 23afd5c2 (route calls via managed Deepgram TARA — taraDeepgramBaseUrl, tara-aaas dropped), 8f049395 (control helper-order fix + unit test)
- **Images:** core 43dd7509dd2b, control 0eff985aa7b0, tara-deepgram d227a2c2c647, fe a05557e07a6c (all rebuilt from clean worktree); employees retagged d9dfcfe7.
- **Migrations:** 20260714120000_outbound_actions + 20260714121000_email_sends_usage applied (idempotent — partially present from the morning 8f049395 release) and recorded in schema_migrations_applied. PG backup backup-prod-20260714-9d91226a.dump (18.4MB, sha alongside).
- **Acceptance:** all app services on the immutable tag; public 200 ×4; authenticated /v1/hyper/outcomes returns counters; /v1/hyper/company carries outcomes; FE serves hive-shell-v5, BRAIN|Operating System|VOICE, landing hero, outcomes-strip chunk; fresh fatal/uncaught: 0 (log grep excludes room= OOM false-positive).
- **Rollback:** tags rollback-<TS> (see docker images) + env backups + DB backup.
- **Post-release:** singulance-main fast-forwarded (both repos) — THE deploy branch from now on. Remaining un-ported: feat/mneme-foundation deep engine/recall work (separate migration project).

## prod-20260714-e7aa7a98 — Latency (Cerebras pin + 120b lanes) + room-stream stability + release script
- **Parent:** `fix/latency-cerebras-pin` @ `e7aa7a98…` (+ script/ledger commits, tip f17807bd→this); FE `fix/room-stream-stability` @ `567da880…`. Off singulance-main 908f8202.
- **Latency:** engine pin gpt-oss-120b → ["Cerebras","Groq","Together"]; env HYPER_AUTO_GATHER/AUTO_DEBATE/MODEL_RECON=openai/gpt-oss-120b. Measured live (turn 1e9b7d4e): engine 45s→14.5s, full turn incl. verify 90s→21s wall-clock; all calls provider=Cerebras.
- **FE stability (post-synthesis blinking):** quiet seal refetch (no full-screen spinner), one-shot seal latch (SSE/poll race fired load() twice), identity-stable event merge (poll no longer forces 4 re-renders/sec).
- **Ops:** scripts/release-singulance.sh — one-command protocol release (canon-descendant gate, clean worktree, selective build, health-gated recreates, smoke).
- **Images:** employees 883934a5ec9e, fe fcbceedd5424 (rebuilt); rest retagged. No migrations.
- **Rollback:** rollback-20260714-174903 + env backups `.bak-prod-20260714-e7aa7a98` (includes the model-env change).

## prod-20260714-b773c02f — Partner referral onboarding (FE catch-up complete)
- **Parent:** `feat/referral-onboarding-port` @ `b773c02f…`; FE @ `297001f8…`. Off singulance-main a94504c0.
- Port of codex/referral-onboarding (login referral field + intent pass-through + offer preview + org-create redemption; coexists with enterprise access codes). Backend /v1/referrals/* + org-create referralCode already on canon.
- First release executed end-to-end by scripts/release-singulance.sh (descendant gate → worktree → FE build → health-gated recreate → smoke). One iteration: initial pick had a dup state + clipped api-client method — CI build caught it, fixed in 297001f8.
- **FE branch audit:** with this port, FE singulance-main supersedes ALL other FE branches (india/europe/master/mobile-version = obsolete experiments; hermes/sso/meeting-dial/stale-domains = already in canon via other lineages).
- Acceptance: bundle carries "Partner referral code"; /v1/referrals/preview responds (401 unauth = route live); public 200 ×4.

## prod-20260714-5be810de — Live action cards (email compose + call ringing)
- **Parent:** `feat/live-action-cards` @ `5be810de…`; FE @ `7de3e14c…`. Off singulance-main faab3549.
- Gmail-style compose card for agent email sends: From/To/Subject schema, body types in realtime, one-click Send, per-room "Automate from next turn" toggle (auto-approves after typing completes; same HITL endpoint). TARA outbound calls show a ringing popup (pulse rings → in-progress → dismiss).
- FE-only (new LiveActionCards.jsx + HyperAgents.jsx wiring). Released by scripts/release-singulance.sh; markers verified in served chunk 84.bf19852e; public 200 ×4.
- Rollback: script-created rollback tag + env backups.

## prod-20260714-f0f63bc3 — Event-driven outreach email (task tag → gmail room → email deliverable)
- **Parent:** `feat/outreach-email-intent` @ `f0f63bc3` off singulance-main ada8c880. FE unchanged.
- OUTREACH-tagged task rooms auto-enable the org's gmail connector (when connected, only if the room had none); outreach-shaped room goals upgrade a generic first turn to intended_output=email → agents draft a ready-to-send email → compose card. No task hardcoding — tag + task language drive it.
- Released via scripts/release-singulance.sh (control-plane + employees rebuilt, health-gated, smoke 200×4).

## prod-20260714-4b9f950e — Atomic task kickoff
- **Parent:** `fix/task-kickoff-dispatch` @ `4b9f950e` off singulance-main 88017a51. FE unchanged.
- tasks/open now creates + dispatches the kickoff turn server-side (nightly-cycle pattern) — task rooms start working the moment they open instead of sitting at 0 turns. Rooms created before this release still need one manual message (or delete + re-open the task).
- Released via release script (control-plane only, health-gated, smoke 200×4).

## prod-20260714-c24e4f8e — Kickoff idempotency fix (task auto-start WORKING)
- **Parent:** `fix/kickoff-idempotency` @ `c24e4f8e` off singulance-main 98d9d307. FE unchanged.
- Root cause of silent task rooms: kickoff hyperTurn.create omitted NOT NULL idempotency_key → insert failed silently. Fixed (`task-kickoff-<roomId>`, also dedupes double-clicks) + re-opening a 0-turn task room now dispatches its kickoff.
- LIVE PROOF: re-opened task t5 ("Prepare Outreach Materials", OUTREACH) on room 61b523f5 → turn created, agents ran unprompted: 28 events incl. skill_used + plan + seal. Task auto-start verified end-to-end.

## prod-20260714-8fa3eebe → f86ba45b → c2779ecd — Reconcile + outbound email chain completed
- 8fa3eebe: merge of codex/ingestion-production-reconcile (31 ingestion commits, forked fd90e579) + fix/google-native-token-fallback into canon. c2779ecd: gmail native connect now requests compose+send scopes (drafts/sends 403'd on readonly grants — RECONNECT Gmail required for pre-existing connections). f86ba45b: next_tasks suggestion event + FE cards merged.
- Debug trail on live room 61b523f5: "not connected" (Nango-only token resolution; fixed by platform_integrations fallback) → Google 403 (readonly scope; fixed by compose+send). Lesson recorded: canon MUST be fast-forwarded at acceptance, immediately — the 9d09a0ad collision happened because 4882225c was released but never merged to canon.

## prod-20260715-190a56a3 + prod-20260715-5971bf0f — Room-kind synthesis reports
- **Parent:** `feat/room-kind-reports` @ `5971bf0f` off singulance-main 92b6faf1-lineage; FE @ `a017b432`.
- Phase A: engine `_REPORT_SKELETON` — market/content/outreach/business/strategy rooms seal under FIXED domain headings (report-shaped outputs only; email/sheet keep their format; general unchanged). Phase B: FE desk identities — SYNTHESIS_PRESENTATIONS keyed by room_kind (Competitive/Editorial/Outreach/Operating desk, Decision memo), kind badge, per-section icons; room_kind derived from skill_used events; GENERAL fallback for old turns.
- Follow-up fixes (5971bf0f): turn message outranks room goal in kind resolution (HQ goal embedding the task list mis-typed a competitor question as outreach — caught live); recipient-less gmail drafts allowed (produce path drafts for the user to address).
- **Live proof:** outreach turn 2bb455af sealed with `## Ideal Customer Profile/Prospect List/Sequence/Success Metrics`; market turn 097fdf7b (post-fix) kind=market with `## Competitive Landscape/Where We Win/Threats & Gaps/Recommended Moves`. 4/4 unit checks (skeleton in for market/outreach answer, absent for general + email). "Competitive desk" marker in served chunk 84.02ec1810.
- **Known pending (user action, not code):** Gmail draft 403 persists until Gmail is reconnected to grant compose+send (current grant readonly, verified in oauth_scopes).

## prod-20260715-f98dce54 — Open dial allowlist (owner opt-out)
- **Parent:** `feat/open-dial-allowlist` @ `f98dce54` off singulance-main 68d957cd. tara-deepgram only.
- `*` in ALLOWED_NUMBERS (or DIAL_ALLOW_ALL=true) opens outbound dialing to any valid E.164; closed lists unchanged (fail-closed). Server env appended `*` (backup .env.bak-allowall). Owner accepts cost/compliance for open dialing.
- Verified in-container: allow-all True; 3/3 telephony tests pass; closed-list behavior regression-checked.

---

## Historical ingestion releases previously maintained in the docs ledger

## 2026-07-14 - Exact Evidence Segment Binding

- Release: `prod-20260714-0edec7e9`
- Source: `codex/ingestion-production-reconcile@0edec7e9`
- Scope: `hm-core` only; no frontend, control-plane, data service, employee, broker, or TARA rebuild.
- Image: `sha256:26a62545b1e518194b59d2f732d6dcca6f57aba81ab5a11653995d2846cdfa73`
- Rollback: `hivemind/core-api:rollback-20260714-pre-7c30d58a`

Acceptance:

- Linux focused tests: 27 passed, 0 failed.
- Re-windowed extracted claims now resolve their exact quote back to the persisted evidence segment instead of assigning segment IDs by window index.
- Document-level curation preserves the primary extraction window while retaining every supporting segment and quote for merged memories.
- Public health: PostgreSQL, Qdrant, and Docling reachable; evidence recall, document-first ingest, and entity extraction enabled.
- Runtime: healthy, zero restarts, no fresh fatal, uncaught, panic, or OOM log entries.

Pending controlled proof:

- Clear FOREST memories, upload one representative document, and audit raw document, segments, durable memories, evidence links, entities, typed relationships, recall, and chat before uploading the remaining corpus.
- Native `.amr` and live BYOD parity remain a separate release gate and are not claimed by this deployment.

## 2026-07-14 - Source-Grounded Ingestion Admission

- Release: `prod-20260714-7c30d58a`
- Source: `codex/ingestion-production-reconcile@7c30d58a`
- Scope: `hm-core` only; control-plane, frontend, data services, employees, BYOD broker, and TARA were not recreated.
- Stable image: `sha256:c5154bd66e05708a6b51bc774d1d4def4ba7c989a040c94e1d1dfab0fd09f35f`
- Rollback: `hivemind/core-api:rollback-20260714-pre-7c30d58a`

Acceptance:

- Linux image tests: 29 passed, 0 failed.
- Synthetic managed-FOREST upload: five durable memories plus one bounded document summary.
- Provenance: five exact evidence excerpts and five structural `PartOf` edges.
- Entities: only `FOREST`, `Atlas`, and `Mira Chen` were linked.
- Recall: CSS/markup durable-memory noise suppressed while raw evidence remains available.
- Tenant-scoped probes: Mira Chen decision 367 ms; escalation context 1.63 s; combined summary plus evidence 2.16 s.
- `/api/chat`: correct contract value and discount approver, grounded with six sources.
- Cleanup: synthetic document, memories, evidence links, and relationships all verified at zero.
- Runtime: healthy, zero restarts, no fresh fatal/uncaught/OOM log entries.

Residual proof boundary:

- Managed PostgreSQL plus Qdrant is production-proven by this release.
- Native `.amr` and live BYOD ingestion parity were not exercised in this acceptance run.
