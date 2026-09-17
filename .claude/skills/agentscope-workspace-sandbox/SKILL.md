---
name: agentscope-workspace-sandbox
description: "Choose, configure, and operate the AgentScope workspace/sandbox backend for HIVEMIND Digital Employees — Local, Apple Container, Docker, Bubblewrap, E2B, Daytona, OpenSandbox, or Kubernetes — including the isolation grain (per_agent/per_session/per_user), E2B template + API key setup, long-running processes, and the artifact layer (HTML/PDF/Images/Video) written into the workspace and registered back into HIVE-MIND. Invoke BEFORE choosing a sandbox backend or writing any sandbox/artifact code."
---

# Workspace & sandbox — where the capability runtime executes

A **workspace** is the agent's runtime environment: working directory, MCP
clients, skills, offloaded context. Its manager decides (a) *which* workspace a
request belongs to, and (b) *how* it is provisioned.

**Announce:** "Using agentscope-workspace-sandbox."

Load `.claude/skills/agentscope-runtime/CONTRACT.md` and
`references/WORKSPACE_SANDBOX_CONTRACT.md` first.

## Two independent axes

**1. Backend** — where the tools actually run.

| Manager | Backend | Distribution | Use when |
| --- | --- | --- | --- |
| `LocalWorkspaceManager` | host directory, **no sandbox** | single | local dev only |
| `AppleContainerWorkspaceManager` | Apple Container | single | **macOS** dev/single box |
| `BubblewrapWorkspaceManager` | `bwrap` | single | Linux single box, minimal infra |
| `DockerWorkspaceManager` | container per workspace | single | Linux single box, real isolation |
| `E2BWorkspaceManager` | E2B cloud sandbox | **distributed** | production, scale-out |
| `DaytonaWorkspaceManager` | Daytona cloud sandbox | **distributed** | production alt |
| `OpenSandboxWorkspaceManager` | OpenSandbox | **distributed** | self-hosted sandboxes |
| `K8sWorkspaceManager` | Pod + PVC | **distributed** | existing k8s cluster |

> **Distribution is the deciding factor.** `Local`, `Bubblewrap`,
> `AppleContainer`, and `Docker` keep workspace state **on the host running the
> service process**. Behind a load balancer, a request for the same
> `workspace_id` can land on a node that cannot reach it. Pick a cloud-managed
> or cluster backend before scaling beyond one node.

**2. Isolation grain** — how workspaces are shared across `(user_id, agent_id, session_id)`.

```python
from agentscope.app.workspace_manager import IsolationPolicy

IsolationPolicy.PER_AGENT    # "per_agent"  — default; sessions of one agent share a workspace
IsolationPolicy.PER_SESSION  # "per_session"
IsolationPolicy.PER_USER     # "per_user"
```

Values are **lowercase strings** (it is a `StrEnum`) — relevant when the value
comes from config or an env var.

Isolation changes sharing of the *working directory*. It does **not** disable
intra-workspace isolation: MCP clients stay separate per
`agent_id + session_id`, skills stay private per `agent_id`.

> **`workspace_id` is minted once at session creation and persisted.** Changing
> the policy does **not** re-partition existing sessions; only new sessions pick
> it up. Plan the grain before the first production run.

## Choosing, per environment

**Local dev / macOS** — no sandbox, fastest loop:

```python
from agentscope.app.workspace_manager import LocalWorkspaceManager
workspace_manager = LocalWorkspaceManager(basedir="/data/workspaces")
```

**Single production box (Linux)** — real isolation without cloud:

```python
from agentscope.app.workspace_manager import DockerWorkspaceManager, IsolationPolicy

workspace_manager = DockerWorkspaceManager(
    basedir="/data/workspaces",          # bind-mounted to /workspace in the container
    isolation=IsolationPolicy.PER_AGENT,
    base_image="python:3.11-slim",       # must ship python3
    node_version="20",                   # needed by npx-based MCPs
    ttl=3600.0,                          # idle eviction
)
```

**Scale-out (production)** — E2B, the managed-cloud path:

```python
from agentscope.app.workspace_manager import E2BWorkspaceManager, IsolationPolicy

workspace_manager = E2BWorkspaceManager(
    isolation=IsolationPolicy.PER_AGENT,
    template="base",            # E2B template that ships the required runtime
    api_key="",                 # "" falls back to the E2B_API_KEY env var
    timeout_seconds=300,        # sandbox keep-alive on the E2B side
    ttl=3600.0,
)
```

**Never hardcode the E2B key.** Leave `api_key=""` and inject `E2B_API_KEY` from
the environment/secret store so it is not committed and can be rotated.

Cloud backends auto-suspend idle sandboxes and **reattach on cache miss** by
metadata (E2B metadata, Daytona label, OpenSandbox tag). That is what makes
per-request reattachment work across replicas — do not build your own
sandbox registry on top.

## What the sandbox must provide

The capability runtime expects the sandbox to support the operations the agent
tools depend on:

| Capability | Notes |
| --- | --- |
| shell | long-running processes must survive between turns |
| filesystem | persistence across the `ttl` window; check your `basedir` volume |
| browser | `npx @playwright/mcp@latest` needs `node_version` in the image |
| desktop / code | only where the backend supports it |
| Python / Node | the image must ship the runtime the MCPs need |

**`ttl` is a data-loss risk, not just a memory knob.** `3600.0` means an idle
workspace is torn down after an hour. For a backend without persistent storage
(`E2B` with the default template, `Docker` without a volume), anything not
written out **before eviction is gone**. Set `ttl` deliberately and treat the
workspace as scratch unless you have verified persistence.

## The artifact layer

Artifacts are produced **inside the workspace**; HIVE-MIND is the system of
record. The flow is: generate → land on the workspace FS → register the pointer
back into HIVE-MIND.

```
HTML · PDF · Images · Video
        │  written by agent tools into the workspace
        ▼
workspace filesystem  ──►  hm-core artifact registry (pointer + metadata)
                                   │
                                   ▼
                            HIVE-MIND memory
```

Rules that make this reliable:

- **Register an artifact only after the file is flushed and non-zero.** A prose
  claim is never evidence; the file on disk is.
- **Store a pointer, not the bytes, in memory** — the workspace owns the bytes.
  Record workspace id + relative path + content type + size.
- **Download links are signed by `download_secret`.** Behind a load balancer this
  must be set explicitly or links fail at random across replicas.
- Large/binary outputs (video, PDF) belong in the artifact layer, **not** inline
  in the session transcript — the transcript is context, not storage.

## Custom backend

Only when no built-in manager fits. Subclass `WorkspaceManagerBase`; the
isolation logic in `assign_workspace_id` is inherited and driven by the
`isolation` constructor argument, so you implement provisioning + cache only.

```python
from agentscope.app.workspace_manager import WorkspaceManagerBase

class MyWorkspaceManager(WorkspaceManagerBase):
    async def get_workspace(self, user_id, agent_id, session_id, workspace_id):
        ...   # cache-hit path; acquire a lock on miss to avoid double-provisioning
    async def create_workspace(self, user_id, agent_id, session_id): ...
    async def close(self, workspace_id): ...
    async def close_all(self): ...          # called on shutdown
```

If you need idle eviction or long-running provisioning, override
`__aenter__`/`__aexit__` to own that machinery — that is how the built-ins do it.
The manager is an **async context manager**; the service enters it on startup and
calls `close_all()` on shutdown.

> `get_workspace` is on the hot request path. On a miss, acquire an
> `asyncio.Lock` before provisioning — otherwise concurrent requests for the same
> `workspace_id` race and spin up two backends.

## Checklist

- [ ] Backend matches the deployment: single-node managers are **not** behind a load balancer.
- [ ] Isolation grain chosen deliberately; documented, since existing sessions keep their id.
- [ ] `ttl` set with persistence in mind; no reliance on unpersisted workspace state.
- [ ] Cloud sandbox credentials (`E2B_API_KEY`, …) come from env, never hardcoded.
- [ ] Image ships the runtimes the MCPs need (`python3`, `node_version` for `npx` MCPs).
- [ ] Artifact registered only after the file is flushed and non-zero.
- [ ] `download_secret` set explicitly when running more than one replica.
- [ ] Verified by a real run: a file written by the agent is observed on the workspace FS.

## See also

- `references/WORKSPACE_SANDBOX_CONTRACT.md` — full manager/API/enum reference.
- `../agentscope-agent-service/SKILL.md` — the service that owns the manager.
- `../agentscope-hubs/SKILL.md` — what gets installed into a workspace.
