# Digital Employees — Architecture, History, Current State

> **Status:** Production. `hm-employees` container live on Coolify.
> Stack: SlackAgents + AgentScope + HIVEMIND MCP tools.
> Phase 3.3 (multi-agent peer-review via TeamRoom phase machine).

---

## 1. What "Digital Employee" means

A Digital Employee is a persistent, multi-tenant AI agent identified by an org. It has:

- A **persona** (system prompt)
- A **role archetype** (planner / executor / reviewer / synthesizer)
- A **scoped HIVEMIND API key** (memory access, audit-attributable)
- **Slack identity** (per-message `username + icon` override via `chat:write.customize`)
- **Policy rules** (which actions auto-approve vs. queue for human)
- A **status lifecycle**: `draft → deploying → running → paused → error`
- An **action audit trail** (`ActionIntent` rows for every outbound side-effect)

Goal: turn HIVEMIND from a passive memory engine into an active workforce — agents that observe Slack channels, ingest context, take actions (post, react, search, history), and collaborate as multi-agent teams on assigned tasks.

---

## 2. History — two architectures, one survivor

### v1: Hermes per-pod (SHELVED 2026-05-11)

`docs/architecture/digital-employees-hermes-plan.md` (kept for reference)

```
1 employee = 1 Docker pod running nousresearch/hermes-agent
  - Per-employee tokens + scoped key + cron + voice/browser
  - Bind-mounted state, network-isolated, resource-capped
```

Pros: battle-tested Nous Research product, first-class Docker story, MCP-client out-of-box.

Cons:
- Heavy — per-employee container at $2-3/mo each
- Overkill for Slack-only day-1 surface
- No native multi-agent collaboration (manual delegation only)
- Hermes general-purpose; we need Slack-first specialization

**Decision**: Shelved. Reusable for future surfaces (voice, email, custom apps).

### v2: SlackAgents + AgentScope (ACTIVE)

`docs/architecture/digital-employees-slackagents-plan.md` (active production plan)

```
1 service (Python) hosts N employees × N Slack workspaces
  - SlackAgents (Salesforce) for Slack edge — Socket Mode + Bolt apps
  - AgentScope (Alibaba) Master-Worker for task orchestration
  - HIVEMIND MCP tools wrapped as Python FunctionTool callbacks
```

Pros:
- Single container = cheap, simple ops
- Multi-tenant in-process; consistent-hash sharding by `slackTeamId` when scaling
- Multi-agent collaboration native (Master-Worker, peer review, role archetypes)
- Re-uses existing HIVEMIND MCP catalog

Cons:
- Python service alongside Node core — two runtimes to maintain
- Process-level isolation only (not per-employee containers)

**Decision**: Active. Running on prod 2026-05-13+.

---

## 3. Production deployment shape

```
┌────────────────────┐  ┌────────────────────┐  ┌─────────────────────────┐
│ hm-control-plane   │  │ hm-core            │  │ hm-employees            │
│ (Node.js)          │  │ (Node.js)          │  │ (Python, SlackAgents +  │
│                    │  │                    │  │   AgentScope)           │
│ - REST API         │  │ - MCP server       │  │ - Slack Bolt apps       │
│ - Auth/OAuth       │  │ - Memory engine    │  │   (1 per workspace)     │
│ - /v1/employees    │  │ - SlackBridge      │  │ - WorkflowAgent pool    │
│   CRUD             │  │ - Audit log        │  │   (1 per employee)      │
│                    │  │ - 30+ MCP tools    │  │ - AgentScope master-    │
│                    │  │                    │  │   worker per task       │
└────────┬───────────┘  └─────┬──────────────┘  └──────────┬──────────────┘
         │                    ▲                            │
         │                    │ MCP calls (HTTP JSON-RPC)  │
         │                    └────────────────────────────┘
         │                                                 │
         │   shared infra                                  │
         │   ┌──────────────────┐    ┌──────────────────┐ │
         └──►│  postgres        │◄───┤  redis           ├─┘
             │  (DigitalEmployee│    │  (BullMQ + state)│
             │   SlackEvent     │    │                  │
             │   ActionIntent)  │    │                  │
             └──────────────────┘    └──────────────────┘
```

**Current containers** (Coolify, host `myserver`):

```
hm-employees           Up 4 days
hivemind-caddy-employees  Up 4 days   ← ingress proxy
```

Resource caps (from `docker-compose.coolify.yml`):
- CPU: 1.0 limit / 0.25 reservation
- Memory: 1GB limit / 256MB reservation
- Restart policy: on-failure, max 3 attempts in 120s window

---

## 4. Database schema (Prisma)

Four migrations:

```
20260511190000_digital_employees             — initial tables
20260511220000_employee_scoped_key           — per-employee HIVEMIND API key
20260512120000_employee_slack_identity_override — Slack username/icon per call
20260513140000_employee_role_archetype       — Phase 3.3 multi-agent metadata
```

### `digital_employees` table

```sql
CREATE TABLE digital_employees (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  team_id UUID,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(120) NOT NULL,
  avatar_url TEXT,
  persona TEXT NOT NULL,                       -- system prompt
  model VARCHAR(100) DEFAULT 'claude-haiku-4-5',
  llm_provider VARCHAR(50) DEFAULT 'anthropic',
  hivemind_api_key_id UUID,
  scoped_api_key_encrypted TEXT,               -- per-employee scoped key
  scope VARCHAR(20) DEFAULT 'team',            -- personal | team | organization
  slack_team_id VARCHAR(64),
  slack_bot_user_id VARCHAR(64),
  slack_channels_allowed TEXT[] DEFAULT '{}',
  slack_display_name TEXT,                     -- per-call identity override
  slack_avatar_emoji TEXT,
  role_archetype VARCHAR(40),                  -- planner | executor | reviewer | synthesizer
  peer_review_targets TEXT[] DEFAULT '{}',
  tools TEXT[] DEFAULT '{}',                   -- allowed MCP tool subset
  policy_rules JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'draft',          -- draft | deploying | running | paused | error
  replicas INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ,
  created_by UUID,
  ...
);
```

### `slack_events` table

```sql
CREATE TABLE slack_events (
  id UUID PRIMARY KEY,
  slack_event_id VARCHAR(64) UNIQUE,             -- Slack's event_id (dedup key)
  workspace_id VARCHAR(64) NOT NULL,
  channel_id VARCHAR(64),
  ts VARCHAR(64),
  event_type VARCHAR(64),
  event_subtype VARCHAR(64),
  routed_to_employee_id UUID,                    -- which employee handled it
  payload JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'queued',           -- queued | processing | done | failed | dlq
  attempts INT DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);
```

Indexes: `(workspace_id, channel_id)`, `(status, created_at)`, `(routed_to_employee_id)`.

### `action_intents` table

Every outbound action an employee wants to take. Persisted BEFORE the policy gate fires.

```sql
CREATE TABLE action_intents (
  id UUID PRIMARY KEY,
  employee_id UUID NOT NULL,
  action_type VARCHAR(64),       -- slack_post | slack_react | slack_search | slack_history
  payload JSONB NOT NULL,
  status VARCHAR(20),            -- pending | approved | denied | executed | failed
  deny_reason TEXT,
  result JSONB,
  approved_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);
```

This powers:
- Audit trail (who did what when)
- Replay (re-execute failed actions)
- Human-in-the-loop approval for `slack_post` / writes

---

## 5. Service modules (`employees-service/src/hivemind_employees/`)

```
hivemind_employees/
├── main.py                              FastAPI entry, mounts routers + Slack apps
├── config.py                            Env config (Slack tokens, MCP URL, DB url)
├── db.py                                asyncpg pool + per-employee row loader
├── bootstrap_client.py                  Bootstrap HIVEMIND API key + scoped per-employee
├── hivemind_client.py                   HIVEMIND HTTP MCP client (POST /api/mcp)
├── redis_client.py                      Redis pool + BullMQ-style queue
├── sessions.py                          Per-conversation state (Slack thread / DM)
├── audit.py                             ActionIntent CRUD + audit_log emit
├── api_employee_chat.py                 POST /:slug/chat — direct chat endpoint (test/playground)
├── api_team_tasks.py                    POST /:slug/tasks — team-task orchestration
├── agents/
│   ├── factory.py                       Build WorkflowAgent per employee row
│   ├── agentscope_factory.py            Build AgentScope ReActAgent for sub-tasks
│   ├── tools.py                         HIVEMIND MCP → FunctionTool wrappers (memory, slack, web)
│   └── agentscope_tools.py              AgentScope-flavored tool variants
├── orchestration/
│   ├── worker.py                        Long-running task worker (consumes BullMQ)
│   ├── task_store.py                    Postgres-backed task CRUD
│   ├── team_room.py                     Multi-agent collaboration phase machine (Phase 3.3)
│   ├── slack_streamer.py                Stream agent output → Slack thread incrementally
│   └── smoke.py                         Smoke-test harness
└── slack/
    ├── gateway.py                       Slack Bolt app factory (one per workspace)
    └── router.py                        event → employee routing logic
```

### Key flows

#### Slack → Employee → Action
```
1. Slack event hits hivemind-caddy-employees → hm-employees /slack/events
2. slack/gateway.py verifies signature, dedups via slack_event_id
3. slack/router.py picks employee by channel allow-list or @mention
4. orchestration/worker.py enqueues task in Redis BullMQ
5. agents/factory.py loads employee row, builds WorkflowAgent with persona + tools
6. Agent runs ReAct loop: think → call tool → observe → repeat
7. Every outbound side-effect → audit.action_intent_create
8. Policy gate fires → execute OR queue for human
9. slack_streamer.py streams partial output into Slack thread
10. Final ActionIntent updated with result/error + slack_events.status=done
```

#### Tool registry
Each employee gets a subset of HIVEMIND MCP tools based on `digital_employees.tools[]` column:

| Bucket | Tools |
|--------|-------|
| Memory | `recall`, `save_memory`, `traverse_graph`, `list_memories`, `get_memory` |
| Slack | `slack_post`, `slack_react`, `slack_search`, `slack_history` |
| Web | `web_search`, `web_crawl`, `web_job_status` |
| Code | `ingest_code`, `recall_bugs`, `why_code` (if employee.scope=team) |

Wrapped via `slackagents.tools.function_tool.FunctionTool.from_function(...)` so SlackAgents WorkflowAgent picks them up natively.

---

## 6. Phase progression

| Phase | Status | Scope |
|-------|--------|-------|
| **Phase 1** | ✅ shipped | DB schema + Prisma models, CRUD via control-plane `/v1/employees` |
| **Phase 2** | ✅ shipped | hm-employees Python container, single-employee Slack DM flow, ReAct loop, tool wrapping |
| **Phase 3.1** | ✅ shipped | Multi-workspace support via consistent-hash sharding |
| **Phase 3.2** | ✅ shipped | Per-employee scoped HIVEMIND API key (no shared master) |
| **Phase 3.3** | ✅ shipped | Multi-agent collaboration: role archetypes, peer review targets, TeamRoom phase machine |
| **Phase 4** | 🟡 in-progress | Long-running task workflows (BullMQ workers, slack streaming) |
| **Phase 5** | ⏳ planned | Approval UI in FE (`/hivemind/app/employees`) — ActionIntent review queue |
| **Phase 6** | ⏳ planned | Quarterly-checkin reference workflow (from SlackAgents examples) — calendar + jira integration |
| **Phase 7** | ⏳ planned | Voice / email surface (Hermes plan revival possible) |

---

## 7. Multi-agent collaboration (Phase 3.3 deep-dive)

The killer feature. AgentScope Master-Worker + role archetypes:

### Archetypes

| Archetype | Personality | Tool emphasis |
|-----------|------------|---------------|
| `planner` | Decomposes ambiguous tasks into sub-steps | recall, traverse_graph, web_search |
| `executor` | Runs the steps the planner produced | slack_post, save_memory, ingest_code |
| `reviewer` | Adversarial — challenges the executor's output | recall (for prior decisions), recall_bugs |
| `synthesizer` | Merges multiple reviewer + executor outputs | query_with_ai, save_memory |

### TeamRoom phase machine
`orchestration/team_room.py`

```
PHASE 1: INTAKE
  - Planner reads task spec + recalls prior context
  - Emits step list → task_store

PHASE 2: PARALLEL EXECUTION
  - One executor per step, run concurrently via AgentScope worker pool
  - Each executor has its own session memory + tool budget

PHASE 3: PEER REVIEW
  - Reviewers picked from peer_review_targets[]
  - Each reviewer reads ALL executor outputs + emits critique
  - Confidence score per critique

PHASE 4: SYNTHESIS
  - Synthesizer merges executor + reviewer outputs
  - Emits final answer + saves narrative as memory (tagged team-task:<id>)

PHASE 5: AUDIT
  - audit.action_intent_create for any side-effects
  - slack_streamer pushes final answer to original thread
```

**Why this matters**: hard tasks get adversarial review before action. Reduces hallucinations + bad decisions. Each phase has its own timeout + retry budget.

---

## 8. Slack identity (multi-bot trick)

Initial plan: one Slack app per employee. Rejected — Slack rate-limits app installs per workspace.

**Solution**: ONE Slack app per workspace, posts with per-message identity override:

```python
# In slack_streamer.py — every post call:
await slack_client.chat_postMessage(
    channel=channel_id,
    text=output,
    username=employee.slack_display_name or employee.name,
    icon_url=employee.avatar_url,
    icon_emoji=employee.slack_avatar_emoji,
)
```

This requires `chat:write.customize` OAuth scope. Slack renders each message as if it came from a different bot — users see distinct avatars + names per employee.

---

## 9. Scoped HIVEMIND API keys

Each employee gets its own HIVEMIND key (not the workspace's master key). Reasons:

| Reason | Benefit |
|--------|---------|
| **Audit attribution** | Every MCP call is logged as the employee's key prefix, not "the system" |
| **Independent revocation** | Pause an employee = revoke its key; other employees unaffected |
| **Scope isolation** | Employee key has `tools[]` subset rights only |
| **Rate limiting** | Per-employee quota independent of org master |
| **Compliance** | "Show me everything Lyra (employee) accessed last week" → audit_log filter by key_prefix |

Key encrypted at-rest in `digital_employees.scoped_api_key_encrypted`. `bootstrap_client.py` provisions on first deploy.

---

## 10. Endpoints

### Control-plane `/v1/employees/...` (Node.js)
- `POST   /v1/employees` — create
- `GET    /v1/employees` — list
- `GET    /v1/employees/:id` — read
- `PATCH  /v1/employees/:id` — update (persona, tools, policy)
- `DELETE /v1/employees/:id` — archive
- `POST   /v1/employees/:id/deploy` — provision Slack app + scoped key + flip status
- `POST   /v1/employees/:id/pause` / `/resume`

### Core `/api/employees/slack-action` (Node.js)
The action gateway. Called from MCP tools (`hivemind_slack_post` etc) — runs policy gate, executes via SlackBridge, persists ActionIntent.

### Employees-service (Python)
- `POST /:slug/chat` — direct chat for playground UI (no Slack involved)
- `POST /:slug/tasks` — team-task orchestration entry
- `POST /slack/events` — Slack webhook (Bolt app)
- `POST /slack/interactions` — button clicks
- `GET  /health` — liveness

### Frontend
- `/hivemind/app/employees` — list + create + edit (control-plane)
- `/hivemind/app/employees/:id/playground` — direct chat for testing

---

## 11. Configuration

Env vars (from `config.py` + Coolify):

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection |
| `REDIS_URL` | Redis for queue + sessions |
| `HIVEMIND_MCP_URL` | `http://hm-core:8050/api/mcp` (internal docker net) |
| `HIVEMIND_MASTER_KEY` | Bootstrap key for provisioning scoped keys |
| `SLACK_APP_TOKEN_<workspaceId>` | Per-workspace xapp token (Socket Mode) |
| `SLACK_BOT_TOKEN_<workspaceId>` | Per-workspace xoxb token |
| `SLACK_SIGNING_SECRET_<workspaceId>` | Verify Slack signatures |
| `LLM_PROVIDER_ANTHROPIC_KEY` | Anthropic API key for Claude employees |
| `LLM_PROVIDER_GROQ_KEY` | Groq for cheap Llama-backed employees |

Ingress: `hivemind-caddy-employees` Caddy container reverse-proxies HTTPS → `hm-employees:8060`.

---

## 12. Audit trail

Every employee action emits **two** audit rows:

1. `audit_log` (HIVEMIND-wide) — `eventType: 'action.<type>.executed' | 'action.<type>.denied' | 'action.<type>.failed'`, `actorType: 'api_key'`, `actorApiKeyId: <employee.hivemindApiKeyId>`
2. `action_intents` (employee-specific) — full payload + result + approver

Filter `/hivemind/app/audit-log` by category=`employee` to see every employee mutation.

---

## 13. Policy engine

`core/src/employees/policy.js` (Node) + Python policy gate in `audit.py`:

```js
// Hard rules (cannot be bypassed):
- slack_post into a channel NOT in employee.slack_channels_allowed → DENY
- Action type NOT in employee.tools[] → DENY
- Employee.status !== 'running' → DENY
- Employee.org_id mismatch with caller's API key → DENY

// Soft rules (configurable per employee.policy_rules):
- require_human_approval: ['slack_post' | 'slack_react' | ...]
- daily_action_cap: { slack_post: 50 }
- channels_require_approval: ['C_EXEC_*', 'C_CUSTOMER_*']
- after_hours_block: { tz: 'Europe/Berlin', off_hours: '22:00-07:00' }
```

If `require_human_approval` matches, the ActionIntent persists as `pending` and an approval card posts in the org admin's Slack DM (or surfaces in the FE approval queue once Phase 5 lands).

---

## 14. Current production state (as of 2026-05-17)

```bash
# On myserver:
docker ps --format '{{.Names}}\t{{.Status}}' | grep employ
# → hm-employees             Up 4 days
# → hivemind-caddy-employees  Up 4 days
```

DB rows:
```sql
SELECT slug, scope, status, role_archetype, replicas FROM digital_employees;
-- Returns the active employees on this user's org
```

Production employees (live):
- Persona-driven Slack bots per workspace
- Multi-agent TeamRoom orchestration available via `/:slug/tasks` endpoint
- Audit log captured per ActionIntent
- Scoped API keys provisioned

Frontend status: `EmployeePlayground.jsx` exists for direct chat testing. Full `/hivemind/app/employees` CRUD page polished but Phase 5 approval queue UI not yet built.

---

## 15. Known gaps (Phase 5+)

| Gap | Impact | Plan |
|-----|--------|------|
| No FE approval queue | Admin can't easily approve `pending` ActionIntents — must use SQL or Slack DM card | Phase 5 — `/hivemind/app/employees/approvals` page mirroring Governance Swarm approval UX |
| Daily action caps not enforced | Soft policy — `daily_action_cap` field exists but executor doesn't read it yet | Phase 5 — read + decrement in policy gate |
| No employee health dashboard | Can't see "Lyra: 12 actions, 2 denied, 3 pending today" | Phase 5 — stats card in `/employees/:id` page |
| Quarterly-checkin example unwired | Reference workflow exists in `vendor/slackagents/app/quarterly-checkin/` but not provisioned as a real employee | Phase 6 — first canned employee template, ships with HIVEMIND |
| Voice / email surfaces | Slack-only today | Phase 7 — revive Hermes plan for non-Slack surfaces |
| Cross-employee handoff | Employees can't delegate to each other yet | Phase 3.4 — add `delegate(employee_slug, sub_task)` tool |
| LLM cost dashboard per employee | No per-employee token usage tracking | Phase 5 — emit usage row per ReAct turn |

---

## 16. File index

```
core/
├── prisma/
│   ├── schema.prisma                                # Models: DigitalEmployee, SlackEvent, ActionIntent
│   └── migrations/
│       ├── 20260511190000_digital_employees/
│       ├── 20260511220000_employee_scoped_key/
│       ├── 20260512120000_employee_slack_identity_override/
│       └── 20260513140000_employee_role_archetype/
├── src/
│   ├── server.js                                    # /api/employees/slack-action gateway
│   └── employees/
│       ├── policy.js                                # Hard + soft rule engine
│       └── store.js                                 # Prisma wrapper
│
employees-service/                                   # Python service
├── Dockerfile
├── pyproject.toml
├── README.md
├── src/hivemind_employees/
│   ├── main.py                                      # FastAPI entry
│   ├── config.py                                    # Env config
│   ├── db.py                                        # asyncpg pool
│   ├── hivemind_client.py                           # MCP HTTP client
│   ├── bootstrap_client.py                          # Scoped key provisioning
│   ├── redis_client.py                              # BullMQ
│   ├── sessions.py                                  # Conversation state
│   ├── audit.py                                     # ActionIntent CRUD
│   ├── api_employee_chat.py                         # POST /:slug/chat
│   ├── api_team_tasks.py                            # POST /:slug/tasks
│   ├── agents/
│   │   ├── factory.py                               # Build WorkflowAgent per employee
│   │   ├── agentscope_factory.py                    # Build AgentScope ReActAgent
│   │   ├── tools.py                                 # HIVEMIND → FunctionTool wrappers
│   │   └── agentscope_tools.py
│   ├── orchestration/
│   │   ├── worker.py                                # Long-running task worker
│   │   ├── task_store.py
│   │   ├── team_room.py                             # Phase 3.3 multi-agent phase machine
│   │   ├── slack_streamer.py                        # Incremental Slack output
│   │   └── smoke.py
│   └── slack/
│       ├── gateway.py                               # Slack Bolt app factory
│       └── router.py                                # Event → employee routing
└── vendor/slackagents/                              # Pinned reference + canned workflows
    ├── app/quarterly-checkin/                       # Phase 6 template (calendar + jira)
    └── examples/

frontend/Da-vinci/src/components/hivemind/app/pages/
└── EmployeePlayground.jsx                           # Direct chat testing UI

docs/architecture/
├── digital-employees-hermes-plan.md                 # Shelved v1 reference
└── digital-employees-slackagents-plan.md            # Active production plan

Deployment:
docker-compose.coolify.yml → hm-employees service definition
Caddyfile.employees                                  → ingress config
```

---

## 17. References

- Hermes architecture (shelved): `/Users/amar/HIVE-MIND/docs/architecture/digital-employees-hermes-plan.md`
- SlackAgents architecture (active): `/Users/amar/HIVE-MIND/docs/architecture/digital-employees-slackagents-plan.md`
- SlackAgents library: https://github.com/salesforce/SlackAgents
- AgentScope library: https://github.com/agentscope-ai/agentscope
- Companion docs:
  - `core/docs/MCP_SERVER.md`
  - `core/docs/GOVERNANCE_SWARM.md`
  - `core/docs/GOOGLE_WORKSPACE_MCP.md`
  - `core/docs/AUDIT_LOGGING_IMPLEMENTATION.md`

Last lock-in: 2026-05-17.
