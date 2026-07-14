# SINGULANCE Production Release Ledger

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
