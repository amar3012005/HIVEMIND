# Outreach Campaign Runner — Implementation Plan

Spec: `docs/superpowers/specs/2026-07-16-outreach-campaign-runner-design.md` (approved).
Branch model: BE branch off `origin/hivemind-main`; FE branch off Da-vinci prod head (check gitlink first — last session's stale-checkout gotcha). Deploy per `docs/PRODUCTION_RELEASE_PROTOCOL.md`.

Each phase: build → verify (stated command/check) → commit. No phase ships unverified.

---

## Phase 1 — Schema + migration (core)

**Files:** `core/prisma/schema.prisma`, new `core/prisma/migrations/<ts>_outreach_campaigns/migration.sql`

1. Add `OutreachCampaign` + `OutreachTarget` models exactly per spec (fields, indexes, cascade delete targets on campaign delete). Map names `outreach_campaigns`, `outreach_targets`.
2. Hand-write additive migration SQL (no `migrate dev` on prod path); include DOWN script in the migration folder as `down.sql`.
3. **Verify:** `npx prisma validate` + apply up AND down against local/dev Postgres; `\d outreach_targets` shows indexes.
4. Commit `feat(outreach): campaign + target tables`.

## Phase 2 — Campaign API (control-plane, core)

**Files:** `core/src/control-plane-server.js` (or extracted `core/src/outreach/campaigns.js` if server.js seam is clean — follow existing route-module pattern)

1. Routes per spec: create (snapshot from turn's `prospects` event — read from the turn record the sidecar stashes; eligibility filter per channel; cap 50; resolve senderEmail via existing platform_integrations query), get, start, stop, patch target (deselect/edit payload with state guard), execute passthrough marker, SSE events endpoint (or long-poll v1).
2. Tenant scoping on every query (userId+orgId from session). Zod/manual validation on all bodies.
3. `lastTickAt` bumped on every state write.
4. **Verify:** curl matrix against local core — create/start/stop/patch/illegal-transition(409)/cross-tenant(404) — plus unit tests for the state machine.
5. Commit `feat(outreach): campaign lifecycle API`.

## Phase 3 — Generation endpoints (employees sidecar)

**Files:** `employees-service/src/hivemind_employees/api_hyper_rooms.py` (new router section or `api_outreach.py`), `hyper/engine.py` helpers reuse

1. `POST /internal/outreach/generate` `{campaign_id, target_id}` — loads campaign+target+sealed report body; email channel: personalized `{subject,body}` using SENDER IDENTITY contract + Subject:-extraction (reuse shipped code paths, no duplication); call channel: `{goal, opener}`.
2. Control-plane `targets/:tid/generate` proxies here; writes payload + `ready`.
3. **Verify:** AST-OK + in-container test call against a real sealed outreach turn from prod-format fixture; email payload signs off with sender address, subject clean; call payload goal references the firm.
4. Commit `feat(outreach): per-prospect email + call-goal generation`.

## Phase 4 — Execute: email lane

**Files:** `core/src/control-plane-server.js` outreach section, reuse `core/src/connectors/providers/gmail/adapter.js` send path

1. `execute` (email): guard state `ready`→`sending`; send via google-native Gmail (existing send fn used by approval cards — reuse, don't fork); write `OutboundAction` (threadId for reply-match); target `sent` + `resultRef.outboundActionId`. Failure → `failed` + error verbatim; 401 → campaign `paused` + `resultRef.error='gmail-reauth'`.
2. Server-side throttle guard: reject execute if last email execute for this campaign <8s ago (FE also paces; BE enforces).
3. Idempotency: if target already has `resultRef.outboundActionId` → return existing, never resend.
4. **Verify:** integration test with mocked Gmail (happy, fail, 401-pause, double-execute idempotent). Then ONE live send to amarsai2005@gmail.com.
5. Commit `feat(outreach): email execute lane`.

## Phase 5 — Execute: call lane (TARA)

**Files:** core outreach section; `services/tara-aaas/tara_aaas/telephony/outbound_api.py` (accept goal directive); voice-v2 router directive seam

1. Extend `OutboundCallRequest` with optional `directive` (goal+opener); thread into the session's voice-v2 turn router as the campaign directive.
2. `execute` (call): state guard; dial via TARA `POST /calls/outbound`; store `taraCallLegId`; status chip states from call-status polling (`GET` status fn exists); call-end webhook (existing insight hook) finalizes target `sent`/`failed:no-answer` + writes `OutboundAction(kind='call')` if not already.
3. Serial guard: reject execute while another target in this campaign is `sending`.
4. **Verify:** mocked-Telnyx integration test; then ONE live TARA call to owner's number with a generated goal — confirm TARA opens with the opener and pursues the goal.
5. Commit `feat(outreach): TARA call execute lane with per-prospect goal`.

## Phase 6 — Drain worker (employees sidecar scheduler)

**Files:** employees sidecar scheduler module (existing cron pattern)

1. Every 2 min: campaigns `running` with `lastTickAt` > 5 min stale → BE takes over: iterate remaining `selected`/`ready` in position order, generate+execute, honoring throttle/serial rules. `sending` older than 10 min → check `OutboundAction` ledger before deciding retry vs mark-sent.
2. **Verify:** integration test — start campaign, kill FE loop mid-run, assert drain finishes remainder exactly once (ledger count == target count, no dupes).
3. Commit `feat(outreach): drain worker — campaigns survive tab death`.

## Phase 7 — FE campaign panel (Da-vinci)

**Files:** `frontend/Da-vinci/src/components/hivemind/app/pages/HyperAgents.jsx` + new shared `hyperagents/CampaignPanel.jsx`; `shared/api-client.js`

1. Buttons under prospect stack on sealed turns: "Send outreach emails (N)" / "Start outreach calls (M)" (eligibility counts). Room-agnostic: keyed on prospect events, not room kind.
2. CampaignPanel: target checklist (select/deselect any time; disabled once sent), expandable payload editor (subject/body or goal/opener), progress bar k/N, Start/Stop/Resume, per-card chips (sent/failed+reason/skipped/dialing/in-call), FE one-by-one loop with 8s email pacing, SSE/poll subscription.
3. Match hivemind-frontend design tokens (invoke `hivemind-frontend` skill before writing).
4. **Verify:** babel parse + `ui-preview` screenshot of panel states (running, paused, mixed results); live click-through against local BE.
5. Commit FE, push, bump parent gitlink (against CURRENT prod FE head — verify with `git ls-files --stage frontend/Da-vinci` on hivemind-main first).

## Phase 8 — Ship + live acceptance

1. PRs → hivemind-main (reversible protection bypass, restore after), release `prod-YYYYMMDD-<sha>` per protocol: rebuild core (schema+routes), employees (generation+drain), fe; migration applied before code promote; rollback tags; ledger entry.
2. **Live acceptance (the real gate):**
   - outreach room turn → prospect stack → "Send outreach emails" → 2-target campaign to amarsai2005@gmail.com — watch progress bar tick one-by-one, stop mid-run, deselect one, resume; verify sender = connected Gmail, subject clean, body personalized per firm.
   - "Start outreach calls" → 1 live TARA call to owner's number with edited goal.
   - kill tab mid-campaign → drain finishes; no double-send (ledger check).
3. Save HIVEMIND memory (master-index + decision log), update ONBOARDING if operational steps changed.

---

## Order + parallelism

1 → 2 → {3, 4 after 2} → 5 → 6 → 7 (can start after 2 with mocked API) → 8.
Phases 3+4 parallelizable; 7 parallel with 4–6 against mocks.

## Risk register

- **Gmail throttling/spam flag** — 8s pacing + cap 50 + user-initiated; monitor first campaigns.
- **Double-send** — ledger-first idempotency in execute + drain; tested explicitly (Phase 6.2).
- **TARA single-line contention** — serial guard; a second campaign's call waits (v1: reject with clear error).
- **Schema on prod** — additive only, down.sql present, backup before migrate per protocol.
- **Consent/compliance** — B2B cold outreach to Impressum-published business contacts; user-initiated per campaign, sent from user's own Gmail identity. No auto-send without click in v1.
