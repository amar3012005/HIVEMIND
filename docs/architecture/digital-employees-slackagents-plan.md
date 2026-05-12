# Digital Employees — SlackAgents + AgentScope Architecture (ACTIVE)

> **Status:** Active production plan as of 2026-05-11.
> Supersedes `digital-employees-hermes-plan.md` (kept for future reference).
>
> Goal: ship the `/hivemind/app/employees` dashboard section + a separate
> Python service `hivemind-employees` running in production from day one —
> NOT a local-dev-only feature.

## Stack decision

| Layer | Choice | Why |
|---|---|---|
| Slack edge | **SlackAgents** (Salesforce, Apache 2.0) | Purpose-built for multi-agent collab in Slack; channel-team routing, multi-bot per workspace, event dedup baked in |
| Agent orchestration | **AgentScope Master-Worker** (Alibaba) | Dynamic worker spawning per task; gives "digital employee force" feel — one supervisor agent delegates to specialist sub-agents |
| Tools | **HIVEMIND MCP** (existing) | 22+ memory/web/code/time-travel tools already live; reuse as Python `function_tool` wrappers |
| Runtime | **Single Python service** (`hivemind-employees`) | Multi-tenant in-process; one container hosts N employees + N Slack workspaces. Independent of core/control-plane lifecycle |
| Scaling | **N replicas with workspace affinity** | When load demands, run multiple replicas keyed by consistent hash of `slackTeamId` so no two replicas own the same workspace |
| Deployment | **Coolify** — new service alongside `hm-core` + `hm-control-plane` | Same deploy/restart UX, separate scaling, isolated load |

## Production deployment shape

```
existing                                              new
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────────┐
│  hm-control-     │   │  hm-core         │   │  hm-employees            │
│  plane (Node)    │   │  (Node)          │   │  (Python, SlackAgents +  │
│                  │   │                  │   │   AgentScope)            │
│  - REST API      │   │  - MCP server    │   │  - Slack Bolt apps       │
│  - Auth/OAuth    │   │  - Memory engine │   │    (1 per workspace)     │
│  - /v1/employees │   │  - SlackBridge   │   │  - WorkflowAgent pool    │
│    CRUD          │   │  - Audit log     │   │    (1 per employee)     │
│                  │   │  - 22 MCP tools  │   │  - AgentScope master-    │
│                  │   │                  │   │    worker for tasks      │
└────────┬─────────┘   └─────┬────────────┘   └──────────┬───────────────┘
         │                   ▲                            │
         │                   │ MCP calls (via mcp-bridge) │
         │                   └────────────────────────────┘
         │                                                │
         │   shared infra                                 │
         │   ┌──────────────────┐    ┌──────────────────┐│
         └──►│  hm-postgres     │◄───┤  hm-redis        ├┘
             │  (DigitalEmployee│    │  (BullMQ +       │
             │   SlackEvent     │    │   session state) │
             │   ActionIntent)  │    │                  │
             └──────────────────┘    └──────────────────┘
```

**Single service for N employees** — not one container per employee. SlackAgents
library is designed for multi-agent multi-workspace in one Python process.
Saves ~$50/mo Hetzner cost + simpler ops.

When CPU/conn count gets high, scale out replicas using **consistent-hash
sharding by `slackTeamId`** — no two replicas own the same workspace, no
duplicate event handling.

## Coolify service definition

Append to `deployment/docker-compose.coolify.yml`:

```yaml
hivemind-employees:
  image: hivemind/employees:latest
  build:
    context: ./employees-service
    dockerfile: Dockerfile
  restart: unless-stopped
  environment:
    - DATABASE_URL=${DATABASE_URL}
    - REDIS_URL=${REDIS_URL}
    - HIVEMIND_CORE_URL=https://core.hivemind.davinciai.eu:8050
    - HIVEMIND_CP_URL=https://api.hivemind.davinciai.eu:8040
    - HIVEMIND_MASTER_API_KEY=${HIVEMIND_MASTER_API_KEY}
    - REPLICA_ID=${HOSTNAME}
    - REPLICA_COUNT=${REPLICA_COUNT:-1}
    - LOG_LEVEL=info
    - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}   # default LLM, per-employee can override
    - OPENAI_API_KEY=${OPENAI_API_KEY}
  ports:
    - "8060:8060"   # health + admin API
  depends_on:
    - hm-postgres
    - hm-redis
    - hm-core
  labels:
    coolify.managed: "true"
    coolify.name: "hivemind-employees"
```

Public admin/health URL: `https://core.hivemind.davinciai.eu:8061` via a
dedicated Caddy sidecar that reuses the `core.hivemind.davinciai.eu`
certificate. JSON API only (no public UI). UI lives at
`hivemind.davinciai.eu/hivemind/app/employees`.

## Source tree

```
employees-service/
├── Dockerfile
├── pyproject.toml               # poetry: slackagents, agentscope, fastapi, redis, prisma-py
├── poetry.lock
├── alembic/                     # (no — reuse main Postgres schema via Prisma migrations from core)
├── src/
│   └── hivemind_employees/
│       ├── __init__.py
│       ├── main.py              # FastAPI app + service lifecycle
│       ├── config.py            # env + per-employee runtime config
│       ├── db.py                # asyncpg connection pool to shared Postgres
│       ├── redis_client.py
│       ├── hivemind_client.py   # HTTP client to HIVEMIND core REST + MCP
│       ├── slack/
│       │   ├── gateway.py       # SlackAgents bolt app manager (one app per workspace)
│       │   ├── router.py        # event → employee routing (channel + mention)
│       │   └── action_service.py # forwards intents to HIVEMIND SlackBridge via MCP
│       ├── agents/
│       │   ├── factory.py       # build SlackAgents.WorkflowAgent from DB row
│       │   ├── personas.py      # persona templates
│       │   └── tools.py         # MCP tool → SlackAgents function_tool wrapper
│       ├── orchestration/
│       │   ├── master_worker.py # AgentScope Master-Worker integration
│       │   └── delegations.py   # task → sub-agent mapping
│       ├── policy/
│       │   └── engine.py        # channel allowlist + rate limit + work-hours
│       ├── reconcile/
│       │   ├── loop.py          # poll /v1/employees every 30s for config drift
│       │   └── sharding.py      # consistent-hash workspace assignment to replica
│       ├── audit.py             # POST to HIVEMIND core /api/audit/log
│       └── observability.py     # /metrics endpoint for Prometheus
└── tests/
    ├── test_policy.py
    ├── test_router.py
    └── test_factory.py
```

## Dockerfile

```dockerfile
FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 \
    POETRY_VERSION=1.8.3 \
    POETRY_NO_INTERACTION=1 \
    POETRY_VIRTUALENVS_CREATE=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gcc python3-dev && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "poetry==${POETRY_VERSION}"

WORKDIR /app
COPY pyproject.toml poetry.lock ./
RUN poetry install --only main --no-root

COPY src/ ./src/
RUN poetry install --only main

EXPOSE 8060
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8060/health || exit 1

CMD ["python", "-m", "hivemind_employees.main"]
```

## Service lifecycle (FastAPI)

```python
# main.py
from fastapi import FastAPI
from contextlib import asynccontextmanager
from .config import settings
from .slack.gateway import SlackGateway
from .reconcile.loop import ReconcileLoop
from .observability import metrics_router

gateway: SlackGateway = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global gateway
    gateway = SlackGateway(settings)
    await gateway.start()                  # boots one Bolt app per workspace
    loop = ReconcileLoop(gateway, interval=30)
    loop_task = loop.start()
    yield
    loop.stop()
    await gateway.stop()

app = FastAPI(lifespan=lifespan)
app.include_router(metrics_router)

@app.get("/health")
async def health():
    return {"ok": True, "employees": gateway.employee_count(),
            "workspaces": gateway.workspace_count()}

@app.post("/admin/reload")
async def reload():
    # called by HIVEMIND core when DigitalEmployee table mutates
    await gateway.reload_from_db()
    return {"reloaded": True}
```

## SlackGateway — multi-workspace, multi-employee

```python
# slack/gateway.py
from slack_bolt.async_app import AsyncApp
from slack_bolt.adapter.socket_mode.async_handler import AsyncSocketModeHandler
from slackagents import Assistant, WorkflowAgent
from .router import EventRouter
from ..agents.factory import build_workflow_agent
from ..reconcile.sharding import owns_workspace

class SlackGateway:
    def __init__(self, settings):
        self.settings = settings
        self.workspaces = {}       # slack_team_id -> AsyncApp
        self.employees = {}        # employee_id -> WorkflowAgent
        self.router = EventRouter()

    async def start(self):
        rows = await self._fetch_running_employees()
        for emp in rows:
            if not owns_workspace(emp.slack_team_id, self.settings.replica_id, self.settings.replica_count):
                continue
            await self._ensure_workspace_app(emp)
            self.employees[emp.id] = build_workflow_agent(emp, hivemind_mcp_client=...)

    async def _ensure_workspace_app(self, employee):
        wsid = employee.slack_team_id
        if wsid in self.workspaces:
            return
        bot_token, app_token = await self._resolve_tokens(wsid)
        app = AsyncApp(token=bot_token, signing_secret=self.settings.slack_signing_secret)

        @app.event("app_mention")
        async def on_mention(event, say):
            emp = self.router.route(event, self.employees)
            if not emp: return
            await emp.handle_message(event, say)

        @app.event("message")
        async def on_message(event, say):
            emp = self.router.route(event, self.employees)
            if not emp: return
            await emp.handle_message(event, say)

        handler = AsyncSocketModeHandler(app, app_token)
        asyncio.create_task(handler.start_async())
        self.workspaces[wsid] = app

    async def reload_from_db(self):
        # diff DB vs in-memory state, add/remove employees
        ...
```

## Agent factory — wrap SlackAgents + AgentScope

```python
# agents/factory.py
from slackagents import WorkflowAgent
from agentscope.agents import ReActAgent
from agentscope.orchestration import MasterWorker
from .tools import build_hivemind_tools

def build_workflow_agent(employee_row, hivemind_mcp_client):
    """
    Construct a SlackAgents WorkflowAgent backed by AgentScope Master-Worker
    for complex multi-step tasks. Simple Q&A bypasses Master-Worker for speed.
    """
    tools = build_hivemind_tools(
        mcp_client=hivemind_mcp_client,
        api_key=employee_row.hivemind_api_key,
        enabled_tools=employee_row.tools,
    )

    react_agent = ReActAgent(
        name=employee_row.slug,
        system_prompt=employee_row.persona,
        model=employee_row.model,
        tools=tools,
    )

    # Master-Worker: react_agent decides when to delegate
    master = MasterWorker(
        master=react_agent,
        worker_factory=lambda task: ReActAgent(
            name=f"{employee_row.slug}:worker:{task.id}",
            system_prompt=f"You are a specialist worker. {task.instructions}",
            model=employee_row.model,
            tools=tools,
        ),
        max_workers=employee_row.policy_rules.get("max_workers", 3),
    )

    return WorkflowAgent(
        workflow=master,
        persona=employee_row.persona,
        memory_namespace=f"employee:{employee_row.id}",
        on_message=lambda msg, ctx: hivemind_save_to_memory(
            mcp_client, msg, scope="team", team_id=employee_row.team_id,
        ),
    )
```

## HIVEMIND MCP tools → SlackAgents `function_tool`

```python
# agents/tools.py
from slackagents.tools import function_tool

def build_hivemind_tools(mcp_client, api_key, enabled_tools):
    tools = []

    if "hivemind_recall" in enabled_tools:
        @function_tool(name="recall", description="Recall memories from HIVEMIND")
        async def recall(query: str, max_memories: int = 5):
            return await mcp_client.call("hivemind_recall",
                {"query_context": query, "max_memories": max_memories},
                api_key=api_key)
        tools.append(recall)

    if "hivemind_save_memory" in enabled_tools:
        @function_tool(name="save_memory", description="Save a fact to HIVEMIND")
        async def save_memory(content: str, tags: list[str] = None):
            return await mcp_client.call("hivemind_save_memory",
                {"content": content, "tags": tags or []},
                api_key=api_key)
        tools.append(save_memory)

    if "hivemind_slack_post" in enabled_tools:
        @function_tool(name="slack_post", description="Post a message in Slack")
        async def slack_post(channel: str, text: str, thread_ts: str = None):
            return await mcp_client.call("hivemind_slack_post",
                {"channel": channel, "text": text, "thread_ts": thread_ts},
                api_key=api_key)
        tools.append(slack_post)

    # ... other tools (web_search, code_search, slack_history, etc.)

    return tools
```

## ReconcileLoop — config drift + sharding

```python
# reconcile/loop.py
import asyncio
from .sharding import owns_workspace

class ReconcileLoop:
    def __init__(self, gateway, interval=30):
        self.gateway = gateway
        self.interval = interval
        self._task = None
        self._stop = False

    def start(self):
        self._task = asyncio.create_task(self._run())

    def stop(self):
        self._stop = True

    async def _run(self):
        while not self._stop:
            try:
                await self.gateway.reload_from_db()
            except Exception as e:
                log.warning("reconcile failed: %s", e)
            await asyncio.sleep(self.interval)
```

## Consistent-hash sharding

```python
# reconcile/sharding.py
import hashlib

def owns_workspace(slack_team_id: str, replica_id: str, replica_count: int) -> bool:
    """Return True if this replica owns this workspace."""
    if replica_count <= 1:
        return True
    h = int(hashlib.sha256(slack_team_id.encode()).hexdigest(), 16)
    slot = h % replica_count
    my_slot = int(hashlib.sha256(replica_id.encode()).hexdigest(), 16) % replica_count
    return slot == my_slot
```

Scale-out: bump `REPLICA_COUNT` env to N, deploy N replicas. Each owns a deterministic subset of workspaces. No duplicate event handling.

## HIVEMIND core changes (Node side)

Already done (P0-1..P0-5):
- SlackBridge with post/search/history (P0-1)
- Audit log + scope filtering (P0-3)
- RBAC (P0-4)

To add for employees:

### 1. Schema (same as Hermes plan)

`DigitalEmployee`, `SlackEvent`, `ActionIntent` tables. Migration timestamp
`20260511190000_digital_employees`.

### 2. REST endpoints in control-plane

```
GET    /v1/employees                       org-scoped list
POST   /v1/employees                       create + mint scoped API key
GET    /v1/employees/:id
PATCH  /v1/employees/:id
POST   /v1/employees/:id/pause             marks status=paused → gateway drops it
POST   /v1/employees/:id/resume
DELETE /v1/employees/:id                   archive
GET    /v1/employees/:id/metrics
GET    /v1/employees/:id/conversations
POST   /v1/employees/:id/rotate-key
POST   /v1/orgs/:id/employees/pause-all    kill switch
```

On any mutation, fire HTTP POST to `hivemind-employees:8060/admin/reload`
to trigger immediate reconcile (rather than waiting 30s).

### 3. 4 new MCP tools wrapping SlackBridge

`hivemind_slack_post`, `hivemind_slack_react`, `hivemind_slack_search`,
`hivemind_slack_history`. Each runs policy gate (channel allowlist, rate limit),
emits audit row, auto-ingests result to memory scope=team.

### 4. New API key scope

`slack:act` — required for the 4 Slack action MCP tools.
Mint on employee creation alongside `memory:read,memory:write,mcp`.

## Frontend — `/hivemind/app/employees`

Same UX as Hermes plan but data source is one `hivemind-employees` service.
Pages:
- `DigitalEmployees.jsx` — grid of cards, status dot, msgs today
- `CreateEmployeeWizard.jsx` — 5-step modal (identity, model, slack, policy, tools)
- `EmployeeDetail.jsx` — tabs (conversations, metrics, memory, settings)

Sidebar link "Digital Employees" under **Workspace Admin** section.

## Build phases — 5d MVP

| Phase | Effort | Deliverable |
|---|---|---|
| **E-1** Schema + REST in HIVEMIND control-plane | 1d | DB tables, `/v1/employees` CRUD, mint scoped API keys, audit hooks |
| **E-2** 4 MCP slack tools + policy gate in core | 1d | `hivemind_slack_post` etc, policy.js with channel + rate limit + audit |
| **E-3** `hivemind-employees` Python service | 1.5d | FastAPI shell, SlackGateway with one workspace, WorkflowAgent factory, MCP tool wrappers |
| **E-4** AgentScope Master-Worker integration + reconcile loop + sharding | 1d | Master-worker delegation for complex tasks, 30s reconcile, consistent-hash sharding |
| **E-5** Frontend page + Coolify deploy | 1.5d | Grid + wizard + detail page, docker-compose.coolify.yml service entry, smoke test in production |

## Safety guardrails

| Guard | Where |
|---|---|
| Slack tokens never in employee env | Resolved at gateway level from `platform_integrations` table |
| Rate limit per workspace | Redis sliding window keyed by `slack_team_id` |
| Channel allowlist | Policy engine before any Slack action |
| Audit chain | `slack.event_received` → `agent.task_started` → `action.policy_passed/denied` → `slack.post_executed` → `memory.ingested` |
| Concurrency cap per org | Max 5 employees default, env `MAX_EMPLOYEES_PER_ORG` |
| Kill switch | `POST /v1/orgs/:id/employees/pause-all` → reload → gateway drops all |
| Spend tracking | `metricsLast24h.tokens` increment after each LLM call |
| Container resource cap | Coolify limit: 2GB RAM, 1 CPU per replica |
| Network isolation | Coolify default + outbound restrict via env-injected allowlist |

## Why one Python service beats one container per employee

| Concern | One service | One container per employee |
|---|---|---|
| Infra cost | $5/mo single container | $5 × N employees/mo |
| Cold start | <2s (new agent in-process) | ~30s (Docker spawn + Hermes init) |
| Slack WS connections | Pooled across employees in same workspace | Each container holds its own |
| Hot-add employee | Reconcile loop picks up in 30s | Need orchestrator + image pull |
| Isolation | Shared process (Python GIL + asyncio) | Strong (separate container) |
| Memory leaks blast radius | Whole service restart | Single employee restart |
| Multi-host scaling | Consistent-hash shard across N replicas | Native via K8s HPA |

For Slack-only use case: shared process wins on cost + simplicity. If we
ever need strong cross-employee isolation (e.g., one customer demands
their employees in separate containers), Hermes plan resumes.

## Risks

| Risk | Mitigation |
|---|---|
| Python GIL blocks under high concurrency | FastAPI + asyncio + slack-bolt all async; LLM I/O is async. Scale-out via replicas before GIL hits. |
| One employee's bug crashes service | Each agent task in try/except + structured error reporting; supervisor pattern in AgentScope handles worker failures. |
| Workspace token rotation breaks WS | Gateway listens for `tokens_revoked` event; auto-reconnect with refreshed token from DB. |
| Slack rate limit (workspace-wide) | Redis sliding window per workspace shared across all employees in that workspace. |
| LLM cost runaway | P1-10 billing token quota + per-employee `metricsLast24h.tokens` hard-cap. |
| Replica imbalance after scale event | Consistent-hash + workspace rebalance protocol on replica join/leave. |
| Cross-employee memory leak | `memory_namespace="employee:{id}"` enforced at HIVEMIND save layer + scope filter at recall. |

## Hard prereqs (already shipped)

- P0-1 Teams + Projects + memory scope
- P0-2 Org-shared connectors (Slack tokens live in `platform_integrations`)
- P0-3 Audit log
- P0-4 RBAC

## Soft prereqs

- P1-9 Outbound webhooks (notify on employee error)
- P1-10 Stripe billing (token cap)

## References

- SlackAgents: `/Users/amar/HIVE-MIND/references/SlackAgents/`
  - README: multi-agent collab pattern
  - `examples/agent/` and `app/customer-service-team/` for code patterns
  - PyPI: `pip install slackagents`
- AgentScope: `/Users/amar/HIVE-MIND/.claude/worktrees/happy-lalande-ef74f1/AgentScope-casestudy/pages/`
  - `building-blocks/orchestration.md` — Master-Worker pattern
  - `building-blocks/agent.md` — ReAct, A2A, Realtime agents
  - `building-blocks/tool-capabilities.md` — function tools
  - `out-of-box-agents/` — pre-built agent templates
- HIVEMIND SlackBridge: `core/src/connectors/providers/slack/bridge.js`
- HIVEMIND MCP server: `core/src/server.js` `/api/mcp/...` routes
- Future Hermes alternative: `docs/architecture/digital-employees-hermes-plan.md`

## Coolify production deploy steps

1. Create or update the Coolify compose service:
    - Build context: `employees-service/`
    - Internal service: `hm-employees`
    - Public admin edge: `https://core.hivemind.davinciai.eu:8061`
2. Set env vars: DATABASE_URL, REDIS_URL, HIVEMIND_CORE_URL,
   HIVEMIND_CP_URL, HIVEMIND_MASTER_API_KEY, ANTHROPIC_API_KEY
3. Set REPLICA_COUNT=1 initially; bump when concurrent workspaces > 50
4. Health check: `GET /health` returns 200 with employee + workspace counts
5. Connect to existing `hm-postgres` and `hm-redis` services on the
   Coolify-internal network
6. Deploy. Run prisma migrate from the host shell with the wrapper:
    `cd /opt/HIVEMIND/core && node scripts/prisma-migrate-deploy.mjs`
7. Verify `/admin/reload` callback wired from control-plane after employee CRUD

## Smoke test (post-E-5)

1. Create employee via UI: name "Test", persona "You are a helpful assistant",
   model claude-haiku-4-5, scope=team, slack workspace, channel #general,
   tools=[recall, save_memory, slack_post, slack_search]
2. Verify `digital_employees` row + scoped API key created
3. Verify `/admin/reload` hit on hivemind-employees service
4. Watch service logs: `[gateway] employee=Test slack_team=T01... loaded`
5. In Slack `#general`, post `@Test what's our quarterly revenue?`
6. Service logs: `[router] routed to Test`, `[agent] called recall`,
   `[agent] called slack_post`
7. Slack channel shows reply from Test bot
8. Verify HIVEMIND `audit_logs` rows: `action.slack.post`, `memory.ingested`
9. Verify HIVEMIND `memories` row created with `scope=team`, `tags=["slack","live-slack","employee:Test"]`
