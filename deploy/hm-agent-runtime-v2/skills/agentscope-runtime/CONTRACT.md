# AgentScope 2.0.8 — authoritative API contract

**Verified against source**, not documentation. Source root: `~/agentscope/src/agentscope/`.
Verification command: `python .claude/skills/agentscope-runtime/verify_api_surface.py`.

Pinned version: **2.0.8**. Never mix 1.x and 2.x. Never follow `/latest/` docs
against this source.

> **Rule:** if a symbol is not in this file, do not invent it — read the source.
> Two documented names are wrong (§7). A wrong kwarg is swallowed by `**kwargs`
> and fails **silently**.

---

## 1. Entry point

```python
from agentscope.app import create_app, SubAgentTemplate
```

> **`create_app` is exported by `agentscope.app`, NOT by the top-level
> `agentscope` package.** `from agentscope import create_app` fails —
> `agentscope/__init__.py` exports only `logger`, `setup_logger`,
> `set_id_factory`, `set_timestamp_factory`, `__version__`. Verified against
> source; the verifier asserts this so the mistake cannot recur.

`create_app` — module `agentscope/app/_app.py`. Signature:

```python
def create_app(
    storage: StorageBase,
    message_bus: MessageBus,
    workspace_manager: WorkspaceManagerBase,
    knowledge_base_manager: KnowledgeBaseManagerBase | None = None,
    knowledge_parsers: list[ParserBase] | dict[str, ParserBase] | None = None,
    knowledge_chunkers: list[Type[ChunkerBase]] | None = None,
    blob_store: BlobStoreBase | None = None,
    enable_index_worker: bool = True,
    mcp_hubs: list[MCPHubBase] | None = None,
    skill_hubs: list[SkillHubBase] | None = None,
    *,
    enable_channel_worker: bool = True,
    enable_scheduler: bool = True,
    extra_credentials: list[Type[CredentialBase]] | None = None,
    extra_middlewares: list[FastAPIMiddleware] | None = None,
    extra_agent_middlewares: AgentMiddlewareFactory | None = None,
    extra_agent_tools: AgentToolFactory | None = None,
    custom_subagent_templates: list[SubAgentTemplate] | None = None,
    custom_agent_cls: Type[Agent] | None = None,
    resource_access_policy: ResourceAccessPolicyBase | None = None,
    channels: list[Type[ChannelBase]] | None = None,
    download_secret: str | None = None,
    title: str = "AgentScope",
    version: str = __version__,
    **kwargs: Any,
) -> FastAPI
```

**The three required positional args are `storage`, `message_bus`,
`workspace_manager`.** A service will not start without all three.

`**kwargs` is why a misspelled keyword fails silently. Always verify.

---

## 2. Storage — `agentscope.app.storage`

```python
from agentscope.app.storage import RedisStorage, AsyncSQLAlchemyStorage, StorageBase
```

| Symbol | Notes |
| --- | --- |
| `StorageBase` | Abstract contract. Implement for a bespoke backend. |
| `RedisStorage` | Default. `RedisStorage(host=…, port=…, db=…, password=…)`. |
| `AsyncSQLAlchemyStorage` | Lazily exported via module `__getattr__`; needs the `sql` extra **plus** an async driver (`asyncpg` for Postgres). |

Records managed: `AgentRecord`, `SessionRecord`, `CredentialRecord`,
`ScheduleRecord`, `TeamRecord`, `KnowledgeBaseRecord`,
`KnowledgeDocumentRecord`, `Msg`.

**Redis is a hard dependency of the service, not just of storage.** The message
bus is Redis-backed in the default deployment.

---

## 3. Message bus — `agentscope.app.message_bus`

```python
from agentscope.app.message_bus import RedisMessageBus, InMemoryMessageBus, MessageBus
```

| Symbol | Notes |
| --- | --- |
| `MessageBus` | Abstract. |
| `RedisMessageBus` | Required for multi-process / production. `RedisMessageBus(host=…, port=…)`. |
| `InMemoryMessageBus` | Single-process only (dev, tests). |

The bus is the **single delivery channel** for scheduled fires, team messages,
and background-tool completions. It is deliberately separable from storage so
the persistence backend (SQL) can differ from the transport (Redis).

---

## 4. Workspace managers — `agentscope.app.workspace_manager`

```python
from agentscope.app.workspace_manager import (
    WorkspaceManagerBase, IsolationPolicy, PrewarmConfig,
    LocalWorkspaceManager, DockerWorkspaceManager, E2BWorkspaceManager,
    DaytonaWorkspaceManager, K8sWorkspaceManager,
    OpenSandboxWorkspaceManager, BubblewrapWorkspaceManager,
    AppleContainerWorkspaceManager,
)
```

| Manager | Backend | Distribution |
| --- | --- | --- |
| `LocalWorkspaceManager` | host directory, **no sandbox** | single-node |
| `BubblewrapWorkspaceManager` | `bwrap` sandbox (Linux) | single-node |
| `AppleContainerWorkspaceManager` | Apple Container | single-node, **macOS** |
| `DockerWorkspaceManager` | one container per workspace | single-node |
| `E2BWorkspaceManager` | E2B cloud sandbox | **distributed** |
| `DaytonaWorkspaceManager` | Daytona cloud sandbox | **distributed** |
| `OpenSandboxWorkspaceManager` | OpenSandbox | **distributed** |
| `K8sWorkspaceManager` | Pod + PVC | **distributed** |

`IsolationPolicy` (a `StrEnum`, `_base.py`) — **values are lowercase strings**:

```python
class IsolationPolicy(StrEnum):
    PER_SESSION = "per_session"
    PER_AGENT   = "per_agent"     # default
    PER_USER    = "per_user"
```

Isolation decides sharing of the `(user_id, agent_id, session_id)` triple.
MCP clients stay isolated per `agent_id + session_id`; skills per `agent_id` —
regardless of the grain.

**`workspace_id` is minted once at session creation and persisted.** Changing the
isolation policy does *not* re-partition existing sessions.

Managers with a background sweeper (`Docker`, `E2B`, `Daytona`, `OpenSandbox`,
`K8s`, `Bubblewrap`) evict idle workspaces after `ttl` (default `3600.0`).

---

## 5. Access policy (sharing) — `agentscope.app.access`

```python
from agentscope.app.access import (
    ResourceAccessPolicyBase, ResourceKind, ResourcePermission,
    ResourceRef, DenyAllResourceAccessPolicy,
)
```

`ResourceKind` (`StrEnum`): `CREDENTIAL="credential"`, `AGENT="agent"`,
`KNOWLEDGE_BASE="knowledge_base"`.

`ResourcePermission` (`StrEnum`): `READ="read"`, `EDIT="edit"` (EDIT implies READ).

`ResourceRef`: `(kind, owner_id, resource_id, permission)`.

Default is `DenyAllResourceAccessPolicy` — strictly owner-isolated. Pass
`resource_access_policy=` to `create_app` to enable sharing.

**Shared credentials are masked in every list/get response.** The secret resolves
only inside trusted runtime paths. Never add an endpoint that echoes a resolved
credential. Apply the same access filter in `get_*` as in `list_*` — hiding a
card from a listing alone is not access control.

---

## 6. Middleware — `agentscope.app.middleware`

```python
from agentscope.app.middleware import (
    InboxMiddleware, ToolOffloadMiddleware, StateChangeMiddleware,
    ProtocolMiddlewareBase, AGUIProtocolMiddleware,
)
```

The framework always installs `InboxMiddleware`, `ToolOffloadMiddleware`,
`StateChangeMiddleware`. Add your own via `extra_agent_middlewares`
(async factory `(user_id, agent_id, session_id[, workspace]) -> list[MiddlewareBase]`).
ASGI-level middleware (protocol/observability) goes in `extra_middlewares`.

**`InboxMiddleware` is the sole owner of hint injection** — scheduled fires,
team messages, and offloaded-tool results all reach the model through it. Do not
build a second injection path.

---

## 7. ⚠ Known doc-vs-source drift

| Public doc | Source | Failure mode |
| --- | --- | --- |
| `sub_agent_templates=` | **`custom_subagent_templates=`** | Swallowed by `**kwargs` → templates never register → `AgentCreate` never exposes `subagent_type`. **Silent.** |

There is no `sub_agent_templates` parameter anywhere in the source. Grep for it
to confirm:

```bash
grep -rn "sub_agent_templates" ~/agentscope/src/agentscope/   # → no matches
grep -rn "custom_subagent_templates" ~/agentscope/src/agentscope/   # → matches
```

---

## 8. Hubs — `agentscope.app.hub`

```python
from agentscope.app.hub import (
    HubBase, HubError,
    MCPHubBase, MCPCard, MCPHubPage, GitHubMCPHub,
    SkillHubBase, SkillCard, SkillHubPage, SkillArchive, ClawSkillHub,
)
```

Pass `mcp_hubs=[…]` / `skill_hubs=[…]` to `create_app` to enable the marketplace
routes + install flow. Duplicate `hub_id` **fails at startup** (good — no silent
shadowing).

Custom hub contract:

- `MCPHubBase`: `list_mcps(user_id, q, cursor, limit) -> MCPHubPage`, `get_mcp(user_id, card_id) -> MCPCard`. Raise `KeyError` for unknown → service answers 404.
- `SkillHubBase`: `list_skills(…) -> SkillHubPage`, `get_skill(…) -> SkillCard`, `download(…) -> SkillArchive`. Raise `KeyError` for unknown.
- Both may implement `__aenter__`/`__aexit__` to hold a shared HTTP client.
- **Install ≠ equip.** Install adds to the user's pool; equipping unpacks into an agent's workspace.

MCP card inputs use `${placeholder}` in any string (URL, header, env, arg) +
a JSON Schema in `inputs_schema` for form rendering. **Every credential field
must be `"writeOnly": true, "format": "password"`.**

---

## 9. Dependencies — `agentscope.app.deps`

```
get_current_user_id, get_storage, get_message_bus, get_chat_service,
get_resource_access_service, get_session_service, get_workspace_service,
get_chat_run_registry, get_scheduler_manager, get_background_task_manager,
get_workspace_manager, get_download_secret, get_extra_agent_middlewares,
get_extra_agent_tools, get_knowledge_base_service, get_knowledge_base_manager,
get_blob_store, get_knowledge_parsers, get_knowledge_chunkers,
get_mcp_hubs, get_skill_hubs, get_channel_service,
get_credential_binding_service, get_channel_clients, get_channel_type_registry
```

Override authentication by rebinding the dependency:

```python
from agentscope.app.deps import get_current_user_id as default_dependency
app.dependency_overrides[default_dependency] = my_get_current_user_id
```

`get_current_user_id` reads the `X-User-ID` header — **a placeholder with zero
authentication**. Always replace before deploying.

---

## 10. Permission — `agentscope.permission`

```python
from agentscope.permission import PermissionContext, PermissionMode
```

Used by `SubAgentTemplate(permission_context=PermissionContext(mode=PermissionMode.EXPLORE))`
for read-only workers.

---

## 11. Knowledge base / RAG

```python
from agentscope.app.rag.knowledge_base_manager import CollectionPerKbManager
from agentscope.rag import ApproxTokenChunker, QdrantStore
```

Passing `knowledge_base_manager` to `create_app` enables every
`/knowledge_bases` endpoint. `None` disables them (they then return 503).
`blob_store` is required when the KB feature is on (defaults to `LocalBlobStore`).

---

## 12. REST surface (for integration work)

| Category | Endpoints |
| --- | --- |
| Chat | `POST /chat` |
| Stream | `GET /sessions/{id}/stream` (SSE) |
| Session control | `POST /sessions/{id}/interrupt`, `GET /sessions/{id}/status` |
| Sessions | `GET/POST/PATCH/DELETE /sessions` |
| Messages | `GET /sessions/{id}/messages` |
| Agents | `GET/POST/PATCH/DELETE /agent`, `GET /agent/schema/v2` |
| Credentials | `GET/POST/PATCH/DELETE /credential`, `GET /credential/schemas` |
| Models | `GET /model?provider=<name>`, `GET /tts-model?provider=<name>` |
| Schedules | `GET/POST/PATCH/DELETE /schedule`, `GET /schedule/{id}/sessions` |
| Workspace MCP | `GET/POST /workspace/mcp`, `DELETE /workspace/mcp/{mcp_name}` |
| Workspace skills | `GET/POST /workspace/skill`, `DELETE /workspace/skill/{skill_name}` |
| Knowledge bases | `GET/POST/PATCH/DELETE /knowledge_bases` + documents + search + discovery |

`POST /chat` returns `{"status": "started", …}` immediately; events arrive
out-of-band on the SSE stream. A double submit on a live session returns **409**
(single-run-per-session, enforced per-process by `ChatRunRegistry`).

---

## 13. Operational invariants

| Invariant | Why |
| --- | --- |
| `enable_scheduler=True` on **exactly one** process | APScheduler's jobstore is in memory → every process fires every tick → a cron runs once per replica. |
| `enable_channel_worker=True` on **exactly one** process | A platform gives one bot's events to one connection → every replica connecting wastes connections or duplicates messages. |
| Set `download_secret` behind a load balancer | Default is per-process → a token minted by one replica is rejected by the next → random download failures. |
| `enable_index_worker=True` only in embedded deployment | Dedicated deployment expects a separate worker consuming from the bus. |
| `AsyncSQLAlchemyStorage(auto_migrate=True)` is **not** for multi-replica | Two replicas racing a migration is unsafe. Run `alembic upgrade head` as a deploy step. |
| Replace `X-User-ID` | It is not authentication. |

---

## 14. Version policy

- State **2.0.8** in every install command and code sample.
- `uv pip install "agentscope[full]"` (PyPI) or `uv pip install -e ".[full]"` (source).
- Requires **Python ≥ 3.11**. Prefer 3.12 for wheel availability; avoid 3.14
  until the dependency set catches up.
- `/latest/` docs track development — do not mix them with a pinned 2.0.8 install.
