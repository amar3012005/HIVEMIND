# Digital Employees & Hyper Agents — Functionality & Architecture

> Current-version reference for the HIVEMIND multi-agent stack: **Digital Employees**,
> **Hyper Agents (Cognitive Swarm Intelligence rooms)**, **Employee Playground (team
> tasks)**, **Agent Swarm (resident graph-hygiene agents)**, and **Swarm Governance**.
> Live: https://hivemind.davinciai.eu/hivemind/app/employees

---

## 1. What these features are

HIVEMIND ships a **Cognitive Swarm Intelligence (CSI)** layer: role-specialized AI
agents ("Digital Employees") that can work **alone** (1-on-1 chat), as a **debate room**
(Hyper Agents), as a **task team** (Playground), or as **resident maintenance agents**
that keep the knowledge graph clean (Agent Swarm). Every agent is backed by the
HIVEMIND memory cortex (recall/save) and can act through connectors (Slack, WhatsApp,
web search).

| Surface | Page | What the user does |
|---|---|---|
| **Digital Employees** | `DigitalEmployees.jsx` (`/employees/roster`) | Create/manage agents, view tuning ("Hyper") state, 1-on-1 DM preview |
| **Hyper Agents** | `HyperAgents.jsx` (`/employees`) | Slack/WhatsApp-style multi-agent **rooms**; live streamed debates |
| **Playground** | `EmployeePlayground.jsx` | Multi-employee **team tasks** + DM panels |
| **Agent Swarm** | `AgentSwarm.jsx` (`/swarm`) | Faraday→Feynman→Turing graph-hygiene chain |
| **Governance** | `SwarmGovernance.jsx` (`/governance`) | Approve/reject/rollback memory mutations |

---

## 2. High-level architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Frontend (React, Da-vinci)                                          │
│  DigitalEmployees · HyperAgents · EmployeePlayground · AgentSwarm   │
│  · SwarmGovernance   →  api-client.js                                │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTPS (session cookie / API key)
                ▼
┌────────────────────────────────────────────────────────────────────┐
│ Control-plane / core (Node, Express + Prisma)                        │
│  /v1/employees, /v1/hyper-rooms, /v1/team-tasks, /v1/proxy/...        │
│  core/src/employees/hyper-rooms.js (CSI lanes, idempotency, seal)    │
│  core/src/employees/hyper-state.js (tuning / active_prompt_version)  │
│  SSE relay to UI · Prisma → Postgres                                 │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │ internal HTTP (X-Admin-Token)  │ recall/save (scoped key
                ▼                                 │  or master+emulation)
┌──────────────────────────────────────────┐    ▼
│ employees-service (Python, FastAPI :8060) │  HIVEMIND memory engine
│  api_team_tasks.py · api_hyper_rooms.py    │  (Qdrant + Postgres graph)
│  api_employee_chat.py                      │
│  agents/agentscope_factory.py (ReActAgent) │
│  orchestration/team_room.py (phase machine)│
│  slack/gateway.py (Bolt)  · Redis (dedup)  │
└────────────────────────────────────────────┘
                │ LLM calls
                ▼
   Anthropic · OpenAI · Groq · OpenRouter (per-employee provider/model)
```

**Two backends, one DB.** The Node control-plane owns CRUD, sessions, Prisma writes,
and the SSE relay to the browser. The Python **employees-service** is the agent
execution engine (AgentScope ReAct agents, the CSI phase machine, Slack Bolt). Both
read/write the same Postgres via the Prisma schema (`core/prisma/schema.prisma`).
Control-plane calls the Python service over internal HTTP with a master `X-Admin-Token`.

---

## 3. Digital Employees

### Functionality
- **Create** an employee: name, `slug`, `persona` (system prompt), `role_archetype`
  (`operator | skeptic | researcher | builder` in the form; CSI lanes
  `Strategist | Builder | Skeptic | Researcher | Communicator` at runtime), `model`,
  `llmProvider`, and an enabled `tools[]` list.
- **Lifecycle**: `draft → deploying → running → paused → error`. Pause/Resume/Archive
  (soft delete via `archivedAt`).
- **Hyper (tuning) state**: `baseline → collecting_feedback → ready_for_tuning →
  optimized`, with `evaluation_count / tuning_threshold` and `progress_pct`. The active
  system prompt is versioned (`active_prompt_version.version_label`) and driven by
  `core/src/employees/hyper-state.js`.
- **1-on-1 chat preview**: floating DM window; server runs a ReAct agent with the
  employee's tools and a persistent `conversation_id`.
- **Metrics**: messages/24h, tokens/24h shown per card.
- **Key management**: each employee mints a scoped HIVEMIND API key; remint single/all,
  pause-all per org.

### Data model — `DigitalEmployee` (Prisma)
```
id, orgId, teamId?, name, slug, persona, model, llmProvider,
hivemindApiKeyId?, scopedApiKeyEncrypted?,
slackTeamId?, slackChannelsAllowed[], slackDisplayName?, slackAvatarEmoji?,
roleArchetype?, peerReviewTargets[],     # multi-agent collaboration metadata
tools[], policyRules(JSON),
status, replicas, maxReplicas, createdAt, archivedAt?
```

### Key API (control-plane, `/v1/employees`)
```
GET    /v1/employees                         list
POST   /v1/employees                         create
GET    /v1/employees/:id                      detail
PATCH  /v1/employees/:id                      update
POST   /v1/employees/:id/pause | /resume      lifecycle
DELETE /v1/employees/:id                       archive (soft)
POST   /v1/employees/optimize-persona          AI persona rewrite
POST   /v1/employees/:slug/chat               1-on-1 chat {text, conversation_id} → {reply}
POST   /v1/employees/:id/remint-key
POST   /v1/orgs/:orgId/employees/remint-all-keys | /pause-all
```

---

## 4. Hyper Agents — Cognitive Swarm Intelligence rooms

### Functionality
- **Rooms** are persistent, Slack/WhatsApp-style spaces with a set of participant
  employees. Layout: left rail (rooms + archived dropdown + create), middle thread
  (turns), right rail (participants with lane colors + add/remove).
- **Lanes** color/role agents: Strategist (purple), Builder (blue), Skeptic (amber),
  Researcher (green), Communicator (pink).
- **Turns**: user posts a message → backend runs a multi-agent turn → events **stream
  live over SSE** into the thread. Idempotency key = `roomId:timestamp:msgLen`.
- **Templates** (`debate | decision(DACI) | brainstorm | council | lean_coffee |
  retrospective | review | standup | swarm`) change the orchestration overlay.
- **Permanent Skeptic**: optional locked skeptic that never rotates.
- **Archive** a room → distills the whole transcript into one HIVEMIND memory.
  **Clear** wipes turns but keeps the room. **DM** an agent 1-on-1 inside the room.
- **Decision sink**: when a turn resolves (or the user says "save this to memory"), the
  verdict is auto-saved to HIVEMIND (`tags: room-decision, room:{id}, turn:{id}`).

### Turn execution — the R1–R5 phase machine (`template == 'swarm'`)
Implemented in `employees-service/.../api_hyper_rooms.py`:
1. **R1 Independent Hypothesis** — each non-lead, non-skeptic agent forms a claim after
   3–5 silent memory recalls (lane playbook). → `{hypothesis, confidence, evidence_memory_ids, lane}`
2. **R2 Peer Cross-Exam** — agents review 2 other hypotheses with corroborating/
   contradicting evidence. → `[{target, agreement, evidence, reason}]`
3. **R3 Deep Chain-of-Thought** — each agent refines after reviews (recall, traverse,
   optional web). → `{refined_hypothesis, chain_of_thought[], confidence}`
4. **R4 Skeptic Challenge** — the (permanent or rotating) Skeptic, silent until now,
   attacks contradictions + hidden assumptions. → `{challenges[], unorthodox_alternatives[], hidden_assumptions[]}`
5. **R5 Convergence Vote + Synthesis** — all vote (weighted by **AgentTrust**); the Lead
   synthesizes. Verdict: `AGREED (≥3.5, no dissent) | CONDITIONAL (≥3.0) | DISSENT`.

**Simpler debate flow** (non-swarm templates): Router picks a Lead (relevance + lane
weighted) → Lead answers → up to 2 Reactors do a quiet `{react, agreement, confidence}`
pass → if a reactor `challenge`s with confidence > 0.45, Lead revises → seal with verdict
+ token roll-up. Guardrails: **cost cap** (~10M tokens/turn), **wall-clock deadline**
(~150s).

### Data models
```
HyperRoom:  id, userId, orgId, name, participantIds[], template,
            permanentSkepticId?, createdAt, updatedAt, archivedAt?
HyperTurn:  id, roomId, seq, userMessage, status(live|complete|failed|cost_capped),
            lines(JSON[] event log), costTokens, idempotencyKey, sealedAt?
AgentTrust: orgId, employeeId, trustScore[0..1] (start 0.5), wins, losses, updatedAt
```
`lines[]` event types: `router, line/lead, react/reactor, revise, validate, seal,
hypothesis, peer_review, chain_of_thought, skeptic_challenge, vote, swarm_verdict,
cost_cap_hit, deadline_hit, decision_required, decision_saved, round_start/round_end,
typing, heartbeat, warning, error`.

### API + real-time
```
GET    /v1/hyper-rooms                          list
POST   /v1/hyper-rooms                          create {name, participant_ids[]}
GET    /v1/hyper-rooms/:id                       room + turns
PATCH  /v1/hyper-rooms/:id                       update {participant_ids}
DELETE /v1/hyper-rooms/:id  [?hard=true]         archive | cascade delete
DELETE /v1/hyper-rooms/:id/turns                 clear discussion
POST   /v1/hyper-rooms/:id/turns                 post turn {user_message, idempotency_key}
GET    /v1/hyper-rooms/:id/turns/:turnId/stream  SSE live events
```
Internally the control-plane calls the Python engine at
`POST /internal/hyper/rooms/:id/turns` with a `callback_url`; the engine POSTs each event
back, and the control-plane relays them to the browser via SSE.

---

## 5. Employee Playground — team tasks

### Functionality
- **Group session**: pick 2+ employees, write a `brief`, set `max_rounds` (1–6). The team
  runs a phase machine and the transcript streams in (polled every 1.5s).
- **DM mode**: 1-on-1 with one employee, persistent `conversation_id`.
- Transcript message kinds: `system | chat | claim | review | revision | synthesis`;
  a `metadata.verdict: 'contradicts'` renders with a red ring.

### Phase machine (`orchestration/team_room.py`)
`INVESTIGATE → PROPOSE (CLAIM) → REVIEW (VERDICT: supports|contradicts|needs_revision)
→ REVISE → SYNTHESIZE (last round)`. Uses AgentScope **MsgHub** (auto-broadcast off so
parallel rounds are race-free). **Gate**: stop when `reviewed_ratio ≥ 0.8` and
`contradictions == 0`, or `max_rounds` hit. Synthesis drops claims with unresolved
`contradicts` verdicts.

### Data models + API
```
TeamTask:        id, orgId, teamId?, brief, rosterEmployeeIds[], status, maxRounds,
                 gateReason?, roundsCompleted, claimCount, reviewCount, revisionCount,
                 contradictions, finalAnswer?
TeamTaskMessage: id, taskId, senderId, senderName, senderRole?, kind, roundNum,
                 content, metadata(JSON)

POST /v1/team-tasks                          {brief, roster_slugs[], max_rounds?, slack_*?}
GET  /v1/team-tasks  [?limit]                list
GET  /v1/team-tasks/:id                       status + metrics + final_answer
GET  /v1/team-tasks/:id/transcript [?after_ts] incremental messages
```

---

## 6. Agent Swarm — resident graph-hygiene agents

### Functionality
Three resident agents keep the knowledge graph healthy:
- **Faraday** (Scanner) — finds clusters, duplicates, stale facts, update-chains, orphans.
- **Feynman** (Analyst) — classifies findings into hypotheses (`duplicate_cluster,
  stale_truth, update_chain, recurring_issue, emerging_pattern`).
- **Turing** (Verifier) — proposes (not auto-executes) actions to an approval queue:
  `archive_duplicates, link_update_chain, suppress_noise_cluster, promote_known_risk`.

Run a single agent or the full **Faraday→Feynman→Turing** chain; poll the run every 2.5s
until terminal; review findings as proposal cards; approve per-card → executes against the
graph hygiene endpoint. A **Phase-3 research-session buffer** (polled every 10s) lets you
approve/discard buffered proposals by kind before they persist to memories.

### API (`/v1/proxy/...`)
```
GET  /swarm/resident/agents
POST /swarm/resident/agents/:agentId/run         {scope, goal, project?, dry_run?}
GET  /swarm/resident/runs/:runId                  {status, result:{observations, hypotheses, verification_results}}
POST /swarm/resident/runs/:runId/cancel
POST /graph/hygiene/scan                          {limit, goal?, categories?}
POST /graph/hygiene/execute                       {proposals[], action}
GET  /research/sessions ; .../pending-proposals ; .../approve?kinds= ; .../discard
```

---

## 7. Swarm Governance

Audit + approval workflow for memory mutations. State machine:
`proposed → approved → applied | rejected | reverted | failed`. Dashboard shows
status-count cards, an **agent-state table** (`last_run, tokens_today, daily_budget,
circuit_breaker`), and an action log with per-action / per-batch approve, reject, rollback.

```
POST /proxy/swarm/resident/cycle                  run a governance cycle
GET  /proxy/governance/metrics?days=
GET  /proxy/governance/action-log?status=&limit=
POST /proxy/governance/actions/:id/approve | /reject
POST /proxy/governance/rollback/:batchId          → {reverted, attempted}
```

---

## 8. Agent execution engine (employees-service)

- **Framework**: FastAPI (`main.py`, default port 8060). Lifespan boots Postgres pool,
  Redis, Slack gateway; runs a reconcile loop (~30s) to open/close Slack connections for
  running employees. `POST /admin/reload` is triggered by control-plane after CRUD.
- **`build_react_agent()`** (`agents/agentscope_factory.py`):
  - **Model routing** by `llmProvider`: `openai` → OpenAI direct; `anthropic_direct` →
    Anthropic SDK; default (`anthropic|groq|...`) → OpenRouter, with Groq fallback.
    `max_retries=3, timeout=60s`.
  - **Multi-agent formatters** preserve speaker identity for MsgHub.
  - **Toolkit** (`agentscope_tools.py`): `hivemind_recall, hivemind_save_memory,
    hivemind_web_search, hivemind_list_memories, hivemind_get_memory,
    hivemind_traverse_graph, hivemind_query_with_ai, hivemind_slack_post/react/search/history`.
    Tools close over the employee's scoped key (or master + emulation headers).
  - **Memory**: per-agent `InMemoryMemory()` (conversation-scoped).
- **Lane playbooks** enforce mandatory tool sequences per CSI lane (e.g., Skeptic must
  recall risks + traverse `Contradicts` edges + cite ≥1 contradiction before speaking).

### HIVEMIND memory integration (`hivemind_client.py`)
- **Per-employee client** with the scoped key: `recall, save_memory, slack_*`.
- **Emulated recall** when no scoped key: master key + `X-HM-User-Id` / `X-HM-Org-Id`
  headers so recall runs as the room owner.

---

## 9. Persistence

- **Postgres (Prisma)** — `digital_employees, hyper_rooms, hyper_turns, team_tasks,
  team_task_messages, agent_trust, agent_evals, slack_events, action_intent`.
  Schema: `core/prisma/schema.prisma`.
- **Redis** — Slack-event dedup (idempotency) + ephemeral room/agent state.
- **HIVEMIND memory engine** (Qdrant vectors + Postgres graph) — recall/save target; room
  decisions and approved research proposals land here.

---

## 10. Connectors & security

- **Slack** — Bolt gateway (`slack/gateway.py`), one app across many workspace tokens;
  inbound events → `SlackEvent` audit → policy gate → employee agent; per-message identity
  override (`slack_display_name`, `slack_avatar_emoji`).
- **WhatsApp** — `core/src/connectors/providers/whatsapp/bridge.js`, singleton client,
  QR pairing lifecycle, `bridge.sendMessage()`.
- **Auth** — admin/orchestration endpoints require the master `X-Admin-Token`; employees
  use scoped keys (with master+emulation fallback); all outbound actions pass an
  **action-intent policy gate**.

---

## 11. Routes & navigation

```
/hivemind/app/employees           → HyperAgents     (main landing: rooms + roster)
/hivemind/app/employees/roster    → DigitalEmployees (roster-only)
/hivemind/app/swarm               → AgentSwarm
/hivemind/app/governance          → SwarmGovernance
```
Sidebar: "Hyper Agents" (Workspace Admin group), "Agent Swarm" (Advanced).

---

## 12. Key source files

**Frontend** (`frontend/Da-vinci/src/components/hivemind/app/`)
- `pages/DigitalEmployees.jsx`, `pages/HyperAgents.jsx`, `pages/EmployeePlayground.jsx`,
  `pages/AgentSwarm.jsx`, `pages/SwarmGovernance.jsx`
- `shared/api-client.js` (all endpoints), `layout/Sidebar.jsx`, `HiveMindApp.jsx` (routes)

**Backend — Python** (`employees-service/src/hivemind_employees/`)
- `main.py`, `config.py`, `db.py`, `redis_client.py`, `hivemind_client.py`
- `api_team_tasks.py`, `api_hyper_rooms.py`, `api_employee_chat.py`
- `agents/agentscope_factory.py`, `agents/agentscope_tools.py`
- `orchestration/team_room.py`, `orchestration/worker.py`, `orchestration/task_store.py`,
  `orchestration/slack_streamer.py`
- `slack/gateway.py`, `slack/router.py`

**Backend — Node** (`core/`)
- `src/employees/hyper-rooms.js` (CSI lanes, idempotency, event append, seal)
- `src/employees/hyper-state.js` (tuning / `active_prompt_version`)
- `src/connectors/providers/whatsapp/bridge.js`
- `prisma/schema.prisma`

---

*Generated from a full read of the frontend pages, `api-client.js`, the FastAPI
employees-service, and the Prisma schema. Line-level details may drift as the code
evolves — treat file paths as the source of truth.*
