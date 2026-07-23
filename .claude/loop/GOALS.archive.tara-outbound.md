# Archived Goal Queue — TARA Outbound Voice Campaigns

> Historical record only. Do not execute commands or revive services below.
> Current TARA authority is `.claude/decision_docs/TARA.md`.

The loop works these **top-to-bottom, one at a time**. While any `[ ]`/`[~]` goal
remains, the Stop hook (`.claude/hooks/goal-loop-stop.py`) blocks the session from
ending and re-injects the current goal — so "keep going" is the default.

Status: `[ ]` pending · `[~]` in progress · `[x]` shipped+verified · `[!]` blocked (needs human → pauses the loop)

**READ FIRST:** `.claude/sprints/tara-outbound/CHARTER.md` — mission, ground rules
(recon-before-build · no patchwork · verify-before-ship · **Workflow tool BANNED, agents only**),
per-goal pipeline, safety invariants. `.claude/loop/LOOP.md` = loop protocol.

**Per-goal pipeline:** feature-recon (grep ground-truth, not stale graph) → plan → build
(surgical, reuse>rebuild) → compile/typecheck GATE → deploy (docker cp + restart) → e2e
VERIFY on box BEFORE push → ship (author amarsai3012005; main=prod) → JOURNAL + memory → mark `[x]`.

**SAFETY INVARIANT:** the loop NEVER autonomously dials a real number or writes a real
contact/CRM record. Build/test against **mocked telephony + the internal test number ONLY**.
Every real-call / real-send step is a hard `[!]` human gate. The loop builds the gun; a human pulls the trigger.

---

## Phase 0 — decisions (RESOLVED 2026-06-21 — locked)
- [x] Telephony provider = **Telnyx** (managed M1; self-host Jambonz on EU box later via same SIP trunk).
- [x] Scope = **B2B-first** (IE/NL/FR legitimate-interest; DE/IT B2C deferred).
- [x] Recording = **opt-in per campaign** (off by default).
- [x] STT/TTS residency = **keep Groq+Cartesia (US), document gap** (EU fallback = parallel trust-track, not MVP blocker).

---

## Phase 1 — Telephony spine  (skill: ship-feature; ends at human gate)
- [x] **Telnyx adapter in `tara-aaas`** — built `b44527f4`; tests + deploy `709ad580`. `telephony/audio_bridge.py` (μ-law↔PCM16 8k↔16k, stdlib audioop), `telnyx_bridge.py` (phone voice loop), `outbound_api.py` (dial+webhook+hangup+status), `config.py` + `app.py` wired flag-gated. Unit tests `tests/test_telephony.py` (8/8): codec round-trip (frame shapes, signal energy, cross-chunk ratecv state) + mocked webhook (answered→streaming_start, unknown-leg noop, hangup cleanup, allowlist reject). Container was 2wk-stale (predated telephony); redeployed via redeploy.sh → box verify GREEN (codec + webhook live in tara-aaas py3.11).
- [x] **AI-disclosure + consent-intro at call open** — `greet_with_disclosure()` (`telnyx_bridge.py`) speaks fixed Art.50 disclosure via Cartesia before HIVEMIND greeting, graceful TTS fallback. Shipped `d69647bb`: extracted `_DISCLOSURE`/`ai_disclosure` → dep-free `telephony/disclosure.py` (testable without STT/TTS imports); 13 unit tests (EN default, DE, unknown-lang→EN, case/region-insensitive, None-safe, Art.50 "states it is an AI" invariant). 21/21 pass; box verify GREEN (disclosure+telnyx_bridge import + /health). LIVE-CALL verification of the spoken greeting = the P1.3 human gate below.
- [!] **HUMAN GATE — one supervised real call to the internal test number ONLY.** Prereq: P0 Telnyx creds in env (TELNYX_API_KEY, TELNYX_APP_ID, TELNYX_FROM_NUMBER, TELNYX_ALLOWED_NUMBERS). Loop stops; human places/observes; mark `[x]` after audio round-trips both ways.

## Phase 2 — Data + compliance foundation  (skill: feature-loop; loop-safe)
- [x] **Prisma migration**: `tara_campaigns, tara_campaign_contacts, tara_call_attempts, consent_ledger, dnc_list` — shipped `5874343a`. Tenant-scoped (org_id+user_id), explicit cascade FKs + indexes; down.sql alongside. NOTE: campaign call-list table named `tara_campaign_contacts` (E.164 phone) to avoid collision with existing gmail-derived `contacts`. GATE PASSED: tested up+down on box in rolled-back txn (5 tables created, FK cascade confirmed, down clean); then applied for real to prod + recorded in _prisma_migrations (box-pull blocked by uncommitted prod hotfixes → applied DDL directly, idempotent IF NOT EXISTS, future migrate deploy reconciles no-op). Cores untouched + healthy. No code consumes tables yet (Phase 3).
- [x] **Compliance gate module** — `core/src/tara/compliance-gate.js` `evaluateGate()`, shipped `5b7ca9b1`. Pure/deterministic, default DENY, fixed order: DNC → lawful basis → country (B2B legit-interest IE/NL/FR; DE/IT B2C skip; consent overrides; unknown block) → calling hours (contact-tz via stdlib Intl, Mon-Fri 09-20 default) → concurrency+daily caps. All state passed in (replica-safe). 20-branch test matrix 20/20 — local + prod Node v20.20.1 in hm-core. No consumer yet (Phase 3 worker wires it) → no restart.
- [x] **`call_attempt` state machine** — `core/src/tara/call-attempt-state.js`, shipped `47838326`. Pure DAG queued→gated→dialing→{no_answer|voicemail|connected|failed}→{declined|completed|callback}→done; gated→skipped (gate-deny), callback→queued (re-enqueue); terminal {done,skipped}. canTransition/assertTransition guard every status write (out-of-order webhook can't corrupt); dialOutcomeToState maps Telnyx outcomes. 14 transition tests (incl. reachability BFS + no-typo invariant) 14/14 local + prod Node v20.20.1 in hm-core. No consumer yet (Phase 3).

## Phase 3 — Campaign engine  (skill: feature-loop; loop-safe, MOCKED dialer)
- [!] **`/api/tara/campaigns` CRUD** — create/launch/pause/status/results. GATE: live-endpoint smoke, real auth, on box. **BLOCKED (ops/human decision):** the box (/opt/HIVEMIND) has ~1450 lines of UNCOMMITTED tracked prod hotfixes never pushed to git — `employees-service/api_hyper_rooms.py` (1352 lines), `db.py` (+202), `hivemind_client.py` (+60), `control-plane-server.js` (+87), `tara/stream-handler.js`, `prompt-builder.js`, `catalog-seed.js`, `core/data/mcp-connectors.json`, `prompt-tune.mjs`. This blocks `git pull` so no new core code can deploy; and `control-plane-server.js` (where campaign routes live) is itself diverged, so a docker-cp would overwrite a live hotfix. Loop must NOT `--force-clean` (destroys live prod work not in git). HUMAN must reconcile: commit/cherry-pick the box patches back into git (then pull cleanly), or explicitly bless discarding specific files. All Phase 3+ core-deploy goals wait on this.
- [ ] **BullMQ worker** — fan out contacts→jobs, enforce caps + calling-hours, retries/backoff, **gate-before-dial**. GATE: drain a queue against **mocked dialer**, assert skips + dispositions. NO real calls.
- [ ] **Per-call result wiring** → disposition + transcript + `session-analytics`. GATE: simulated call → rows written.

## Phase 4 — Wizard + dashboard  (FE pipeline: CI build + ui-preview; theme `hivemind-frontend`)
- [ ] **Campaign Wizard** (5 steps: list → agent+goal → window+caps → compliance gate → launch) as a new TaraConfig tab. GATE: `npm run build` CI=true clean + ui-preview screenshot.
- [ ] **Live dashboard** (dialing/connected/completed/disposition/callbacks). GATE: build + screenshot.
- [ ] **Compliance-gate UI** — launch blocked until green. GATE: build + screenshot.

## Phase 5 — CRM write-back + aggregate intelligence  (skill: feature-loop)
- [ ] **CRM write-back** of outcomes (reuse existing connector). GATE: write to a **throwaway test CRM record** only.
- [ ] **Campaign funnel rollup + feed insights → HIVEMIND**. GATE: endpoint smoke.

## Parallel — enterprise trust (interleave as `[ ]`)
- [ ] Recording-consent flow (opt-in path). · [ ] PII redaction before transcripts hit memory. · [ ] RBAC + audit log on campaign config/listen. · [!] EU-hosted STT/TTS fallback (decision-gated).

## Pre-launch (hard `[!]` — the loop does NOT cross)
- [!] Before ANY real-prospect dial: full compliance gate green e2e + legal/DPO sign-off + opt-out tested + AI-disclosure verified live.

---

## Done (shipped + verified)
- [x] **FE Outbound tab** — `OutboundPanel` in `TaraConfig.jsx`: phone input (E.164 valid), Call button, status polling, End Call (hangup), "View transcript in Call History" link. CI build clean. Da-vinci `dcf4f60`.
