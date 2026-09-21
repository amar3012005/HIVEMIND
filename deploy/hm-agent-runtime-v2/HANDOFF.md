# hm-agent-runtime-v2 — WorkRun seam: what was built, what is native, what is patchwork

**Branch:** `codex/agentscope-runtime-local`
**Target:** `origin/singulance-local`
**Date:** 2026-09-17
**AgentScope version:** 2.0.8 (`agentscope[service,storage-redis,tools,workspace-e2b]==2.0.8`)

This document is the authoritative handoff. Every claim below was verified against
the **installed** AgentScope source inside the running container, not against the
public docs. Where the docs and the source disagree, the source wins and the
disagreement is recorded.

---

## 1. What this service is

`hm-agent-runtime-v2` is the **AgentScope Agent Service** (`agentscope.app.create_app`)
hosting HIVEMIND Digital Employees. hm-core (Node/Express) is the control plane; this
service is the execution substrate.

The seam between them is the **WorkRun**:

```
hm-core                          hm-agent-runtime-v2
───────                          ───────────────────
POST /v1/workruns
  └─ dispatchWorkRun()
       ├─ create HyperTurn          (identity contract)
       ├─ insert work_runs row      (durable record)
       └─ POST /workrun/ ─────────► create_workrun_session()
                                      ├─ resolve agent record
                                      ├─ ensure model credential
                                      ├─ create_session (native)
                                      ├─ set BYPASS permission
                                      ├─ bind workspace workrun:<uuid>
                                      └─ start SSE forwarder
                                          ├─ POST /internal/workruns/:id/event
                                          └─ POST /internal/hyper/turn-event
       ◄──── SSE /v1/workruns/:id/stream (polls work_runs row)
```

---

## 2. Native AgentScope features — USED (not reimplemented)

These are the framework's own features, wired through their documented extension
points. **No parallel implementation exists.**

| Capability | Native API | Where wired | Notes |
|---|---|---|---|
| **Agent Service host** | `agentscope.app.create_app()` | `app.py:270` | FastAPI app, routers, SSE, storage, message bus — all framework-owned |
| **Multi-tenant storage** | `RedisStorage` | `app.py` | Sessions, agents, credentials, teams keyed by `user_id` |
| **Message bus / SSE** | `RedisMessageBus` | `app.py` | Event fan-out to SSE subscribers |
| **Session lifecycle** | `agentscope.app._router._session.create_session` | `app.py:800` | Called directly (not reimplemented) so every invariant stays in one place |
| **Chat dispatch** | `agentscope.app._router._chat.chat` | `app.py:645` | Called directly; returns `{"status":"started"}`, output on SSE |
| **Agent records** | `agentscope.app._router._agent.create_agent` | `app.py:476` | One agent record per employee slug, reused across runs |
| **Credential store** | `storage.upsert_credential` / `list_credentials` | `app.py:516` | Native credential persistence |
| **Custom credential type** | `CredentialBase.get_chat_model_class()` | `gateway_credential.py` | The documented extension point for a custom provider |
| **Tool injection** | `create_app(extra_agent_tools=...)` | `app.py:288` | `AgentToolFactory = (user_id, agent_id, session_id) -> list[ToolBase]` |
| **Tool base contract** | `agentscope.tool.ToolBase` | `extra_agent_tools.py:154` | Override `call`, declare `input_schema`, implement `check_permissions` |
| **Sub-agent templates** | `create_app(custom_subagent_templates=...)` | `app.py:281` | 4 employee roles |
| **Team tools** | `TeamCreate` / `AgentCreate` / `TeamSay` / `TeamDelete` / `AgentInvite` | framework-owned | Auto-attached by `get_toolkit`; **not** reimplemented |
| **Workspace manager** | `LocalWorkspaceManager` (+ 7 other backends) | `workspace_backend.py:91` | Backend is a config choice, not a fork |
| **Isolation policy** | `IsolationPolicy` (`per_agent`/`per_session`/`per_user`) | `workspace_backend.py` | `per_session` for WorkRuns |
| **Permission model** | `PermissionContext` / `PermissionMode` | `app.py` (post-create) | Native modes: `DEFAULT`, `ACCEPT_EDITS`, `EXPLORE`, `BYPASS`, `DONT_ASK` |
| **Planning tools** | `TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` | framework-owned | Auto-attached |
| **Schedule tools** | `ScheduleCreate` / `ScheduleView` / `ScheduleDelete` / `ScheduleList` | framework-owned | Auto-attached when a model is configured |
| **Workspace builtins** | `Bash` / `Read` / `Write` / `Grep` / `Glob` | framework-owned | Auto-attached |
| **MCP + Skill hubs** | `GitHubMCPHub` / `ClawSkillHub` | `app.py:293` | Opt-in via `ENABLE_HUBS` |
| **Context compression** | `ContextConfig` | framework-owned | Auto-applied |
| **Model cards** | `ChatModelBase.list_models()` | `model_cards/` | Shipped as data |

---

## 3. Patchwork — code written because AgentScope 2.0.8 has no extension point

Each entry states **why the native path was insufficient**. These are the honest
gaps, not preferences.

### 3.1 `hm_auth.py` — identity (REPLACES a placeholder)

**Native:** AgentScope's Agent Service ships an `X-User-ID` header stub. It is
**not authentication** — any caller can set it and impersonate any user. The
service was bound to `127.0.0.1` only because of this.

**Patchwork:** `hm_auth.py` mirrors hm-core's internal-auth contract
(`core/src/security/internal-auth.js`). Two accepted shapes:
1. `X-API-Key: <master>` + `X-HM-User-Id` / `X-HM-Org-Id` (service-to-service)
2. `Authorization: Bearer <token>` verified against hm-core's `/api/auth/verify`

**Verdict:** Necessary. There is no native multi-tenant auth in 2.0.8. This is the
single largest patchwork surface and the one most worth upstreaming.

### 3.2 `hm_bridge.py` — event forwarding (NO native webhook)

**Native:** AgentScope publishes events to its message bus and exposes them **only
over SSE**. There is no webhook, no callback registration, no event sink.

**Patchwork:** `hm_bridge.py` tails the session SSE stream and POSTs each event to
hm-core. It is a **tailer, not a webhook** — deliberately, because the SSE stream
replays buffered history to a late joiner, so a forwarder that starts after the run
began still sees every event. That property is what makes lazy start safe.

**Verdict:** Necessary. Would be eliminated by a native event-webhook registration.

### 3.3 `extra_agent_tools.py` — HIVEMIND capabilities as tools (NATIVE injection point)

**Native:** `create_app(extra_agent_tools=...)` **is** the documented injection
point. The tools themselves are native `ToolBase` subclasses.

**Patchwork:** Only the 9 tool bodies (they call hm-core). The *mechanism* is native.

**Verdict:** Correct use of the framework. Not patchwork.

### 3.4 `gateway_credential.py` — Cloudflare AI Gateway routing (NATIVE extension point)

**Native:** `CredentialBase.get_chat_model_class()` is the documented extension
mechanism for a custom provider.

**Patchwork:** A subclass is required because two things have no injection point
through the Agent Service API:
1. `base_url` — available on `OpenAICredential`, set at credential-creation time.
2. `client_kwargs` carrying `default_headers` (`cf-aig-authorization`,
   `cf-aig-byok-alias`) and an `http_client` whose request hook strips the
   `Authorization` header the OpenAI SDK insists on sending.

`app/_service/_model.py` constructs the model as
`model_cls(credential=credential, model=config.model, parameters=parameters)` —
**no `client_kwargs` argument**. A subclass is the clean way in.

**Verdict:** Correct use of the documented extension point. Not patchwork.

### 3.5 `workspace_backend.py` — backend selection (THIN WRAPPER)

**Native:** All 8 workspace managers exist in AgentScope.

**Patchwork:** A factory that maps `AGENTSCOPE_WORKSPACE_BACKEND` to the right
manager, with an actionable error when the extra is not installed (a missing
`workspace-e2b` extra otherwise surfaces as a bare `ImportError` deep inside the
framework).

**Verdict:** Thin wrapper. Not a reimplementation.

### 3.6 `app.py` — WorkRun routes (GENUINE PATCHWORK)

**Native:** AgentScope has no concept of a WorkRun. It has sessions and chats.

**Patchwork:** Three routes — `POST /workrun/`, `GET /workrun/{id}`,
`DELETE /workrun/{id}` — plus three helpers (`_resolve_agent`,
`_ensure_model_credential`, `_build_workrun_prompt`). These translate hm-core's
vocabulary into AgentScope's.

**Verdict:** Necessary glue. The routes call native handlers directly rather than
reimplementing them, so the patchwork is translation only.

### 3.7 `_ensure_model_credential` — credential auto-provisioning (GENUINE GAP)

**Native:** `create_session` requires `chat_model_config.credential_id` to name a
credential the user owns. There is no "use the deployment's default credential"
path.

**Patchwork:** When hm-core sends no `chat_model_config` (it is not the runtime's
job to know a tenant's provider key), the runtime provisions a gateway credential
for that user and reuses it. Without this the session is created model-less and the
first chat fails with the generic *"The request to the model was rejected as
invalid."*

**Verdict:** Necessary. This was a real bug found in e2e — see §5.

### 3.8 Permission mode override (GENUINE GAP)

**Native:** `PermissionContext` / `PermissionMode` exist, but `create_session` has
no parameter to set the mode. The default is `DEFAULT`, which asks before every
non-read-only tool.

**Patchwork:** After `create_session`, the runtime loads the session record, sets
`state.permission_context.mode = PermissionMode.BYPASS`, and persists it. Setting
it anywhere else would be overwritten on the next load.

**Why `BYPASS` and not `DONT_ASK`:** `DONT_ASK` converts every ASK to a **DENY**,
so the run would silently fail to write its artifact instead of parking. `BYPASS`
lets the run proceed. The workspace is isolated per run, so the blast radius is one
sandbox.

**Verdict:** Necessary. This was a real bug found in e2e — see §5.

---

## 4. ToolGroup / meta-tool — VERIFIED NOT INJECTABLE

The user asked for the `ToolGroup` meta-tool
(`docs.agentscope.io/versions/2.0.8/en/building-blocks/tool/manage-tools`).

**Finding (verified against installed source):**

- `ToolGroup` and `Toolkit(tool_groups=...)` **exist** in 2.0.8.
- `get_toolkit()` in `agentscope/app/_service/_toolkit.py` **does** build
  `tool_groups` — but only for **schedule tools**:
  ```python
  tool_groups = []
  ...
  if session_record.config.chat_model_config is not None:
      tool_groups.append(ToolGroup(name="schedule_tools", ...))
  ```
- `extra_factory` (our `extra_agent_tools`) result is appended to a **flat `tools`
  list** → lands in the implicit `basic` group. It is **not** groupable.
- `create_app` has **no `tool_groups` parameter** (verified: 23 params, none named
  `tool_groups`).
- Middleware has **no tool-group hook**.

**Conclusion:** In AgentScope 2.0.8, a caller-supplied `ToolGroup` (and therefore
the `reset_tools` meta-tool for it) is **not injectable through the Agent Service**.
It is SDK-only (`Toolkit(tool_groups=[...])` used directly).

**Options:**
- (a) Accept and document the limitation. ← **recommended**
- (b) `custom_agent_cls` to subclass `Agent` — does **not** help: `get_toolkit` is
  called by `ChatService`, not by the `Agent`.
- (c) Upstream feature request: add `extra_tool_groups` to `create_app`.

**Status:** Documented, not worked around. Building an unsupported workaround would
be patchwork on top of patchwork.

---

## 5. Bugs found and fixed during e2e (all verified against real source)

| # | Bug | Root cause | Fix |
|---|---|---|---|
| 1 | `ToolBase` instantiation failed | Abstract `check_permissions` not implemented | Added to `_HiveMindToolBase` → `PermissionDecision(PASSTHROUGH)` |
| 2 | `org_id` never available to tools | Factory signature is `(user_id, agent_id, session_id)` — **no org param** | hm-core resolves org from user membership; tools send no org |
| 3 | Every tool event showed literal `'tool'` | Normalizer read `tool_name`; real field is `tool_call_name` | Read `tool_call_name` |
| 4 | `'stop'` treated as a valid finish reason | `ReplyFinishedReason` is exactly `completed\|interrupted\|exceed_max_iters\|error` | Removed `'stop'` |
| 5 | Phantom team member per system hint | `HintBlockEvent.source` is **always** set (e.g. `"system"`) | Guard `source !== 'system'` |
| 6 | `HyperTurn.status='sealed'` rejected | Allowed: `live\|complete\|failed\|cost_capped` | Changed to `'complete'` |
| 7 | Runtime crashed at boot | Dockerfile did not `COPY extra_agent_tools.py` | Added COPY |
| 8 | Route conflict on `/internal/hyper/prospects` | Existing GET fired first, required query params | Made header-aware; removed duplicate |
| 9 | Prisma drift risk on `turn_id` | Partial unique index vs Prisma `@unique` | Changed to full unique index |
| 10 | `workspace-e2b` extra missing | `requirements.txt` omitted it | Added |
| 11 | **`jsonb -> bigint` operator does not exist** (SQLSTATE 42883) | Prisma binds a JS number as `bigint`; Postgres has only `jsonb -> int` | `$2::int` cast in `appendWorkRunEvent` |
| 12 | **`column "result" is of type jsonb but expression is of type text`** (SQLSTATE 42804) | Prisma binds a JS string as `text`; no implicit text→jsonb in `UPDATE SET` | `::jsonb` cast per jsonb column in `transitionWorkRun` |
| 13 | **WorkRun dispatch died `ENOTFOUND`** | Default URL `hm-agent-runtime-v2`; local container is `hm-agent-runtime-local` | Added `HM_AGENT_RUNTIME_URL` to compose |
| 14 | **Turn feed returned 409** | Room owner is the real local user; dispatched as a synthetic user | Dispatch as the room's actual owner |
| 15 | **Model rejected: "request to the model was rejected as invalid"** | WorkRun user had **no credential**; `_DEFAULT_WORKRUN_MODEL` was dead code | `_ensure_model_credential` auto-provisioning |
| 16 | **Run parked in `waiting_approval` forever** | Default permission mode asks before every write | Set session to `BYPASS` |
| 17 | Approval event had null tool/prompt | `RequireUserConfirmEvent` carries `tool_calls` (a list), not `tool_name`/`prompt` | Read `tool_calls`; emit `tool`, `call_id`, `tools` |

---

## 6. E2E verification — what actually ran

**Acceptance goal:** *"Find 10 German companies that match SINGULANCE's ICP, verify
them, create a structured prospect artifact, and draft outreach."*

**Observed (run `dfaba765-f9f1-41b1-a7ec-e989b3a2a7e8`):**

- WorkRun row created; `agentscope_session_id` and `workspace_id`
  (`workrun:<uuid>`) populated.
- Runtime created the agent record, session, and workspace.
- **9 HIVE-MIND tools assembled** for the resolved principal.
- Model calls to the Cloudflare AI Gateway returned **200 OK**.
- Events streamed to **both** sinks (`/internal/workruns/:id/event` and
  `/internal/hyper/turn-event`) — both 200.
- Tools actually invoked, in a sensible order:
  `hivemind_company_context` → `hivemind_recall` → `hivemind_list_prospects` →
  `hivemind_web_search` → `Bash` → `TaskCreate`/`TaskUpdate` →
  `hivemind_save_memory`.
- Event vocabulary normalized correctly: `workrun.started`, `agent.status`,
  `tool.started`, `tool.completed`, `team.member.started`, `approval.requested`,
  `workrun.failed`.
- Terminal states reached correctly: `failed` (with the real error captured),
  `waiting_approval` (before the permission fix), `running` (after).

**Not yet observed:** a `completed` terminal state. The run was still executing
(65 events, active model calls) when this handoff was written. The loop is proven
end-to-end; the *outcome* of the acceptance goal is not yet confirmed.

---

## 7. Known gaps / next steps

1. **No `completed` run yet.** Let the acceptance run finish and confirm
   `status='completed'` with a populated `result` and `result_artifact_ids`.
2. **Turn-feed POST intermittently times out** (`turn post failed:` with empty
   message). The WorkRun sink is unaffected. Likely the 10s `HM_FORWARD_TIMEOUT`
   under load — consider raising it or making the turn feed fire-and-forget.
3. **ToolGroup meta-tool** — documented limitation (§4).
4. **`hm_auth.py` is the largest patchwork surface** — worth upstreaming as native
   multi-tenant auth.
5. **`AGENTSCOPE_WORKSPACE_BACKEND=local`** in the local overlay means **no
   sandbox**. Fine for local; must be `docker`/`e2b` before multi-tenant.
6. **`.env` is gitignored** — the gateway values are documented in the file's
   comments but must be supplied per environment.

---

## 8. How to run it locally

```bash
# 1. The local stack (owns postgres/redis/qdrant/core/control-plane)
cd /Users/amar/HIVE-MIND-singulance-chat-local
docker compose --env-file infra/.env.hivemind-chat.local \
  -f infra/docker-compose.hivemind-chat.yml up -d

# 2. The runtime overlay (joins hivemind-network)
cd /Users/amar/HIVE-MIND-singulance-local
docker compose -f deploy/hm-agent-runtime-v2/docker-compose.local.yml up -d

# 3. Dispatch a WorkRun (must use the room's OWNER as user_id)
docker exec hivemind-control-plane node -e "
const { dispatchWorkRun } = await import('/app/src/employees/work-runs.js');
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
const { workRun } = await dispatchWorkRun({
  prisma,
  orgId: '00000000-0000-4000-8000-000000000002',
  userId: 'd1fbfe05-b91a-4cac-9b23-7b96d23c983d',   // room owner
  goal: 'Find 10 German companies that match SINGULANCE ICP, verify them, create a structured prospect artifact, and draft outreach.',
  hyperagentSlug: 'research',
  playbookId: 'prospect-research',
  scope: { country: 'DE', limit: 10 },
});
console.log(workRun.id);
await prisma.\$disconnect();
"

# 4. Watch it
docker exec hivemind-postgres psql -U hivemind -d hivemind_app -tAc \
  "SELECT status, jsonb_array_length(events) FROM hivemind.work_runs ORDER BY created_at DESC LIMIT 1"
docker logs -f hm-agent-runtime-local
```

**Environment facts:**
- Org: `00000000-0000-4000-8000-000000000002` (SINGULANCELABS)
- Room owner / dispatch user: `d1fbfe05-b91a-4cac-9b23-7b96d23c983d`
- HQ room: `b7fd3696-4039-4c93-b137-5b256b04994c`
- Containers: `hivemind-control-plane`, `hm-agent-runtime-local`,
  `hivemind-postgres`, `hivemind-core`
- Compose needs `--env-file infra/.env.hivemind-chat.local` (the `env_file:`
  directive sets container env, **not** interpolation)

---

## 9. File map

| File | Role | Classification |
|---|---|---|
| `app.py` | Service host + WorkRun routes | Native host + translation glue |
| `hm_auth.py` | hm-core identity | **Patchwork** (replaces placeholder) |
| `hm_bridge.py` | SSE → hm-core event forwarding | **Patchwork** (no native webhook) |
| `extra_agent_tools.py` | 9 HIVE-MIND tools | Native injection point |
| `gateway_credential.py` | Gateway-routed model | Native extension point |
| `cloudflare_gateway.py` | Gateway URL/headers | Config helper |
| `workspace_backend.py` | Backend selection | Thin wrapper |
| `model_cards/` | Model metadata | Data |
| `skills/` | AgentScope skills (this handoff) | Docs |
| `docker-compose.local.yml` | Local overlay | Config |
| `docker-compose.yml` | Production shape | Config |
| `Dockerfile` | Image | Config |
| `requirements.txt` | Pinned deps | Config |
| `load_test.py` | Load harness | Tooling |
