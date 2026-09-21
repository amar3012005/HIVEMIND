# hm-agent-runtime-v2 — Phase 1

One async AgentScope Agent Service process, running locally in Docker, with every
model call routed through the **same Cloudflare AI Gateway that hm-core uses**.

```
VPS / local host
├── hm-core            (identity / org / policy / billing — NOT wired yet)
├── Postgres           (hm-core's — untouched by this service)
├── Redis              (hm-core's — untouched by this service)
└── hm-agent-runtime-v2
    ├── redis          ← AgentScope's OWN storage + message bus (port 6390)
    └── Agent Service  ← ONE process, port 8000 (loopback only)
```

## Status: verified working

End-to-end chat through the gateway, observed on the SSE stream:

```
POST /chat  → 200 {"status":"started"}
REPLY_END   → finished_reason: completed, error: null
assistant   → "4."
```

Model served: `deepseek/deepseek-v4-flash` via
`gateway.ai.cloudflare.com/v1/<account>/hivemind-prod/openrouter`.

## Run it

```bash
cd <repo root>
export DOCKER_GID=$(stat -f %g /var/run/docker.sock)   # macOS; lets the non-root user use the socket
export HM_BUILD_REF=$(git rev-parse HEAD)               # Core can reject a stale runtime when opted in
docker compose -f deploy/hm-agent-runtime-v2/docker-compose.yml up -d --build
docker compose -f deploy/hm-agent-runtime-v2/docker-compose.yml ps
curl -s -H "X-User-ID: demo" http://127.0.0.1:8000/health | python3 -m json.tool
```

Set `HM_AGENT_RUNTIME_BUILD_REF` to the same immutable commit in hm-core to
enable its pre-dispatch/recovery source-parity gate. The runtime exposes that
non-secret build reference only through authenticated `GET /runtime/identity`;
`/livez` remains a minimal unauthenticated liveness response.

`.env` (git-ignored) holds the gateway values, copied from the running
`hivemind-core` container so both share one egress path:

```
CLOUDFLARE_AI_GATEWAY_ENABLED=true
CLOUDFLARE_ACCOUNT_ID=…
CLOUDFLARE_AI_GATEWAY_ID=hivemind-prod
CLOUDFLARE_AI_GATEWAY_TOKEN=…
CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS=first-bundb
CLOUDFLARE_AI_GATEWAY_BASE_URL=https://gateway.ai.cloudflare.com
```

## The API flow (get this exactly right)

```python
# 1. credential — type must be the registered Literal
POST /credential/  {"data": {"type": "cloudflare_gateway_credential",
                             "name": "cf-gw", "api_key": "gateway-managed"}}

# 2. agent
POST /agent/       {"name": "…", "system_prompt": "…"}

# 3. session — the field is chat_model_config, NOT config.model
POST /sessions/    {"agent_id": aid,
                    "chat_model_config": {
                        "type": "cloudflare_gateway_credential",
                        "credential_id": cid,
                        "model": "deepseek/deepseek-v4-flash",
                        "parameters": {"max_tokens": 128}}}

# 4. subscribe BEFORE triggering (the stream replays history, but this is cleaner)
GET  /sessions/{sid}/stream?agent_id={aid}

# 5. trigger
POST /chat/        {"agent_id": aid, "session_id": sid,
                    "input": {"name": "demo", "role": "user",
                              "content": [{"type": "text", "text": "…"}]}}
```

Note the trailing slashes on `/credential/`, `/agent/`, `/sessions/`, `/chat/`,
`/model/` — the list/create routes are registered with them.

## Cloudflare AI Gateway: the request shape that works

Through `…/openrouter/chat/completions`:

| Header | Value |
| --- | --- |
| `cf-aig-authorization` | `Bearer <CLOUDFLARE_AI_GATEWAY_TOKEN>` |
| `cf-aig-byok-alias` | `<CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS>` |
| `cf-aig-skip-cache` | `true` |
| `Authorization` | **must be absent** |

Measured results:

| Attempt | Result |
| --- | --- |
| alias + gateway auth, **no** `Authorization` | **200 OK** |
| alias + gateway auth + `Authorization: Bearer sk-…` | 401 `Missing Authentication header` |
| no `cf-aig-authorization` | 401 `AiGatewayError 2009 Unauthorized` |
| unknown alias | 400 `AiGatewayError 2040` — *"Provider 'openrouter' has no BYOK credential named 'default'. Configured aliases: 'first-bundb'"* |
| real OpenRouter key in `Authorization` | 400 `2040` — the route **requires** a BYOK alias and will not fall back to a client key |

The OpenAI SDK always sends `Authorization`, so `cloudflare_gateway.py` installs
an `httpx` request hook that removes it just before egress. Verified in-container:
`auth before: Bearer sk-placeholder | auth after: None → HTTP 200`.

## Files

| File | Purpose |
| --- | --- |
| `app.py` | `create_app` wiring: storage, bus, workspace, roles, gateway credential, auth override, WorkRun routes, diagnostics |
| `hm_auth.py` | hm-core identity — internal key, bearer verify, dev fallback |
| `hm_bridge.py` | WorkRun → session mapping + SSE event forwarding to hm-core |
| `workspace_backend.py` | Sandbox backend selection (local/docker/e2b/k8s/…) |
| `load_test.py` | Concurrency measurement — the number that sizes workers |
| `cloudflare_gateway.py` | Gateway URL/headers, the Authorization-stripping client, debug logging |
| `gateway_credential.py` | `CloudflareGatewayOpenAICredential` + `CloudflareGatewayChatModel` |
| `model_cards/*.yaml` | Real context/output limits + modality for the DeepSeek models |
| `static/index.html` | Single-page chat console served at `/` |
| `requirements.txt` | Scoped extras — deliberately **not** `[full]` (see the file) |
| `Dockerfile` | python:3.12-slim, non-root, healthcheck on `/livez` |
| `docker-compose.yml` | redis + one agent-service process |

## Traps found while building this (all fixed)

Each of these cost real debugging time. They are recorded so they are not
rediscovered.

1. **`create_app` is exported by `agentscope.app`, not `agentscope`.**
   `from agentscope import create_app` fails.

2. **`custom_subagent_templates`** is the real parameter. The public docs say
   `sub_agent_templates`, which does not exist and is **silently swallowed** by
   `create_app(**kwargs)` — templates never register and every worker falls back
   to one default role, with no error.

3. **A custom credential's `type` must be a `Literal`.** A plain `str` raises
   `PydanticUserError: Model '…' needs field 'type' to be of type 'Literal'` at
   *request* time (HTTP 500), not import time. Credentials are a discriminated
   union keyed on `type`.

4. **`CredentialFactory` is a tagged union of built-ins.** A custom type must be
   registered or `from_dict()` fails on reload. `create_app(extra_credentials=[…])`
   does this for you (`app/_app.py:288`) — but a standalone script must call
   `CredentialFactory.register_credential(cls)` itself.

5. **`list_models()` resolves YAML relative to the *model subclass's* file**, and
   the service calls `credential.get_chat_model_class().list_models()`. A
   credential-level override is never consulted — the override must be on the
   **model** class.

6. **The session field is `chat_model_config`**, not `config.model`. A wrong key
   is silently dropped, and the failure surfaces later as
   `404: No model configuration found for agent …`.

7. **AgentScope logs no traceback for a failed reply.** The client sees only
   *"The request to the model was rejected as invalid."* — a category, not a
   cause. `AGENTSCOPE_LOG_LEVEL=DEBUG` enables a wrapper that logs the real
   exception. Note it must patch **both** `_errors._classify_error` and
   `_chat._classify_error`: `_chat.py` does `from ._errors import _classify_error`,
   binding the function at import time, so patching the source module alone has
   no effect.

8. **`Msg.content` must be a list**, not a string — `[{"type":"text","text":"…"}]`.

9. **`AGENTSCOPE_LOG_LEVEL` / `AGENTSCOPE_GATEWAY_DEBUG` must be listed in
   compose's `environment:`** or they never reach the container.

10. **`EventSource` cannot send custom headers.** The browser's `EventSource`
    API has no header option, so it cannot carry `X-User-ID` / `Authorization` —
    the SSE stream answers 422/401 and no events ever arrive. The UI streams with
    `fetch()` + `ReadableStream` and parses SSE frames by hand instead.

11. **A Cloudflare *quick* tunnel buffers SSE.** `cloudflared tunnel --url`
    proxies the response body as one blob, so the chat UI shows nothing until the
    run finishes. A **named** tunnel streams it correctly. Verified: 0 frames via
    quick tunnel, 17 via named tunnel, same service.

12. **`/health` requires auth once `get_current_user_id` is overridden.** It
    resolves the caller through that dependency, so it 401s without credentials —
    correct for an operator endpoint, fatal for a container healthcheck. Use an
    unauthenticated `/livez` for the probe.

13. **`CreateSessionRequest` lives in `agentscope.app._router._schema._session`,
    not `agentscope.app._types`.** Importing it from `_types` raises ImportError
    at request time (HTTP 500), not import time.

14. **`host.docker.internal` is not mapped by default on Linux.** A container
    reaching a service on the host needs `extra_hosts: ["host.docker.internal:host-gateway"]`
    in compose. Without it the forwarder fails with `Name or service not known`.

## What is NOT done

| Gap | Detail |
| --- | --- |
| **Artifacts** | Nothing writes HTML/PDF/image/video into the workspace or registers it back into HIVE-MIND. |
| **Knowledge base** | `knowledge_base_manager` is not passed, so every `/knowledge_bases` route returns 503. |
| **Hubs off** | `AGENTSCOPE_ENABLE_HUBS=0`; the MCP/Skill pages are disabled. |
| **`api_key` is schema-required** | The gateway credential inherits `api_key` from `OpenAICredential`, so the form demands a value that is never transmitted. Operators paste a placeholder. Making it optional when the gateway is enabled is a known improvement. |
| **Not committed** | Nothing here is in git yet. |

## Production blockers — resolved

### 1. Auth — hm-core identity replaces the `X-User-ID` placeholder ✅

`hm_auth.py` + a `dependency_overrides[get_current_user_id]` in `app.py`. Three
credential shapes, checked in order:

| Caller | Credential | Notes |
| --- | --- | --- |
| hm-core control plane | `X-API-Key: <HIVEMIND_MASTER_API_KEY>` + `X-HM-User-Id` / `X-HM-Org-Id` | Exactly what `core/src/internal/internal-fetch.js` emits — hm-core needs no new client code. Constant-time compare. |
| Browser / external | `Authorization: Bearer <token>` | Verified against hm-core's Core API (`HM_CORE_URL`). |
| Local dev | `X-HM-User-Id` alone | Only when `AGENTSCOPE_ALLOW_DEV_AUTH=1`. Logs a loud warning. |

Verified: no credentials → **401**; dev header → **200**; internal key → **200**.

`/livez` is a new unauthenticated liveness probe. AgentScope's `/health` now
correctly 401s without credentials (it enumerates component topology), which
would have made the Docker healthcheck kill a healthy container — so the probe
moved to `/livez`.

### 2. hm-core wiring — WorkRun → session + event forwarding ✅

`hm_bridge.py` + three routes. hm-core creates a WorkRun, then calls
`POST /workrun/` with the resolved principal; the runtime creates the session,
persists the reverse index in its own Redis, and starts tailing the session's
SSE stream.

| Route | Purpose |
| --- | --- |
| `POST /workrun/` | Bind a WorkRun to a new session. **Idempotent** — a retried call returns the same session. |
| `GET /workrun/{id}` | Look up the binding + forwarder stats. |
| `DELETE /workrun/{id}` | Unbind and stop the forwarder. |

Forwarding POSTs each event to hm-core's inbound sink
(`POST /internal/hyper/turn-event`), carrying the `work-room-execution.v1`
identity block that `core/src/contracts/hyper-seams.js` validates.

Verified against a mock sink: **16 events forwarded, 0 failed**, every one
carrying the correct contract + execution id.

### 3. Sandbox — backend is now configuration ✅

`workspace_backend.py` selects the manager from `AGENTSCOPE_WORKSPACE_BACKEND`:
`local` · `bubblewrap` · `apple` · `docker` · `e2b` · `daytona` · `opensandbox` ·
`k8s`. Moving off the single-tenant `local` backend is an env change, not a code
change.

**Distribution is the deciding factor.** `local`, `bubblewrap`, `apple`, and
`docker` keep workspace state on the host running the service — behind a load
balancer a request for the same `workspace_id` can land on a node that cannot
reach it. Pick `e2b` / `daytona` / `opensandbox` / `k8s` before scaling past one
node. The module logs a warning when a single-node backend is selected.

### 4. Load test — measured, not asserted ✅

`load_test.py` runs N concurrent sessions on the one process. Each run gets its
own agent + session (sharing one would measure AgentScope's single-run-per-session
lock, not concurrency), and reads the SSE stream with a raw socket loop (urllib's
line iterator buffers, which would report buffer-flush time as latency).

Measured on this machine, `deepseek/deepseek-v4-flash`:

| Concurrency | Runs | OK | Wall | rps | p50 | p95 | max | Memory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 6 | 6 | 19.3s | 0.31 | 2.61s | 4.98s | 4.98s | 150→156 MB |
| 5 | 6 | 6 | 5.5s | 1.10 | 2.90s | 3.06s | 3.06s | 156→160 MB |
| 10 | 6 | 6 | 5.1s | 1.19 | 3.08s | 5.06s | 5.06s | 160→165 MB |
| 25 | 25 | 25 | 6.3s | 3.99 | 4.51s | 6.26s | 6.26s | 165→191 MB |
| 50 | 25 | 25 | 8.1s | 3.10 | 5.48s | 7.53s | 8.07s | 191→191 MB |

**Reading:** 100% success at every level. p50 rises gently (2.6s → 5.5s) and
memory is ~1 MB/session and flat at 50 concurrent — the process is I/O-bound on
the model, not event-loop-bound. **One process comfortably hosts 50 concurrent
sessions.** The knee is not reached at 50; re-run at 100+ before sizing workers.

Run it:

```bash
python3 load_test.py --concurrency 1,5,10,25,50 --runs-per-level 25
```

## Next steps, in order

1. Point `HM_CORE_URL` at the real hm-core and set `HM_FORWARD_ENABLED=1`.
2. Pick a distributed sandbox backend (`e2b` / `k8s`) before multi-tenant use.
3. Add the artifact pipeline.
4. Commit.
