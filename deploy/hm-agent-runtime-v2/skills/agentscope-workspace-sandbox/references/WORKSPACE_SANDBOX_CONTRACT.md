# WORKSPACE_SANDBOX_CONTRACT

Source-verified reference for `agentscope.app.workspace_manager`.
Verify with `../../agentscope-runtime/verify_api_surface.py`.

## Exports

```python
from agentscope.app.workspace_manager import (
    # contract + policy
    WorkspaceManagerBase, IsolationPolicy, PrewarmConfig,
    # backends
    LocalWorkspaceManager, BubblewrapWorkspaceManager,
    AppleContainerWorkspaceManager, DockerWorkspaceManager,
    E2BWorkspaceManager, DaytonaWorkspaceManager,
    OpenSandboxWorkspaceManager, K8sWorkspaceManager,
)
```

## IsolationPolicy

`StrEnum` in `_base.py`. **Values are lowercase strings** — relevant when the
value arrives from config or an environment variable.

| Member | Value | Sharing rule |
| --- | --- | --- |
| `PER_AGENT` | `"per_agent"` | all sessions of `(user_id, agent_id)` share one workspace — **default** |
| `PER_SESSION` | `"per_session"` | every session gets its own workspace |
| `PER_USER` | `"per_user"` | all sessions of `user_id` share one workspace, regardless of agent |

Intra-workspace isolation is unaffected by the grain: **MCP clients stay separate
per `agent_id + session_id`; skills stay private per `agent_id`.**

## WorkspaceManagerBase contract

| Method | Purpose |
| --- | --- |
| `assign_workspace_id(*, user_id, agent_id, session_id) -> str` | mint an id for a fresh session under the configured policy. **Pure — no I/O, no cache lookup**, safe on the hot path. Inherited; you do not implement it. |
| `get_workspace(user_id, agent_id, session_id, workspace_id=None) -> WorkspaceBase` | resolve an initialized workspace. Cache-hit path. `workspace_id=None` falls back to `assign_workspace_id`. |
| `create_workspace(user_id, agent_id, session_id) -> WorkspaceBase` | provision a brand-new workspace when the caller has no persisted id. |
| `close(workspace_id) -> None` | evict one workspace and tear down its backend. |
| `close_all() -> None` | evict every cached workspace; called on app shutdown. |
| `async with manager:` | enter starts background machinery (sweeper); exit calls `close_all`. |

**An explicit `workspace_id` always overrides the policy.** This is the mechanism
the built-in team tools (`AgentCreate`, `AgentInvite`) use to make a sub-agent
session share the leader's workspace.

**`get_workspace` is the hot path.** Look up the id in the cache, refresh the
last-access timestamp, return in O(1). Acquire an `asyncio.Lock` **only on a
miss**, before provisioning — otherwise concurrent requests for the same id race
and provision two backends.

## Backends

### LocalWorkspaceManager

```python
LocalWorkspaceManager(
    basedir="/data/workspaces",        # per-agent workdirs at <basedir>/<user_id>/<agent_id>
    isolation=IsolationPolicy.PER_AGENT,
    ttl=3600.0,
)
```

Host filesystem, **no sandboxing**. Single-node. Dev only.

### BubblewrapWorkspaceManager

```python
BubblewrapWorkspaceManager(
    basedir="/data/workspaces",
    isolation=IsolationPolicy.PER_AGENT,
    gateway_port=None,          # None → each workspace picks an available loopback port
    extra_pip=[],               # extra requirements for the in-sandbox gateway venv
    ttl=3600.0,
    sweep_interval=...,         # idle sweeper cadence
)
```

Needs the `bwrap` binary on a **Linux** host. Workspace mounted at `/workspace`
inside the sandbox. Paths are `<basedir>/<hashed user_id>/<hashed workspace_id>`.
**Shares the host network namespace.**

### AppleContainerWorkspaceManager

Apple Container backend. **macOS**. Single-node. Present in source; not probed by
the verifier (it is listed as a warning, not an assertion) — confirm the runtime
is installed on the host before relying on it.

### DockerWorkspaceManager

```python
DockerWorkspaceManager(
    basedir="/data/workspaces",   # bind-mounted to /workspace in each container
    isolation=IsolationPolicy.PER_AGENT,
    base_image="python:3.11-slim",  # must ship python3
    node_version="20",              # required by npx-based MCPs
    ttl=3600.0,
)
```

One container per workspace; `basedir` bind-mounted for persistence. Requires a
reachable Docker daemon. The image is content-hashed and rebuilt only when the
Dockerfile inputs change. **Single-node** — host-local state.

### E2BWorkspaceManager

```python
E2BWorkspaceManager(
    isolation=IsolationPolicy.PER_AGENT,
    template="base",            # E2B template shipping the required runtime
    api_key="",                 # "" → falls back to E2B_API_KEY env var
    timeout_seconds=300,        # sandbox keep-alive on the E2B side
    ttl=3600.0,
)
```

Managed cloud sandboxes. **Distributed** — sandboxes are addressable by metadata,
so any replica reattaches on cache miss. Auto-suspend when idle, resume on next
access.

### DaytonaWorkspaceManager

```python
DaytonaWorkspaceManager(
    isolation=IsolationPolicy.PER_AGENT,
    api_key="",          # "" → Daytona SDK reads credentials from the environment
    api_url="",          # optional, self-hosted
    target="",           # optional region/target
    timeout_seconds=300,
    ttl=3600.0,
)
```

**Distributed.** Reattachment by the `agentscope.workspace.id` label;
`user_id`/`agent_id` forwarded as extra labels for dashboard filtering.

### OpenSandboxWorkspaceManager

```python
OpenSandboxWorkspaceManager(
    isolation=IsolationPolicy.PER_AGENT,
    image="python:3.11-slim",
    api_key="",          # "" → opensandbox SDK env-based config
    domain="",           # optional, self-hosted / on-prem
    protocol="http",
    timeout_seconds=300,
    ttl=3600.0,
)
```

**Distributed.** Reattach by filtering `list_sandbox_infos(...)` on the
`agentscope.workspace.id` metadata tag. Sandboxes carry their own filesystem across
pause/resume.

### K8sWorkspaceManager

```python
K8sWorkspaceManager(
    isolation=IsolationPolicy.PER_AGENT,
    namespace="agentscope",
    kubeconfig=None,          # None → in-cluster config
    image="python:3.11-slim",
    storage_size="1Gi",       # PVC backing the workspace filesystem
    ttl=3600.0,
)
```

One Pod + PVC per workspace. **Distributed** — cluster-scoped resources, so any
replica reattaches to the same Pod by workspace-id-derived name.

## Distribution matrix — the deciding factor

| Backend | Single-node | Distributed |
| --- | --- | --- |
| Local | ✅ | ❌ |
| Bubblewrap | ✅ | ❌ |
| Apple Container | ✅ | ❌ |
| Docker | ✅ | ❌ |
| E2B | — | ✅ |
| Daytona | — | ✅ |
| OpenSandbox | — | ✅ |
| K8s | — | ✅ |

Single-node managers hold workspace state **on the host running the service
process**. Behind a load balancer a request for the same `workspace_id` may land
on a node that cannot reach it.

## Eviction

Every manager caches workspaces and evicts them `ttl` seconds after last access
(default `3600.0`). `LocalWorkspaceManager` collects expired entries on the next
`get_workspace()` call. Sandbox-backed managers additionally run a background
sweeper (`sweep_interval`) so an idle container, sandbox, or Pod is released
without waiting for a request.

**`ttl` is a data-loss parameter, not only a memory knob.** For a backend without
persistent storage, unflushed state is gone on eviction.

## Lifecycle

The manager is an async context manager, entered by the service lifespan through
an `AsyncExitStack` alongside storage and the message bus. Enter starts
background machinery; exit calls `close_all()`.

**`workspace_id` is minted once at session creation and persisted.** Changing the
`isolation` policy on a running deployment does **not** re-partition existing
sessions — they keep the id they were assigned. Only new sessions pick up the
policy.

## Custom manager skeleton

```python
import asyncio, time
from agentscope.app.workspace_manager import IsolationPolicy, WorkspaceManagerBase
from agentscope.workspace import WorkspaceBase


class MyWorkspaceManager(WorkspaceManagerBase):
    def __init__(self, *, isolation=IsolationPolicy.PER_AGENT, ttl=3600.0) -> None:
        super().__init__(isolation=isolation)
        self._ttl = ttl
        self._cache: dict[str, tuple[WorkspaceBase, float]] = {}
        self._lock = asyncio.Lock()

    async def get_workspace(self, user_id, agent_id, session_id, workspace_id=None):
        if workspace_id is None:
            workspace_id = self.assign_workspace_id(
                user_id=user_id, agent_id=agent_id, session_id=session_id,
            )
        async with self._lock:
            hit = self._cache.get(workspace_id)
            if hit is not None:
                ws, _ = hit
                self._cache[workspace_id] = (ws, time.monotonic())
                return ws
            ws = MyWorkspace(workspace_id=workspace_id)
            await ws.initialize()
            self._cache[workspace_id] = (ws, time.monotonic())
            return ws

    async def create_workspace(self, user_id, agent_id, session_id): ...
    async def close(self, workspace_id): ...
    async def close_all(self): ...
```

Override `__aenter__`/`__aexit__` if you need a sweeper or long-running
provisioning.
