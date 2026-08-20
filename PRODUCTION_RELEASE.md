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

## prod-20260715-bb57af40 — Google Maps connector + hyperagents elements UI
- **Merged to hivemind-main:** #16 (squash 123d510e); FE #2 (Da-vinci). Canon = deployed content.
- **Parent SHA (pre-squash):** bb57af40 (= codex recall 3baea859 + maps cherry-pick). FE gitlink f0f9a350.
- **core digest:** sha256:06d4da0b… ; services: core-api, fe rebuilt; employees/control/tara retagged.
- **Verified:** 13 catalog connectors incl. google-maps seeded; elements markers (Gmail gate / EmailBlock / Maps tile) in served bundle; public 200×4; health green.
- **Aliases:** stable + latest → this release (all services). Rollback: prior timestamped tags retained.
- **Migrations:** none. **Action:** create Google Maps integration in Nango dashboard so tenants can connect.

## prod-20260715-418d3b29 — Impressum contact enrichment (outreach recipients)
- places_search now scrapes each firm Impressum/Kontakt → best email (named>role>weak, own-domain preferred).
- Live: 20 Hannover consultancies → 9 with real emails (incl. named: Scheiber@rundstedt.de, mh@markus-huebner.com). Recipient resolution now passes.
- Remaining block is USER-side: org Gmail grant is readonly; send 403s until reconnect grants compose+send.
- Chain proven: places_search (phones) → impressum (emails) → recipient resolved → Gmail API reached.

## prod-20260807-9d24b7fd — /chat orchestrator: evidence budget + parallel tool calls + compound orchestrator (flag-off)
- **Date:** 2026-08-08
- **Parent:** branch `claude/fervent-tesla-7830e1`, SHA `9d24b7fdcfa8e9714ea7b31b74a25ea1b5fe997b`
- **Frontend:** unchanged
- **Three independently-revertable phases for /api/chat (runReactAgentV2):**
  1. **Token efficiency (Phase 1):** combined evidence budget (`HIVEMIND_ANSWER_EVIDENCE_CHAR_BUDGET`, default 12000) with priority-ordered whole-section truncation of the 4 lowest-priority evidence sections; groundedEvidence + citation registry always kept. Cheaper repair pass (`HIVEMIND_REPAIR_MAX_TOKENS`, default 1500, capped to answerCap; reasoning forced low).
  2. **Parallel tool calls (Phase 2):** independent tool calls in a round run via Promise.all (dependency-aware via prior tool_call_id); order preserved. Both the read loop and runActionSubLoop.
  3. **Compound orchestrator (Phase 3):** new `compound-orchestrator.js` + `compound_plan` router capability + `compound` operation. Reads via ConnectorRuntime.executeTool; writes via legacy pendingWrite draft flow. **Flag-gated `COMPOUND_ORCHESTRATOR_ENABLED` (default false — OFF at deploy).** draft_created reported as pending, never done.
- **Tests:** 4/4 compound-orchestrator unit tests; 6/6 chat-intent-decision + chat-router-architecture; synthetic Phase 1 truncation + Phase 2 parallelism tests.
- **Image:** `hivemind/core-api:prod-20260807-9d24b7fdcfa8` (built). hm-core recreated, healthy.
- **Acceptance evidence:** public 200 ×4. In-container grep verified all three phase markers in the RUNNING container. Live /api/chat smoke: recall grounded with bounded prompt tokens (5613), temporal routes to clarification, greeting direct (3293 prompt). Compound flag UNSET (off).
- **Rollback:** tag `hivemind/core-api:prod-20260807-5ca742275da4` in `/root/.last-core-rollback`; compose tag swap + `up -d --no-deps core`.
- **Untested side effects:** compound orchestrator not exercised live (flag off); no emails/calls placed.

## prod-20260808-d9f497b9 — /chat generalized small-detail evidence delivery
- **Date:** 2026-08-08
- **Parent:** branch `claude/fervent-tesla-7830e1`, SHA `d9f497b9`; core image `hivemind/core-api:sha-d9f497b`.
- **Behavior:** structured chat keeps a bounded multilingual semantic recovery pool only when the ordinary relevance floor has no viable rows; authorized full ranked rows are passed internally to a semantic passage projector. No domain keyword list or language-specific detail rule was added.
- **Failure safety:** the toolkit now allowlists only the new server-owned recall controls. If semantic projection times out, synthesis receives the complete highest-ranked memory under one global 12,000-character guard, then compact lower-ranked previews; it no longer receives equal prefix truncations that can hide a late fact.
- **Routing:** a model-selected semantic clarification is grounded through recall before asking the user. Greetings/arithmetic and safety refusals retain the direct path.
- **Tests:** Linux production-runtime checks passed: 4/4 projector tests, 4/4 toolkit validation/security tests, initial-recall contract, and progressive semantic-fallback contract. Local macOS aggregate remains blocked by the existing missing `singulance-amr` darwin-arm64 binary.
- **Live acceptance:** tenant-scoped `/api/chat` answered the same buried rank-1 memory detail in English and German as `G ROCHER`, and a separate Spanish small-detail query as dark brown; all were grounded and cited memory `b021510a-c979-47c7-8621-7e3991c9154f`. Projector-timeout runs still answered correctly. Observed prompt tokens: 6,476-7,102; global fallback stays bounded rather than silently removing rank-1 detail.
- **Deployment proof:** canonical release gate passed; `hm-core` healthy on revision `d9f497b9`; manifest `/root/releases/d9f497b/RELEASE_MANIFEST.20260808T115026Z.json`.

## prod-20260815-fac0a34a2e4b — interactive recall isolation and pass telemetry
- **Date:** 2026-08-15
- **Parent:** `singulance-main` at `fac0a34a2e4bd81c9c72784ba86577bdbbe92232`; frontend unchanged (`4d3dcabb2da8a66560171240db5c5fc9a3ccbdb4`).
- **Behavior:** native interactive recall uses a bounded FIFO transport class (default 2 concurrent requests per org), coalesces identical in-flight Memory Box recalls, and keeps vector reconciliation/repair on a separate one-concurrent maintenance circuit. A maintenance timeout can no longer open the interactive chat circuit.
- **Ranking and progression:** one mixed memory/evidence rerank remains authoritative. Chat traces report `retrieval_passes`, `rerank_passes`, `rerank_ms`, `synthesis_passes`, and progressive expansion count. Ranks 6–15 are revealed only after a grounded cited claim marks the first page relevant but incomplete; no retrieval or rerank occurs during expansion.
- **Safety:** Composio, approval, draft, and connector execution paths were unchanged. No migrations or external provider writes.
- **Tests:** remote vector recovery 9/9; progressive/chat architecture 11/11; rerank/evidence-contract 6/6. The production Docker build gate initially caught an unbound telemetry accumulator; it was fixed in `b94e6646` and the corrected clean build passed before promotion.
- **Image:** `hivemind/core-api:prod-20260815-fac0a34a2e4b`, digest `sha256:1c4a7889ffaac94e525d17615cad5c4af66aaf5ceb2237b4a24deb9248d1c01a`; `hm-core` healthy.
- **Acceptance:** public homepage, HIVE-MIND app, API health, and Core health returned 200. Authenticated native chat: one retrieval, one rerank (397 ms), one synthesis, no transport failure. Authenticated `use_tools:true` native recall: one retrieval, one rerank (324 ms), no draft or external execution.
- **Rollback:** `hivemind/core-api:rollback-20260815-083924` → `sha256:37ea868921623210bfcef0d8280d5cddc0c6f74d5b485330c9694c09830819f3`.

## prod-20260815-895d336ed311 — terminal chat-stream error handling
- **Date:** 2026-08-15
- **Parent:** `singulance-main` at `895d336ed311ca95aecc8ad13f7e183fb6bcb65a`; frontend `72ce0b6d2df3c22bd486f946fbca1b12d92e0d8f`.
- **Behavior:** desktop Overview and Talk-to-HIVE Mobile accept LF and CRLF SSE framing, treat Core's terminal `error` event as a terminal result, and show its actual message. A stream that closes before any terminal event now renders a clear retryable error instead of dereferencing `null.response`.
- **Scope:** frontend only; no Core, recall, model, connector, approval, or data-path behavior changed.
- **Build and acceptance:** clean production Docker build completed; `hivemind-next-frontend-1` runs `hivemind/fe:prod-20260815-895d336ed311-single`, public homepage, HIVE-MIND app, API health, and Core health returned 200.
- **Rollback:** `hivemind/fe:rollback-20260815-090747-single` retained.

## prod-20260815-cd806b6f — production error recovery and tenant-safe PageIndex
- **Date:** 2026-08-15
- **Parent:** `singulance-main` at `cd806b6fd80f4085234df221e7935f3c28d78894`; frontend unchanged and running `hivemind/fe:prod-20260815-5c9cc1359b1a-single`.
- **Memory Box isolation:** scheduled vector maintenance quarantine is persisted in the remote-agent registry and survives Core restarts. The stale box remains registered for interactive/recovery use but is excluded from scheduled maintenance until its quarantine expires; the active tenant remains scheduled.
- **Connector recovery:** Core reaches Nango over `http://nango:8080`. Permanent legacy Gmail credential failures now disable only the affected watcher rows with `credentials_invalid_reconnect_required`; transient watcher failures remain active and observable. Live reconciliation disabled the two stale rows once and the next pass checked zero rows with zero failures.
- **PageIndex correctness:** removed the erroneous global `PageIndexNode.path` unique index while retaining `(user_id, path)` uniqueness, and changed root/child creation to tenant-scoped atomic upserts. This fixes the repeated `PageIndexNode_path_key` errors and permits every user to own the canonical `/hivemind` root.
- **Migration:** PostgreSQL backup `/root/backups/hivemind-before-pageindex-20260815T110541Z.dump` (117 MB, SHA-256 `f357e64aae7b3b4f74c8520de5b26bb0447529c295b35373d4aec055c91399fd`). Production was never Prisma-baselined and correctly rejected `migrate deploy` with P3005, so the reviewed migration SQL was applied transactionally: drop only `hivemind."PageIndexNode_path_key"`. The tenant composite index remains. Two real users then created/resolved distinct `/hivemind` roots successfully.
- **Tests:** 15/15 focused PageIndex, Nango routing, Gmail reconciliation, and remote vector recovery tests; production image build gate 21/21. Prisma schema valid and `git diff --check` clean.
- **Image:** `hivemind/core-api:prod-20260815-cd806b6f`, digest `sha256:bdb15ed0e27569c3bb2a46d849e3254f1429b5383834ba9b6fa5e9f2d58acb60`; `hm-core` healthy with zero restarts.
- **Acceptance:** authenticated Solvis chat returned a grounded 0.92-confidence answer with one retrieval, one unified rerank, top-five evidence, one synthesis pass, and no expansion. Four public gates returned 200. A fresh scan of every running container found no fatal, panic, uncaught, OOM, migration, duplicate-key, bulkhead, circuit, timeout, or application error after promotion.
- **Rollback:** `hivemind/core-api:rollback-20260815-pageindex` points to the prior accepted Core image; the verified PostgreSQL backup is retained.

## prod-20260815-77fb383d — bounded stage deadline listener fan-out
- **Date:** 2026-08-15
- **Parent:** `singulance-main` at `77fb383da15b2a343522982b5ec1eef69ee231ca`; frontend unchanged.
- **Behavior:** each server-owned stage deadline signal has a finite 32-listener budget (minimum 16) for the designed vector, lexical, graph, evidence, and connector fan-out. This removes the false `MaxListenersExceededWarning` at normal recall concurrency without globally disabling leak detection; a runaway above the finite ceiling remains observable.
- **Tests:** focused stage deadline, intent, PageIndex, and remote recovery suites 21/21; production image build gate 21/21.
- **Image:** `hivemind/core-api:prod-20260815-77fb383d`, digest `sha256:b5f977824eb62beeffdef95ec715f9c95b16922814ba6a4a7badeeab9cf2dad4`; healthy with zero restarts.
- **Acceptance:** authenticated Solvis chat returned 200, a grounded 0.95-confidence answer, one retrieval, one unified rerank, top-five evidence, one synthesis, and no expansion. The warning did not recur. Two Control proxy errors occurred only at the exact Core replacement timestamp and did not recur after readiness. Four public gates returned 200.
- **Rollback:** `hivemind/core-api:rollback-20260815-listeners` points to accepted `prod-20260815-cd806b6f`; the PageIndex database backup remains retained.

## prod-20260815-effe8a0f — SOLVIS corpus acceptance and project-safe hybrid recall
- **Date:** 2026-08-15
- **Parent:** `singulance-main` at `effe8a0f4ae582541437a22aa9a303f14f6f000f`; frontend unchanged.
- **Corpus acceptance:** created isolated evidence-only project `7c73ffb1-6443-477c-89b6-45630008da88` and both-mode project `3fce3672-61de-47a7-afd7-3185a2ce3751` for user-authorized SOLVIS validation. Evidence-only: 38 parsed documents, 1,822/1,822 vectorized segments, zero memories and zero memory-evidence links. Both: 38 parsed documents, 1,837/1,837 vectorized segments, 708 memories including 15 image memories, 698 evidence links, 1,065 relationships, 574 memory-entity links, and 272 canonical entities.
- **Ingestion correctness:** PRs #253-#256 added pre-persistence credential redaction, project-safe document deletion, process-wide FIFO PDF rasterization, strict structured-claim validation/model capability caching, and image-upload idempotency. Thirteen credential occurrences across two documents were redacted before storage/embedding; forbidden samples are absent. Five duplicate image memories created before the idempotency fix were removed through the tenant-scoped API; repeat upload now returns the existing canonical memory.
- **Recall correctness:** PRs #257-#260 make an explicit project a hard evidence boundary in bounded and compatibility modes, re-check Qdrant candidates against the canonical Postgres document allowlist, and add a language-independent adjacent phrase lane before broad lexical candidates. Exact Roadshow detail now ranks first from evidence (`30-150`, average `45`) and grounded chat answers it correctly. No language/domain keyword patch was added.
- **Latency/ranking:** PR #261 promotes `voyageai/rerank-2.5-lite` to primary with Cohere fallbacks after repeated Cohere first-attempt aborts. Five post-release runs used exactly one unified rerank each, 287-351 ms rerank latency, retained the correct top evidence, and stabilized at 2.05-2.39 s warm raw recall after the cold run. Final grounded Nitro synthesis returned the exact answer in 6.00 s. No progressive recall expansion was used.
- **Operational cleanup:** removed the dead zero-user self-host registry entry for org `b30ead1b-288f-4e79-8399-b3fef63b7cb8`; recoverable backup `/app/data/byod-agents.json.quarantine-20260815-b30ead1b` retained. Running Core env and image were verified after recreation: `RERANK_MODEL=voyageai/rerank-2.5-lite`, `hivemind/core-api:sha-effe8a0f`, healthy.
- **Tests and logs:** evidence/project suites 23/23, evidence phrase suite 22/22, recall route/scope 12/12, rerank policy 3/3. Post-release Core, Control, Employees, and Docling scans contain no application errors, reranker aborts, bulkhead/circuit failures, or ingestion failures.
- **Rollback:** prior immutable Core manifests remain under `/root/releases/`; reranker env backup `/root/hivemind/.env.backup-voyage-primary-20260815` and quarantined registry backup are retained.

## prod-20260816-a9e4a970 — durable AI Meeting Notes finalization and AMR parity
- **Date:** 2026-08-16
- **Parent:** `singulance-main` at `a9e4a970387913e0bf2dbee6f9f2d8099a06a0ac`; frontend submodule `40986e8f`.
- **Durability:** recording sessions, raw audio, transcript segments, extraction state, finalization payload, retry attempts, retry time, lease expiry, and finalized meeting ID are persisted. Insights/report generation is server-owned and resumes after browser or Core interruption.
- **Shared analysis:** the compatibility insights route and durable worker use one multilingual map/reduce generator. Thirty synthetic ten-minute windows retained every transcript character and bounded provider concurrency to two windows.
- **AMR:** self-host sessions expose create/list/status/finalize parity; raw audio and final meeting rows stay in tenant PostgreSQL. Agent settlement uses explicit PostgreSQL parameter casts after a production canary exposed and fixed ambiguous status typing in PR #286.
- **Recovery UX:** desktop and global recorder clients poll authoritative session state, automatically resume queued/analyzing/error work, and clear browser recovery data only after the final meeting row is durable.
- **Migration and storage:** verified backup `/root/backups/meeting-finalization-20260816T043352Z.dump` (127 MB plus SHA-256 sidecar). Four additive meeting migrations applied. `MEETING_AUDIO_STORE_DIR=/app/data/meeting-audio` and `MEETING_AUDIO_STORE_DURABLE=true` use the persistent Core data volume.
- **Tests:** 22 focused meeting lifecycle/intelligence tests plus the AMR settlement regression; Prisma validation; Core/BYOD/embedded syntax; frontend production build.
- **Acceptance:** central 30-segment restart canary finalized after Core restart with 128,739 transcript characters, no gaps, and first/last markers present. AMR canary finalized three tenant-owned segments with no gaps and first/last markers present. Exact canary rows were removed afterward.
- **Images:** Core, Control Plane, Employees, and frontend run revision `a9e4a970`; BYOD agent runs `hivemind/hm-agent:sha-a9e4a970`. Manifest `/root/releases/manifests/a9e4a970/20260816T045504Z/RELEASE_MANIFEST.json`.
- **Rollback:** per-service `rollback` aliases and `hivemind/hm-agent:rollback-settle` retained; verified database backup retained.

## prod-20260816-4fd255f5 — Gateway-first inference and production log hygiene
- **Date:** 2026-08-16
- **Parent:** `singulance-main` at `4fd255f5ba564eb52e95846ca36c843dc74fcb31`; frontend unchanged.
- **Gateway coverage:** server-owned text, embeddings, external reranking, image generation, HTTP speech inference, and supported Deepgram/Cartesia realtime WebSockets route through authenticated Cloudflare AI Gateway. Provider/model policy is unchanged and Gateway failure is not replayed directly upstream.
- **Log hygiene:** reranker attempts collapse into one final degradation warning; repeated Memory Box circuit/list errors are tenant/operation/error-class rate-limited; Turing source internals are debug-only; unchanged zero-state Employees reconciliation is silent. First failures, state changes, non-zero work and errors remain visible.
- **Tests:** 16 Node Gateway/reranker tests, 3 Employees Gateway tests, 3 TARA Deepgram Gateway tests, 1 TARA AAAS Gateway test, Python compileall, Node syntax and graph review.
- **Acceptance:** Core, Employees and TARA Deepgram are healthy at revision `4fd255f5`, zero restarts. OpenRouter embedding through Gateway returned HTTP 200 in 756 ms with 1,024 dimensions. Cloudflare logs show successful chat and rerank calls, including GPT-OSS 20B/120B, Nemotron and Cohere rerank, with no direct-provider replay. Deepgram realtime route resolves to the authenticated Gateway WebSocket endpoint.
- **Known independent issue:** broad Solvis chat synthesis remains intermittently unstable (`candidate_synthesis_validation_failed` / synthesis timeout) even though Gateway requests return HTTP 200; this is a grounded-synthesis/model-contract issue, not a Gateway transport failure, and is not hidden by this release.
- **Manifest:** `/root/releases/manifests/4fd255f5/20260816T214510Z/RELEASE_MANIFEST.json`.
- **Rollback:** canonical release aliases for Core, Employees and TARA Deepgram retain the previously accepted `3a87f0a3` images.

## prod-20260820-1fbaac3f — chat answer depth and Memory Box hydration fan-out
- **Date:** 2026-08-20
- **Parent:** `singulance-main` at `1fbaac3fd5f8ac25c00cda9314e214fbeba6fb86`; frontend unchanged.
- **Chat delivery:** the planner-selected window remains one pass: standard turns see the focused five-result window; detailed and comprehensive turns retain their selected broad window and use a rank-preserving coverage pack, without a second semantic-projection embedding pass. Fallback excerpts retain opening context and closing qualifiers rather than silently clipping to a prefix.
- **Synthesis:** detailed/comprehensive responses explicitly enumerate distinct supported findings from their delivered window and use deliberate final-synthesis reasoning; concise standard turns retain the lower-latency focused policy.
- **Memory Box transport:** grounded chat does not hydrate display-only synthesis-card evidence. Rich recall keeps that feature, but hydrates its supporting rows once in a batch. Graph expansion now batches neighbour hydration too, instead of fanning out a request per neighbour.
- **Scope:** native `use_tools:false` recall/chat only. Composio routing, approvals, writes, and `use_tools:true` execution were unchanged. No migrations or provider writes.
- **Tests:** 17 focused synthesis, evidence-projection, and progressive-router contracts passed; syntax and diff checks passed.
- **Acceptance:** authenticated read-only chat for the same tenant passed at standard, detailed, and comprehensive depth. Detailed returned four distinct supported facts; comprehensive returned the two distinct recorded remarks. Traces showed semantic projection only for the standard turn and rank-preserving coverage for broad turns. Fresh Core logs contained no hydration queue-full, listener, reranker-degradation, projection-timeout, fatal, or uncaught errors.
- **Images:** Core `hivemind/core-api:sha-1fbaac3f` (`sha256:fe9e21dfe7e336ea36c774bcccec3e2f29579c3f51c51c84378413c509dee6d1`), Control Plane (`sha256:276eec2de38bc78e8e0b260e773902e8294e72e67785d8e496a780a6ac4218c4`) and Employees (`sha256:4bf0bff3385bc35b87a89e1a1e59972a4b17d354f522abc57b8099e1be86cd56`) all run `sha-1fbaac3f`, healthy.
- **Rollback:** immutable preceding release images `sha-71b0806a` remain available through the release rollback aliases.
