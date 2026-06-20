# HyperAgents Room — Phase 1 (ordered producer + honest seal + capability-aware plan)

**Status:** approved 2026-06-20. Phase 1 of the multi-round redesign. Phase 2 (agent-owned
writes, per-stage recon, swarm-on-evidence) is deferred behind a flag, eval-gated.

## Why
Real run ("write a mail to Rama about all critical dates through a sheet") failed 3 ways:
1. **Dependent chain** sheet→email: producer makes exactly ONE artifact of ONE
   `intended_output`. Planner picked `email`, so the sheet was never made and the mail
   carried a fabricated `UNVERIFIED_SHEET_ID`.
2. **No honest dead-end**: empty KB (no dates) ⇒ agents correctly refused to fabricate, but
   the room looped to the goalkeeper cap and emitted UNVERIFIED placeholder drafts instead
   of sealing with *why* it stopped.
3. **Un-doable criterion**: `done_criterion` demanded "shared with Rama" — no share tool
   exists, so recon could never pass.

Phase 1 fixes all three on the **proven centralized producer** — no owner re-arming.

## Core constraint (folded in)
The producer is a **tool-agnostic registry** `kind → producer fn`. `answer`/`decision` =
no-op (the synthesis IS the deliverable). New connectors register a producer; the produce
loop, blackboard, plan, verify, and persist spine never change. Toolkit grows horizontally.

## Anchors (verified 2026-06-20, commit 917ba3ab, branch main)
- `_produce_output(req, final_text)` — `api_hyper_rooms.py:3936`. **Single shared producer**
  for both deterministic `_orchestrate` and `_orchestrate_agentic`. Idempotent via
  `drain_artifacts()/drain_pending_writes()`.
- Agentic plan prompt `:4646`; agentic stash `_PLAN_BY_TURN[turn_id]` `:4811`; agentic seal
  `:4842`.
- Deterministic `_plan_turn` `:3662` (returns intended_output/done_criterion/steps/…).
- Goalkeeper loop `post_room_turn:6160`; `_goalkeeper_should_continue:6120`.
- Helpers: `_md_table_to_rows:3892`, `_derive_title:3907`, `_surface_produce_error:3916`,
  `record_artifact`/`queue_email_approval`/`drain_artifacts` (imported `:54-58`).
- Connector actions: `GOOGLE_TOOLS` (`core/src/connectors/google-native.js:214`) →
  docs_create, docs_append, sheets_create, gmail_create_draft, gmail_search/get,
  drive_search. **No** sheets/doc *share* action ⇒ "share with X" is not a capability.

## Changes
### A. Ordered multi-step producer (registry + URL threading)
- `_PRODUCERS: dict[str, async fn(req, plan, step, ctx) -> dict]` + `@_register_producer(kind)`.
- Producers: `doc`, `sheet`, `email`, `answer` (no-op). Each does its connector write +
  `record_artifact`/`queue_email_approval`, returns `{url?, title?, skipped?, dead_end?}`.
- `_derive_artifact_steps(plan, user_msg)`: explicit `plan["artifact_steps"]` if present;
  else `[{kind: intended_output}]`; **deterministic enrichment** — if `intended_output==email`
  AND the message names a sheet/doc vehicle ("through/via/in a sheet|spreadsheet|table|
  tracker|doc|document|report") AND no such step exists, prepend `[{kind: sheet|doc}, {email}]`.
  This fixes "mail … through a sheet" WITHOUT trusting the planner.
- `_produce_output` iterates steps in order; `ctx` carries prior outputs
  (`ctx["last_artifact_url"]`, `ctx["artifacts"]`). The email producer injects the real prior
  URL into the body (and strips any fabricated placeholder URL).

### B. Honest dead-end seal
- If a step depends on a prior artifact that was NOT produced (prereq missing) → the producer
  **skips** it (no UNVERIFIED draft) and sets `plan["dead_end"] = {reason, searched}`.
- Empty-evidence grounding fail also routes to dead-end (memory_hits==0 + no connector data).
- Agentic seal: when `plan["dead_end"]`, emit a `line` (kind=`dead_end`) stating *what was
  searched* + *why it stopped*, seal `status="blocked"` (not `escalated`). No fabricated draft.
- `_goalkeeper_should_continue`: `verdict.get("dead_end")` ⇒ return False (terminal-honest,
  stop looping).

### C. Capability-aware planner
- Both plan prompts get a CAPABILITIES line (the registered producer kinds + the connector
  read tools) and an instruction: `done_criterion` may only assert end-states the toolset can
  reach; if the user asks for something unsupported (e.g. *share* a file), note it as a
  limitation in the deliverable — do NOT make it a done_criterion.
- Post-parse guard: drop any `artifact_steps` whose `kind` has no registered producer; record
  the dropped capability for the limitation note.

## Bounds / safety
- No flag — Phase 1 hardens the existing path (backward-compatible: absent `artifact_steps` ⇒
  single-step = today's behavior).
- Max steps capped (= `_EXECUTE_MAX_OWNERS`); idempotency guard kept; never fail a turn over
  production (existing try/except).
- Phase 2 (owner-owned writes + per-stage recon) stays out, flag-gated, eval-earned.

## Verify
- Unit: `_derive_artifact_steps` for "mail through a sheet" → `[sheet, email]`; plain email →
  `[email]`; doc → `[doc]`.
- Behavior: Rama task ⇒ sheet created → URL → email references real URL (or, on empty KB,
  honest dead-end seal, NO UNVERIFIED draft, goalkeeper stops). `python -c "import ast"` syntax
  gate; `review-changes` on the diff; in-container smoke before prod.
