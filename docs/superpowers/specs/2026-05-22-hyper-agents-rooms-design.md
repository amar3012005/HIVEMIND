# Hyper Agents — Rooms, Debate Dynamics, and Self-Evolution

**Status:** Approved design — ready for implementation plan
**Date:** 2026-05-22
**Author:** session via brainstorming skill
**Supersedes / extends:** Hyper Agent v0 work in `core/src/employees/hyper-state.js`, `employees-service/src/hivemind_employees/`, and `frontend/Da-vinci/src/components/hivemind/app/pages/DigitalEmployees.jsx`

---

## 0. Why

The current `DigitalEmployees` page surfaces agents as static cards with state badges (Baseline / Collecting / Ready / Optimized). It does not let agents *talk to each other*, and the eval / self-evolution loop has no source of training data because no multi-agent runs happen on the platform.

This spec turns the page into a WhatsApp-style multi-agent workspace where agents speak in named rooms, react to each other under CSI-style debate rules, and self-evolve via background eval + prompt tuning — closing the loop that hyper-state.js was designed for but never received signal.

CSI flow pattern is adapted from `MiroFish/backend/app/services/csi_research_engine.py` — propose / opposing review / revise rounds with quality gates.

## 1. Locked design choices (from brainstorm)

| ID | Choice | Why |
|---|---|---|
| Q1 | **Persistent shared workspace** | One room, all assigned agents always present |
| Q2 | **Lead + reactors** | Router picks lead, others get cheap react-or-quiet check |
| Q3 | **Per-user persisted, sealed turns** | Reload reads DB only; never re-runs LLM |
| Q4 | **Auto-derive `csi_role`, manual override** | Zero setup, full control |
| Q5 | **Hybrid promotion** | Auto on score-delta > 0.10, human gate 0.02–0.10, discard < 0.02 |
| Q6 | **Multiple named rooms per user** | WhatsApp layout, ad-hoc room names |
| Q7 | **WhatsApp-only after first room** | Cards live inside `+ Add agent` picker once room exists |
| Q8 | **SSE during live turn, DB read after seal** | Real-time feel + zero-cost replay |
| Q9 | **One summary memory on archive only; 12k turn cap; 2 reactors max; up to 2 CSI rounds** | Avoid memory noise, predictable cost |

## 2. Overall flow

```
User opens /hivemind/app/employees
  First visit  → roster preview + "Create your first room" CTA
  Has rooms    → pure WhatsApp layout, no return to grid

User sends a message in a room
  ↓
ROUND 1
  Router (LLM, ~200 tok) picks lead by csi_role match → picks 0–2 reactors
  Lead generates full response, may call hivemind_recall + hivemind_web_research
  Each reactor runs a "react-or-quiet" check (300 tok) → if react, emit 1–2 sentence line
  CSI quality gate
    if adversarial pair present AND no challenge surfaced → force one Skeptic reaction
  ↓
ROUND 2 (only if any reactor returned agreement='challenge' with confidence > 0.7)
  Lead reads challenger line → revises (cheaper budget, ~half)
  Challenger validates or escalates one more time
  ↓
Seal turn — write JSONL events into hyper_turns.lines, status='complete'
SSE closes. Reload reads from DB. No new LLM calls.
  ↓
Background (async, not blocking next user turn)
  CSI scorer rates 4 axes per agent line
  Saves agent_evals row
  When agent has ≥20 unused evals → state flips to 'Ready for tuning'
```

**Archive room** is the only memory write:
- Server distills full transcript into one memory (`memory_type: 'summary'`, tags `['hyper-room', room:<id>]`)
- Goes through canonical IngestTree pipeline so existing relationship enrichment fires
- Raw JSONL stays in `hyper_turns` for graph reconstruction

## 3. Data model

Two new tables, one extension. File-based prompt variants stay as-is.

```sql
hyper_rooms
  id                uuid PK
  user_id           uuid NOT NULL
  org_id            uuid NOT NULL
  name              text NOT NULL
  participant_ids   uuid[]       -- employees.id
  created_at        timestamptz DEFAULT now()
  archived_at       timestamptz
  summary_memory_id uuid         -- set on archive

hyper_turns
  id              uuid PK
  room_id         uuid REFERENCES hyper_rooms ON DELETE CASCADE
  seq             int NOT NULL                 -- monotonic per room
  user_message    text NOT NULL
  status          text NOT NULL                -- 'live' | 'complete' | 'failed' | 'cost_capped'
  lines           jsonb DEFAULT '[]'           -- JSONL of agent_line events
  cost_tokens     int DEFAULT 0
  started_at      timestamptz DEFAULT now()
  sealed_at       timestamptz
  idempotency_key text NOT NULL UNIQUE         -- hash(room_id+seq+user_message)

agent_evals
  id                  uuid PK
  agent_id            uuid REFERENCES employees ON DELETE CASCADE
  turn_id             uuid REFERENCES hyper_turns ON DELETE CASCADE
  scores              jsonb NOT NULL           -- {helpful, role_fit, evidence, opposition}
  total               float NOT NULL
  created_at          timestamptz DEFAULT now()
  used_for_tuning_at  timestamptz

employees
  ADD COLUMN csi_role text                     -- nullable, auto-derived
```

### `hyper_turns.lines` JSONL schema

```json
{"t":"router","ts":1700000000,"lead":"maya","reactors":["jonah","eli"]}
{"t":"line","ts":1700000001,"agent":"maya","round":1,"kind":"lead","content":"…","tokens":1240,"tools":["hivemind_recall"]}
{"t":"react","ts":1700000002,"agent":"jonah","round":1,"agreement":"extend","content":"…","tokens":210}
{"t":"react","ts":1700000003,"agent":"eli","round":1,"agreement":"challenge","confidence":0.82,"content":"…","tokens":240}
{"t":"revise","ts":1700000004,"agent":"maya","round":2,"content":"…","tokens":680}
{"t":"validate","ts":1700000005,"agent":"eli","round":2,"content":"…","tokens":180}
{"t":"seal","ts":1700000006,"cost_tokens":2550}
```

`agreement ∈ {agree, extend, challenge, abstain}`. `abstain` logs only — no UI bubble.

## 4. Page layout

### First visit (no rooms)

```
Hyper Agents                                          [+ Hire]
──────────────────────────────────────────────────────────────
                [icon: people in conversation]
       Build a room — your agents will work together

Pick from your roster:
[Maya · Strategist · v0]  [Jonah · Builder · v1]
[Lina · Comms · v0]       [Eli · Skeptic · v1 *]

                       [ + New room ]
```

Roster cards: avatar, name, role chip, prompt version + state badge (`*` marker = shadow tuning live). Click → drawer with persona, csi_role override, eval count, tuning history, "Talk 1-on-1" button (calls existing `/v1/employees/:slug/chat`).

### After first room (pure WhatsApp layout)

Left rail: room list with status dot (green = live turn, grey = sealed, dim = archived).
Middle: thread.
Right: participant chips with role + version badge; `+ Add agent` opens picker; pending-promotion banner when applicable.

Bubble anatomy:
- **Lead** — full bubble, avatar, role chip, tool-call chips, content
- **Reaction** — indented under lead, smaller bubble, colored chip by `agreement` (green extend / amber challenge / blue agree)
- **Revise / validate** — round 2, dashed left border so debate is visible
- **Seal marker** — `─── sealed · {tok} tok ───` at end of turn

Live affordances: typing indicator (driven by SSE `router` event), `@mention` auto-suggest (mentioned agent forced to lead), pending-promotion banner with Approve/Discard, room ⋮ menu (Rename / Archive / Export / Re-tune), ⌘K search.

## 5. Backend endpoints

### Control-plane REST

| Method | Path | Purpose |
|---|---|---|
| GET    | `/v1/hyper-rooms`                       | List rooms for current user |
| POST   | `/v1/hyper-rooms`                       | Create room `{name, participant_ids[]}` |
| GET    | `/v1/hyper-rooms/:id`                   | Room + last 50 turns |
| PATCH  | `/v1/hyper-rooms/:id`                   | Rename, add/remove participant |
| DELETE | `/v1/hyper-rooms/:id`                   | Soft-archive → distills summary memory |
| POST   | `/v1/hyper-rooms/:id/turns`             | New turn `{user_message, idempotency_key}` → `{turn_id}` |
| GET    | `/v1/hyper-rooms/:id/turns/:turnId`     | Sealed turn (DB read) |
| GET    | `/v1/hyper-rooms/:id/turns/:turnId/stream` | SSE for live turn |
| POST   | `/v1/hyper-rooms/:id/promote-prompt`    | `{agent_id, candidate_version_id}` — human-gate promotion |
| GET    | `/v1/employees/:slug/evals`             | Paginated eval rows |
| GET    | `/v1/employees/:slug/prompt-versions`   | Versions + diff snapshots |

All `/v1/hyper-rooms/*` routes are session-cookie auth; `user_id` and `org_id` are injected server-side. Idempotency key on `POST /turns` makes double-clicks safe.

### Sidecar (Python) internal endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/internal/hyper/room-turn`  | Orchestrate lead + reactors + optional round 2; stream JSONL events back to control-plane via callback URL |
| POST | `/internal/hyper/score-turn` | CSI 4-axis judge, writes `agent_evals` |
| POST | `/internal/hyper/tune-agent` | Reads recent evals, writes new prompt variant + score delta; returns `{candidate_version_id, score_delta, promotion_mode}` where `promotion_mode ∈ {auto, gated, discarded}` |

Sidecar auth: master-key, same as existing `/v1/team-tasks`.

### SSE event types

`router`, `typing`, `line`, `react`, `revise`, `validate`, `heartbeat`, `seal`, `error`. Reconnect uses `Last-Event-ID` carrying the JSONL line offset.

### Cost enforcement

- Lead: `max_tokens=8192`, truncation flagged in event
- Each reactor: `max_tokens=1500`
- Round 2 lead: `max_tokens=4096`
- `hyper_turns.cost_tokens` aggregated; > 12k seals with `status='cost_capped'`

## 6. Self-evolution loop

### CSI scorer (fires async after seal)

LLM judge (cheap model, batched across all lines in one call):

| Axis | Question | Weight |
|---|---|---|
| `helpful`    | Did this line move the user's question forward?                    | 0.30 |
| `role_fit`   | Does this line fit the agent's `csi_role`?                          | 0.25 |
| `evidence`   | Were claims backed by tool calls / observable facts?                | 0.20 |
| `opposition` | If reactor in adversarial pair: did it push back when warranted?    | 0.25 |

Each in `[0,1]`. `total = weighted sum`. Stored as `agent_evals` row.

### State machine per agent

```
Baseline (0 evals)
  → Collecting feedback (1..19 unused evals)
  → Ready for tuning (≥20 unused evals)
  → Shadow (candidate runs alongside baseline for next 10 turns of this agent)
       ├── score_delta > 0.10 → auto-promote → Optimized
       ├── 0.02 ≤ delta ≤ 0.10 → pending → human Approve / Discard
       └── delta < 0.02 → discard variant → back to Collecting
```

`Optimized` re-enters `Collecting` against the new version. Loop continues. Per-agent version cap = 10 for v1 (admin reset required beyond).

### Tuner inputs / outputs

**Inputs**: current `active_prompt_version` markdown · last 20 eval rows with judge reasoning · worst 5 lines by total.
**Outputs**: new markdown → `archive/prompt_variants/<slug>/v{n}.md`, change-log line, score-delta record → `archive/evaluations/<slug>/tune-{n}.json`.

Persona section of prompt is **read-only** to tuner; only strategy/style sections are rewritten.

### Eval consumption

`used_for_tuning_at` set on each row when consumed by a tuner run. Each new tune cycle waits for 20 *fresh* evals — natural rate limit.

### Promotion UI

Card badges:
- `Baseline` (grey)
- `Collecting (12/20)` (amber + progress bar)
- `Ready` (blue)
- `Shadow (7/10)` (violet + progress bar)
- `Optimized v2` (green + version chip)
- `Pending v3 (+0.07)` (orange + Approve/Discard in right rail)

Tooltip shows last 3 axis scores so the user can see *why* it's evolving.

### Safety rails

- Max version per agent for v1 = 10 (refuse beyond without admin reset)
- Persona section of prompt is read-only to tuner
- 3 consecutive discards → agent flagged `tuning-stuck`, surfaced to admin
- Rollback: previous version reachable in card menu for 30 days post-promotion

## 7. Performance budget (per user turn)

| Stage | Cost | Latency target |
|---|---|---|
| Router pick                  | 200 tok            | < 600 ms          |
| Lead generation              | 1.2 – 8 k tok      | 2 – 6 s           |
| Reactor quiet-check (each)   | 300 tok            | < 800 ms parallel |
| Reactor line (if firing)     | 0.8 – 1.5 k tok    | < 2.5 s parallel  |
| Round 2 (conditional)        | up to 4 k tok      | 2 – 4 s           |
| Background scorer            | not on critical path | async            |
| **User-perceived total**     | **3 – 12 k tok**   | **3 – 9 s** to seal |

## 8. Failure modes

| Failure | Behavior |
|---|---|
| Sidecar timeout on lead       | Line marked `kind:'error'`, turn seals `status='failed'`. Retry via room ⋮ menu. |
| Reactor LLM fails             | Quietly skipped, no line. Turn proceeds. |
| Cost cap hit mid-stream       | Seal with `status='cost_capped'`. Mid-flight reactors discarded. |
| User double-clicks send       | Idempotency key returns existing `turn_id`. No second call. |
| Browser disconnects in SSE    | Reconnect via `Last-Event-ID`; missed events replayed. Sealed turns DB-read. |
| Tuner generates broken prompt | Shadow run catches it (delta < 0.02 → auto-discard). Version cap = 10. |
| Two agents same csi_role      | Allowed. Router picks one as lead, opposition gate falls back to nearest non-aligned role. |

## 9. Sequenced rollout

Each step ships independently; can pause between any two without leaving a broken state.

| Step | What ships | User-visible? |
|---|---|---|
| 1 | DB migration: `hyper_rooms`, `hyper_turns`, `agent_evals`, `employees.csi_role` | No |
| 2 | Auto-derive `csi_role` for existing employees on first boot | Role chip on cards |
| 3 | REST endpoints `/v1/hyper-rooms` + `/turns` (no SSE) | No |
| 4 | Sidecar `/internal/hyper/room-turn` — lead + reactors, no round 2 | No |
| 5 | Frontend WhatsApp layout, polling fallback, 1 round | First usable version |
| 6 | SSE stream + EventSource | Real-time feel |
| 7 | CSI scorer + `agent_evals` writes | No user change; evals fill |
| 8 | Round 2 / debate revision | Debates surface in thread |
| 9 | Tuner + shadow runner | Cards show Shadow / Pending |
| 10 | Promotion UI (auto + gated) | Approve buttons appear |

## 10. Out of scope (v1)

- Per-org / shared rooms — deferred (table already carries `org_id`)
- Agent → agent DM outside a room — use a 2-agent room instead
- Voice mode in rooms
- Mobile-only layout
- Slack / Linear tool plumbing in rooms (already in solo 1-on-1)

## 11. Open risks (acknowledged)

1. **Judge cost** — scoring every line × 4 axes is non-trivial. Mitigate: cheap model, batch all lines per turn in one call, skip for archived rooms.
2. **Auto-promo blowback** — bad v2 only noticed days later. Mitigate: previous version reachable from card menu for 30 days; one-click rollback.
3. **Tuner prompt injection** — agent lines fed back to tuner are user-influenced. Mitigate: tuner sees lines + scores only, never raw user messages; persona locked.
4. **Room sprawl** — 30 rooms, no archive. Mitigate: rooms inactive 30 d auto-collapse under "Inactive" (not deleted).
5. **Single-user-only v1** — no team rooms. Mitigate: schema already org-scoped; add invite mechanism later.

---

**Next step:** invoke `writing-plans` skill to convert this spec into an implementation plan.
