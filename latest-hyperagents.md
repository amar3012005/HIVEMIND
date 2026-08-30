# Latest HyperAgents Architecture

**Snapshot:** 2026-08-30  
**Branch:** `codex/hyperrooms-copy-profile-and-artifact-feedback-20260829`  
**Purpose:** A code-oriented map of the current HyperRooms/HyperAgents system for implementation, debugging, and release work. This document describes the checked-out code, not a claim that every feature is deployed or enabled.

## 1. System Boundary

HyperAgents are multi-participant Rooms that turn a user message into a durable, streamed, tenant-scoped work run. The system has four execution surfaces:

```text
Cloudflare React frontend
  -> Control-plane HTTP API
  -> Employees Python sidecar / Director
  -> Control-plane event projection and PostgreSQL
  -> SSE back to the frontend
```

The control plane owns API admission, durable `HyperRoom`/`HyperTurn` state, event persistence, SSE, metering, artifact persistence, and terminal sealing. The Employees service owns planning, recall/tool orchestration, specialist collaboration, synthesis, verification, and visual candidate production. PostgreSQL is the durable source of truth. SSE is a live projection and is never the only source of a turn.

## 2. Repository Map

| Surface | Primary location | Responsibility |
|---|---|---|
| Frontend | `frontend/Da-vinci/src/components/hivemind/app/pages/HyperAgents.jsx` | Room list, submit/retry, SSE/poll merge, live and sealed transcript rendering. |
| Frontend shared rendering | `frontend/Da-vinci/src/components/hivemind/app/hyperagents/rooms/shared.jsx` | Event identity, report cards, timeline and shared transcript primitives. |
| Public HTTP control plane | `core/src/control-plane-server.js` | `/v1/hyper-rooms` lifecycle, admission, dispatch, metering and internal callback entry. |
| Stream and callback route helpers | `core/src/routes/hyper-rooms.js` | Turn SSE transport and `/internal/hyper/turn-event` artifact candidate projection. |
| Durable event operations | `core/src/employees/hyper-rooms.js` | Idempotent event append, sealing, outbox reconciliation, recovery. |
| Durable schemas | `core/prisma/schema.prisma` | HyperRoom, HyperTurn, work orders/results, claims/trials, event outbox. |
| Sidecar API | `employees-service/src/hivemind_employees/api_hyper_rooms.py` | Request contract, profile selection, orchestration, verification and approval gates. |
| Director | `employees-service/src/hivemind_employees/hyper/engine.py` | Gather plan, skills/tools, collaboration, synthesis, visual artifact production. |
| Execution profile data | `employees-service/src/hivemind_employees/hyper/execution_profiles.py` | Once-per-turn semantic routing data. |
| Domain packs | `employees-service/src/hivemind_employees/hyper/domains/` | Marketing, fundraising, design, research, SEO, outreach, campaign, product, branding, legal/finance methods. |
| Visual skill | `employees-service/src/hivemind_employees/hyper/visual_artifact_skill.md` | Governing quality requirements for generated HTML/specs. |

`frontend/Da-vinci` is a Git submodule. It must be pushed before a parent repository commit that references a new submodule SHA.

## 3. Durable Data Model

### Room

`HyperRoom` is the durable workspace. Important fields are:

```ts
{
  id, userId, orgId, projectId,
  name, goal, participantIds,
  template, roomTag, roomMode,          // work | runtime
  enabledConnectors, qualityMode,
  simMode, simAgents, evoMode,
  roomPlaybook, roomJournal
}
```

`roomMode` is an authority boundary. A human `work` Room is adaptive and Director-led. A `runtime` Room is invoked within an HQ/playbook lifecycle and must obey the supplied execution identity and stage boundary.

### Turn

`HyperTurn` is one idempotent user submission:

```ts
{
  id, roomId, seq, userMessage,
  status: 'live' | 'complete' | 'failed' | 'cost_capped',
  lines: HyperEvent[], costTokens,
  idempotencyKey, startedAt, sealedAt,
  executionIdentity, executionProfile,
  executionPhase, candidateOutput,
  verificationVerdict, lastProgressAt, terminalReason
}
```

`executionProfile` is selected once, persisted with a write-once guard, and must be read on resume before any new classification. `executionIdentity` is separate: it is the tenant/turn tamper envelope for Runtime work.

### Work, reasoning, and delivery records

- `HyperWorkOrder`: bounded task with dependencies, selected skills, acceptance criteria, artifacts/evidence, wait/handoff and lease state.
- `HyperWorkResult`: append-only worker attempt output. Synthesis consumes compact result records, not unbounded raw tool transcripts.
- `HyperClaim` and `HyperTrial`: durable reasoning graph records projected from hypotheses, reviews, votes, and synthesis events.
- `HyperTurnEventOutbox`: durable callback/outbox record keyed by `(turnId, eventId)`. It enables replay if the sidecar callback was lost.

## 4. Turn Lifecycle

```text
POST /v1/hyper-rooms/:roomId/turns
  1. Authenticate, tenant-scope, quota/meter admission and idempotency.
  2. Persist HyperTurn(status=live) and dispatch sidecar request.
  3. Sidecar resolves persisted execution profile for Work Rooms.
  4. Director emits typing/domain/output-mode/work-scope events.
  5. Director plans bounded gather/tool/collaboration work.
  6. Tools, workers and debate produce source-backed board entries and artifacts.
  7. Director synthesizes either text or an explicitly allowed visual artifact.
  8. Sidecar posts every event to /internal/hyper/turn-event.
  9. Core appends events transactionally, publishes SSE and seals terminal state.
 10. FE merges SSE with a durable polling fallback; on seal it refreshes the turn.
```

Relevant entry points:

- Create/fetch/stream/control callbacks: `core/src/control-plane-server.js` around the `/v1/hyper-rooms` routes and `/internal/hyper/turn-event`.
- SSE mechanics: `core/src/routes/hyper-rooms.js:handleHyperTurnStreamRoute`.
- Event persistence and seal: `core/src/employees/hyper-rooms.js:appendTurnEvent` and `sealTurn`.
- Sidecar request model: `employees-service/src/hivemind_employees/api_hyper_rooms.py:RoomTurnRequest`.
- Director loop: `employees-service/src/hivemind_employees/hyper/engine.py:Director.run`.

## 5. Input Contracts

### Sidecar `RoomTurnRequest`

Required:

```json
{
  "room_id": "uuid",
  "turn_id": "uuid",
  "user_id": "uuid",
  "org_id": "uuid",
  "user_message": "1..8000 characters"
}
```

Important optional fields:

```json
{
  "schema_version": "optional negotiated version",
  "display_message": "human-readable campaign message",
  "execution_context": "bounded upstream context",
  "participant_ids": ["uuid"],
  "project_id": "uuid|null",
  "room_goal": "string|null",
  "room_mode": "work|runtime|null",
  "task_tag": "string|null",
  "campaign_id": "uuid|null",
  "campaign_brief": {},
  "sim_mode": "on|off|null",
  "sim_agents": 10,
  "evo_mode": "on|off|null",
  "write_policy": "ask|auto|null",
  "agentic_model": "model override for eval only|null",
  "language": "BCP-47-like language code|null",
  "execution_identity": {}
}
```

Unknown input fields are deliberately ignored for forward compatibility.

### Profile selection output: `execution-profile.v1`

The selector returns only `profile_id` and `reason`; the server expands it to:

```json
{
  "contract": "execution-profile.v1",
  "profile_id": "marketing.copy.v1",
  "room_kind": "marketing",
  "allowed_outputs": ["direct_answer"],
  "effect": "internal",
  "required_artifacts": [],
  "review_policy": "none|reviewer|debate",
  "reason": "bounded classifier explanation",
  "selected_at": 0
}
```

Profile registry data is in `execution_profiles.py`. Current profile families include general answer, research decision, campaign contract, outreach preparation, marketing copy, marketing visual artifact, SEO, branding, fundraising, product, design, and legal/finance.

**Current visual contract:** an execution profile that does not list `artifact` in `allowed_outputs` cannot enter visual generation, even if a model emits `artifact_intent`. This prevents a normal positioning/copy request from spending artifact-design tokens.

### Director gather-plan output

`Director._plan_gather()` uses structured JSON. The plan contains:

```json
{
  "turn_mode": "chat|task",
  "execution_engine": "debate|agentic",
  "collaboration_intensity": "light|standard|deep",
  "response_depth": "direct|focused|operating",
  "evidence_mode": "standard|prospecting",
  "recall_queries": ["bounded company-memory query"],
  "history_turns_back": 0,
  "connector_calls": [],
  "web_query": "string|null",
  "seo_audit_url": "string|null",
  "seo_audit_scope": "none|...",
  "seo_task": "none|...",
  "places_query": "string|null",
  "needs_debate": false,
  "method_skills": ["progressively loaded skill id"],
  "campaign_method_assignments": [],
  "work_orders": [],
  "turn_plan": [],
  "post_output_actions": [],
  "outreach_request": null,
  "campaign_request": null,
  "artifact_intent": null
}
```

The plan decides a bounded execution approach, not permission to perform an external write. Provider writes remain behind a later authority/approval path.

## 6. Event Contract

Every `HyperTurn.lines` item is JSON. A stable `event_id` is preferred; Core deduplicates events with a supplied ID. Every event receives durable `ts` and `received_ts` during append.

### Common event envelope

```json
{
  "t": "event type",
  "event_id": "optional stable producer id",
  "ts": 0,
  "received_ts": 0
}
```

### High-value events

| Event | Essential fields | Meaning |
|---|---|---|
| `typing` | `agent`, `note` | Immediate feedback before first tool/model result. |
| `domain_pack` | `room_kind`, `display_name`, `skills_available` | Chosen specialist pack. |
| `output_mode_selected` | `mode: text|visual`, `artifact_kind`, `profile_id`, `reason` | The governed output decision. |
| `work_scope` | `room_kind`, `intensity`, `depth`, `debate` | Planned collaboration envelope. |
| `gather` | tool/evidence fields | Recall, web, connector or evidence collection result. |
| `work_brief`, `work_order` | task contract fields | Durable bounded work. |
| `round_start`, `react`, `peer_review`, `vote`, `swarm_verdict` | participant/reasoning fields | Multi-agent collaboration trace. |
| `line` | `agent`, `kind`, `content` | Narrative output; synthesis is `kind: synthesis`. |
| `verify` | `met`, `artifact_ok`, `assignments_ok`, `grounded_ok`, `gaps` | Final acceptance verdict. |
| `approval_request` / `approval_resolved` | approval identity and decision | User-gated external write lifecycle. |
| `connector_logo` | connector, `url`, title/label | Persisted connector document/sheet deliverable. |
| `artifact_ready` | `artifact_id`, `url`, `preview_url`, title | Persisted and validated visual artifact. |
| `artifact_progress` | `stage`, `status`, `title`, `detail`, optional `errors` | Visible visual pipeline progress. Stages: `direction`, `composition`, `render`, `repair`, `complete`. |
| `artifact_rejected` | `status: rejected`, `stage`, `attempts`, `errors`, `title`, `detail` | Rendered artifact failed the governed check; text fallback remains available. |
| `warning`, `error` | code/note or message | Degraded but explainable state. |
| `seal` | `status`, `cost_tokens` | Terminal event. Core seals atomically. |

### Visual candidate boundary

The sidecar sends an internal-only event:

```json
{
  "t": "artifact_candidate",
  "candidate": {
    "contract": "artifact-candidate.v1",
    "intent": {"contract": "artifact-intent.v1", "kind": "presentation|interactive_document|dashboard", "medium": "html"},
    "title": "string",
    "summary": "string",
    "html": "self-contained HTML",
    "source_refs": ["compact evidence labels"]
  }
}
```

`core/src/routes/hyper-rooms.js` validates/persists this candidate through `persistHyperArtifactCandidate`. It responds to the sidecar with either a verified artifact receipt or bounded validation errors. It never persists invalid candidate HTML as a ready artifact.

## 7. Output Contracts

### Sidecar terminal response

```json
{
  "ok": true,
  "status": "complete|blocked|failed|...",
  "cost_tokens": 0,
  "summary": "optional bounded text",
  "usage": {"...": 0},
  "verification": {
    "met": true,
    "artifact_ok": true,
    "assignments_ok": true,
    "grounded_ok": true,
    "gaps": []
  },
  "pending_approvals": [],
  "artifacts": [],
  "result": {},
  "rounds_used": 0
}
```

An operational profile is not complete merely because text exists. Its declared required artifacts and verification predicate must pass. A direct/text profile may honestly complete with a grounded answer and no durable external artifact.

### Text output

Text synthesis emits a `line` event with `kind: synthesis`; Core can recover it into a `final_report` on seal if needed. The frontend renders the sealed report as the authoritative final output.

### HTML visual output

There are two model-facing contracts:

1. `visual-art-direction.v1` is a typed direction with thesis, layout, art direction, palette, narrative flow, explanatory visuals, interaction and avoidance list.
2. Presentation requests use `visual-presentation.v1` from the typed presentation renderer. The model owns narrative/composition; the governed renderer owns HTML/CSS/navigation/responsiveness.
3. Other visual kinds use the strict HTML candidate schema: `title`, `summary`, `html`, `source_refs`.

The visual path is feature-flagged by `Visual_path_In_Hyperrooms` or `VISUAL_PATH_IN_HYPERROOMS`. It must be selected by output contract and explicit user outcome, never merely because the Room has a marketing/fundraising/design label.

## 8. Frontend Behavior

`HyperAgents.jsx` opens EventSource for an active turn and merges the stream with a 250ms durable polling fallback. This protects against buffered SSE, extensions, or network partitions. `hyperEventKey` prioritizes backend `event_id`, then legacy IDs, to avoid duplicate/colliding live events.

Visual UI behavior:

- `artifact_progress` produces a compact live status surface, preventing the historical blank gap while composition and renderer checks run.
- `artifact_ready` renders a preview/open card.
- `artifact_rejected` presents up to three exact validation errors and retains the textual fallback.
- Invalid candidates are never shown as complete visual artifacts.

## 9. Models, Skills, and Tool Policy

- Profile selection is a small, low-temperature structured call and has a safe fallback to `general.answer.v1`.
- The Director uses structured planning, progressive method-skill loading, source memory, optional web/connector reads, bounded work orders, light/standard/deep collaboration, synthesis, and verification.
- `agentic` is deliberately a separately gated execution path. Normal work defaults to the predictable plan/gather/debate/synthesis path.
- Connector provider writes must use approval governance. A request to write/draft is not proof of execution; provider receipts are required for completion claims.
- Preserve source/evidence lanes: a team claim, skill text, or model inference must never be promoted to a verified factual claim without an approved source.

## 10. Reliability Rules

1. Do not use SSE as durability; always inspect `HyperTurn.lines` and terminal fields.
2. Every producer should provide a stable `event_id` where replay is possible.
3. Do not reseat an execution profile on retry; use `_resolve_work_room_execution_profile`.
4. Do not bypass artifact validation or show an `artifact_candidate` directly to users.
5. Do not claim external action without a provider receipt and authority record.
6. Never deploy with bare Compose commands, `compose down`, or broad dependency restarts. Build from `/root/hivemind-main`; run named-service deployment checks from `/root/hivemind`.
7. Keep frontend and sidecar compatibility in the same release: event producers, SSE subscriptions, and transcript cards must agree.

## 11. Current Change: Copy-vs-Visual Routing

This branch adds `marketing.copy.v1` and narrows `marketing.artifact.v1` to explicit designed visual requests. It also makes the Director enforce `allowed_outputs` before accepting planner-provided `artifact_intent`.

Result:

```text
"Refine the positioning statement for Europe"
  -> marketing.copy.v1
  -> text mode
  -> no art-direction/spec/render/repair token path

"Create a slide-by-slide investor deck"
  -> explicit artifact-capable profile
  -> visual mode
  -> progress events -> candidate validation -> ready/rejected state
```

## 12. Known Gaps and Next Work

### Required before releasing this branch

1. Push the frontend submodule branch first, then this parent branch. Ensure the parent SHA references an accessible frontend commit.
2. Run the Employees pytest suite in a dependency-complete test image/CI job. The host Python environment lacks sidecar dependencies; do not mistake host collection failure for application-test failure.
3. Build the sidecar image and Cloudflare frontend artifact from these exact SHAs, then run a real text-copy Room turn and an explicit presentation Room turn.
4. Verify that the text-copy turn emits `output_mode_selected.mode = text` and never emits `artifact_progress` or `artifact_candidate`.
5. Verify that a deliberately invalid visual candidate emits `artifact_rejected.errors` in both persisted turn lines and the browser UI.

### Existing connector bridge work is separate and not release-ready

The connector bridge experiment lives on `codex/hyperrooms-chat-tools-bridge-20260828`, not this branch. Prior audit identified provider-inventory mismatch, poison-seal/replay risks, post-commit side-effect recovery gaps, and non-transactional company state updates. Do not merge or deploy it with this visual/copy patch.

## 13. Verification Commands

```bash
# Parent worktree
cd /root/builds/hyperrooms-copy-profile-and-artifact-feedback-20260829
python3 -m py_compile \
  employees-service/src/hivemind_employees/hyper/execution_profiles.py \
  employees-service/src/hivemind_employees/hyper/engine.py
git diff --check origin/singulance-main...HEAD

# Employees tests in an environment with the service dependencies
cd employees-service
PYTHONPATH=src pytest -q \
  tests/test_execution_profiles.py \
  tests/test_adaptive_director.py \
  tests/test_visual_artifact_path.py

# Frontend
cd ../frontend/Da-vinci
CI=true npm run build
```

## 14. Release Decision

**Do not deploy from this branch automatically.** Another deployment session was active when this work began. The next agent must first verify the active release SHA, confirm it does not supersede unrelated work, and release only the named services with a named-service, `--no-deps` dry run.
