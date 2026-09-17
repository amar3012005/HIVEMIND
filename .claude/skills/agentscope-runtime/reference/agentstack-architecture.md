# HIVEMIND AgentStack architecture — target topology & build order

The agreed target. Build on AgentScope **core features**; do not rebuild what the
runtime already ships.

```
SINGULANCE  ── Web · Desktop · Mobile
        │  command / event API
        ▼
┌───────────────────────────────────────────────────────────────┐
│ hm-core                                                       │
│ identity · org/tenancy · employees · Hive Mind · policy ·     │
│ approvals · billing · connectors · artifacts · WorkRuns       │
└───────────────────────────┬───────────────────────────────────┘
                            │ WorkRun
                            ▼
┌───────────────────────────────────────────────────────────────┐
│ AgentScope Agent Service (2.0.8)                              │
│ sessions · schedules · background jobs · resume · reasoning · │
│ delegation · agent teams                                      │
└───────────────────────────┬───────────────────────────────────┘
                            │ capability runtime
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
  HIVE-MIND           Connectors            Workspace / Sandbox
  Meta Tools          / MCP                 E2B · Docker · K8s ·
  (memory, recall,    (per-workspace        Apple Container
   save, why_code)     MCP clients)               │
                                            shell · filesystem · browser ·
                                            desktop · Python/Node ·
                                            long-running processes
                            │
                            ▼
                   Artifact layer
        HTML · PDF · Images · Video
                            │
                            ▼
                       HIVE-MIND
```

## Layer responsibilities

### hm-core — control plane

Owns everything organization-shaped. **Does not host agents.**

- identity, org/tenancy (the `user_id` that becomes AgentScope's tenant boundary)
- employees roster — the durable definition of who works
- Hive Mind memory (semantic company memory)
- policy, approvals, authority gates
- billing, entitlements (feeds hub visibility)
- connectors registry
- artifacts registry (pointers to workspace-produced files)
- **WorkRun** — the unit of work handed to the runtime

### AgentScope Agent Service — execution plane

Owns everything run-shaped. **Knows nothing about orgs, policy, or billing.**

- sessions (the unit of runtime state), agents (reusable templates)
- schedules, background jobs, resume
- reasoning loop, delegation, agent teams
- workspace lifecycle, MCP clients, skills

### Capability runtime

What the agent can actually *do*:

- **HIVE-MIND Meta Tools** — injected via `extra_agent_tools`; tenant-scoped per `user_id`
- **Connectors / MCP** — installed via hubs, equipped per workspace
- **Workspace / sandbox** — where shell/filesystem/browser/code execute

### Artifact layer

Agent output becomes durable objects (HTML, PDF, images, video). **The workspace
owns the bytes; HIVE-MIND owns the pointer.**

## The seam

| Direction | Contract |
| --- | --- |
| hm-core → runtime | a `WorkRun` resolves to `(user_id, agent_id, session_id, workspace_id)` |
| runtime → hm-core | `AgentEvent`s on the SSE stream, plus artifacts registered on disk |

**Violations to reject in review:**

- org/policy/billing logic inside an AgentScope agent or middleware → wrong layer
- session/scheduler/team state persisted in hm-core → wrong layer
- a second context-injection path alongside `InboxMiddleware` → duplicate/racing
- a hand-rolled scheduler, session store, team router, sandbox pool, or MCP loader → core feature already exists

## Build order

Phase 0 is mandatory; each later phase assumes every earlier one is verified.

| Phase | Deliverable | Skill | Verification |
| --- | --- | --- | --- |
| **0** | Local instance running | agentscope-runtime | `verify_api_surface.py` passes; service answers on `:8000` |
| **1** | Service shell: `create_app` + storage + bus + workspace manager | agentscope-agent-service | a chat run streams events |
| **2** | Sandbox backend chosen for the target environment | agentscope-workspace-sandbox | agent writes a file; it appears on the workspace FS |
| **3** | Capability runtime: meta tools + connectors | agentscope-hubs | agent calls a meta tool and an equipped MCP |
| **4** | Employee roles + delegation | agentscope-agent-team | workers behave differently per `subagent_type` |
| **5** | hm-core integration | agentscope-agent-service | real auth; WorkRun dispatches; events reach hm-core |
| **6** | Artifact pipeline | agentscope-workspace-sandbox | HTML/PDF/image registered into HIVE-MIND |

**Do not start a later phase to compensate for an unverified earlier one.**
Prose is never completion evidence — a passing check, a streamed event, and a file
on disk are.

## Environment realities on the authoring machine (verified 2026-09-17)

Recorded because they shape Phase 0 and are easy to lose time to:

| Fact | Detail |
| --- | --- |
| Repo already cloned | `~/agentscope`, branch `main`, includes `examples/agent_service` and `examples/web_ui` |
| Redis | installed and running (`redis-cli ping` → `PONG`) |
| Python | `3.14.3` is the system default — **use 3.12 in a venv** for wheel availability |
| `uv` | available at `~/.local/bin/uv` |
| Node | `v22.23.0`; `pnpm` available |
| System Python broken for numpy | the global interpreter raises `Error importing numpy: you should not try to import numpy from its source directory`. **Harmless if you use a venv** — this is why `verify_api_surface.py` works statically instead of importing. |

### Phase 0 commands

```bash
cd ~/agentscope
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e ".[full]"

redis-cli ping                                   # → PONG
cd examples/agent_service && python main.py      # :8000

# prove the surface before building on it
python ~/HIVE-MIND-singulance-production-current/.claude/skills/agentscope-runtime/verify_api_surface.py
```

Frontend, in a second terminal:

```bash
cd ~/agentscope/examples/web_ui && pnpm install && pnpm dev   # :5173
```

## Generality contract (applies to all of this)

The runtime must stay domain-agnostic:

- **Forbidden** in engine/control-plane code: branching on company/industry/vertical/language, string matching on task content, hard-coded stage/artifact/channel names, hard-coded thresholds.
- **Required**: domain knowledge lives in versioned playbook **data**; the engine reads stages and predicates from the playbook and does not know what they mean.
- **Swap test**: replace the company profile and playbooks with a different business (e.g. a bakery running order-management playbooks). The engine must run **unmodified**. Any code change needed is a contract violation.

A "researcher"/"writer" sub-agent template is **runtime configuration**, which is
fine. A code path that says `if role == "researcher": …` is a violation — the
role's behaviour must come from its template data.
