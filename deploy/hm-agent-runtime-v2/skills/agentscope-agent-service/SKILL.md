---
name: agentscope-agent-service
description: "Build, embed, and integrate the AgentScope 2.0.8 Agent Service (FastAPI hosting layer) as the execution substrate for HIVEMIND Digital Employees. Use for create_app wiring, storage/message-bus choice, replacing the X-User-ID stub with hm-core auth, binding a WorkRun to an agent+session, consuming the SSE event stream, schedules/background jobs, model+credential provider setup, and service deployment topology. Invoke BEFORE writing any hm-core <-> agent-runtime integration code."
---

# AgentScope Agent Service — hosting the employee runtime

The Agent Service owns everything **around** the agent: routing, per-user
resource lifecycle, session state, persistence, scheduling, tool offloading. It
does **not** own identity, org, policy, or billing — that is hm-core.

**Announce:** "Using agentscope-agent-service."

Load `.claude/skills/agentscope-runtime/CONTRACT.md` first. It is source-verified
and records the two doc names that are **wrong**.

## The boundary (do not cross it)

| Owned by **hm-core** | Owned by **Agent Service** |
| --- | --- |
| identity, org/tenancy, employees roster | sessions, agents-as-templates |
| policy, approvals, authority gates | schedules, background jobs |
| billing, entitlements | agent teams, delegation |
| connectors registry, HIVE-MIND memory | workspace lifecycle, MCP clients, skills |
| **WorkRun** (the unit of work) | the running session that executes it |

**WorkRun handoff:** hm-core resolves identity → org → policy → entitlements,
creates a `WorkRun`, then calls Agent Service with the resolved `user_id`. Agent
Service never learns what a "WorkRun" is; hm-core never learns what a "session"
is beyond storing the id.

## STEP 0 — Boot a working instance before integrating anything

Do not write integration code against an unverified service. Boot the bundled
example first and confirm each capability:

```bash
cd ~/agentscope
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e ".[full]"

redis-cli ping                      # must print PONG
cd examples/agent_service
python main.py                      # service on http://localhost:8000
```

Frontend (optional but proves the end-to-end surface):

```bash
cd ~/agentscope/examples/web_ui
pnpm install
pnpm dev                            # typically http://localhost:5173
```

Verify the API surface this skill set assumes:

```bash
python .claude/skills/agentscope-runtime/verify_api_surface.py
```

> If `uv pip install` is cancelled or fails, do **not** proceed to integration —
> you cannot distinguish a bug in your code from a broken runtime.

## Building the app

Three arguments are **required**: `storage`, `message_bus`, `workspace_manager`.

```python
from agentscope.app import create_app
from agentscope.app.storage import RedisStorage
from agentscope.app.message_bus import RedisMessageBus
from agentscope.app.workspace_manager import LocalWorkspaceManager

app = create_app(
    storage=RedisStorage(host="localhost", port=6379),
    message_bus=RedisMessageBus(host="localhost", port=6379),
    workspace_manager=LocalWorkspaceManager(basedir="/data/workspaces"),
    title="HIVEMIND Employees",
)
```

`create_app` takes `**kwargs`, so **a misspelled keyword is swallowed silently**.
Always verify against `CONTRACT.md` or the verifier script.

Mount it under hm-core rather than exposing it directly:

```python
root = FastAPI()
root.mount("/agentscope", create_app(...))
```

## Authentication — mandatory before any deployment

`X-User-ID` is a **placeholder with zero authentication**. hm-core already has
real identity; wire it in by overriding the dependency. The `user_id` returned
here is the tenant boundary for *every* resource in the service.

```python
from fastapi import Header, HTTPException, status
from agentscope.app.deps import get_current_user_id as default_dependency

async def get_current_user_id(
    authorization: str = Header(...),
) -> str:
    # hm-core: verify the session/JWT, then return the canonical org-scoped id.
    principal = await hm_verify(authorization.removeprefix("Bearer "))
    if principal is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED)
    return principal.user_id            # must be stable per user

app.dependency_overrides[default_dependency] = get_current_user_id
```

**Use the canonical hm-core user id**, not an email or display name — everything
persisted is keyed on it, and changing the scheme orphans existing records.

## WorkRun → session mapping

The service's flow is: create agent → create credential → create session →
chat → stream.

| Agent Service step | hm-core concept |
| --- | --- |
| `POST /agent` | an **employee** definition (name, system prompt, runtime config) |
| `POST /credential` | an org-scoped provider key (shareable via access policy) |
| `POST /sessions` | one **run** of an employee; store the returned id on the WorkRun |
| `POST /chat` | dispatch the WorkRun's input |
| `GET /sessions/{id}/stream` | events → hm-core event bus → UI/artifacts |

```python
# hm-core side
workrun = await create_workrun(org_id=..., employee_id=...)
session = await agentscope.post("/sessions", json={
    "agent_id": employee.agent_id,
    "config": {"model": {...}, "workspace_id": workrun.workspace_id},
})
await store.set_workrun_session(workrun.id, session["id"])
```

**`workspace_id` is minted at session creation and persisted.** Pass it
explicitly when a WorkRun must reuse an existing workspace (this is also how
team sub-agents share the leader's workspace).

## Event stream — the return path

`POST /chat` returns immediately with `{"status": "started"}`; **all output
arrives on the SSE stream**. This is the only correct way to consume agent
output — do not poll messages as a substitute.

```bash
curl -N -H "X-User-ID: alice" \
  "http://localhost:8000/sessions/<session-id>/stream?agent_id=<agent-id>"
```

Properties that matter for integration:

- The stream **replays buffered history** to late joiners, then serves live events.
  A reconnecting client does not lose output — so hm-core can attach late.
- **Multiple subscribers** are supported (fan-out). hm-core can tail the stream
  while the web UI also watches it.
- Scheduled fires, team messages, and background-tool completions arrive on the
  **same** stream. One subscription covers every source of output.

**Single run per session:** a second `POST /chat` on a live session returns
**409**. Serialize per session (or per WorkRun) in hm-core.

Interface with the frontend protocol: if the SINGULANCE UI does not speak native
`AgentEvent`, install a protocol middleware rather than transforming events in
hm-core — `extra_middlewares=[Middleware(AGUIProtocolMiddleware)]`, or subclass
`ProtocolMiddlewareBase` and implement `_convert_to_protocol`.

## Injecting hm-core capabilities as tools

`extra_agent_tools` is the hook for HIVE-MIND Meta Tools — it runs once per agent
assembly, so tools can vary per tenant.

```python
async def hivemind_tools(user_id, agent_id, session_id):
    return [RecallTool(user_id), SaveMemoryTool(user_id), ConnectorTool(user_id)]

app = create_app(
    ...,
    extra_agent_tools=hivemind_tools,
)
```

Returned tools merge into the toolkit's `"basic"` group. **Enforce tenant
scoping inside each tool** — the factory receives `user_id`, but nothing else
stops a tool from reading another tenant's memory.

`extra_agent_middlewares` is the equivalent hook for audit logging, tenant
isolation, and cost accounting. It receives `(user_id, agent_id, session_id[,
workspace])` and its middlewares are appended to the framework's own
(`InboxMiddleware`, `ToolOffloadMiddleware`, `StateChangeMiddleware`).

> Do **not** build a second context-injection path. `InboxMiddleware` is the sole
> owner of hint injection; anything you push directly into context will race with it.

## Schedules and background work

Schedules create their own session (stateful or stateless) and fire on cron — no
`/chat` call needed. This is how recurring employee work runs without hm-core
driving it.

```http
POST /schedule
```

Long tool calls **auto-offload** to a background watcher when they exceed their
timeout; the result wakes the session through the bus. You get this for free —
do not build a job queue for it.

## Deployment topology (multi-process = the important part)

All shared state is in Redis, so multiple worker processes or nodes serve one
logical service. Three settings decide whether that works:

| Setting | Rule | Consequence if wrong |
| --- | --- | --- |
| `enable_scheduler` | **exactly one** process `True` | APScheduler's jobstore is in memory → a cron fires once **per replica** |
| `enable_channel_worker` | **exactly one** process `True` | A platform gives one bot's events to one connection → wasted connections or **duplicate messages** |
| `download_secret` | set explicitly behind an LB | Per-process default → tokens minted by one replica are **rejected by the next** → random download failures |
| `enable_index_worker` | `True` only for embedded | Dedicated deployment expects a separate worker on the bus |

Storage can be `RedisStorage` (default) or `AsyncSQLAlchemyStorage` for Postgres
— note the bus stays Redis either way. For multi-replica Postgres, keep
`auto_migrate=False` and run `alembic upgrade head` as a discrete deploy step;
two replicas racing a migration is unsafe.

## Checklist before calling the integration done

- [ ] `verify_api_surface.py` passes against the deployed version.
- [ ] `X-User-ID` replaced with real hm-core auth; no placeholder left.
- [ ] `/chat` 409 handled — per-session serialization implemented in hm-core.
- [ ] SSE stream consumed (not polling); reconnect tested (history replay).
- [ ] `user_id` is the canonical hm-core id; tenant scoping enforced **inside** every custom tool.
- [ ] Exactly one replica has `enable_scheduler=True`; one has `enable_channel_worker=True`.
- [ ] `download_secret` set from config, not left default.
- [ ] Verified by a real run: dispatch a WorkRun, see events on the stream, confirm the artifact lands.

## See also

- `CONTRACT.md` — authoritative symbols, signatures, REST surface, invariants.
- `../agentscope-workspace-sandbox/SKILL.md` — where the agent's tools actually execute.
- `../agentscope-agent-team/SKILL.md` — delegating one WorkRun across many agents.
- `../agentscope-hubs/SKILL.md` — connector/MCP and skill distribution.
