# HIVE-MIND AgentScope runtime

This folder contains HIVE-MIND's AgentScope Agent Service integration. It is the
execution runtime behind governed WorkRuns—not the HIVE control plane, browser
UI, or native DeepSeek Harness.

## Ownership and runtime boundary

This code lives in the `amar3012005/HIVEMIND` repository, on its
`singulance-local` development line. The web UI lives in the `frontend/Da-vinci`
submodule. The native Cordis/DeepSeek Harness is a separate repository and is
not replaced by this service. See [ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md)
for the complete flow, current status, and build plan.

```text
User
  → Da-vinci HM Rooms / WorkRuns UI
  → HIVE-MIND Core control plane
      ├─ authenticates principal, applies policy, creates durable WorkRun
      ├─ stores WorkRun lifecycle/events/checkpoints in PostgreSQL
      └─ dispatches POST /workrun/ to this runtime
  → AgentScope Agent Service (this folder)
      ├─ native AgentScope agent + session/chat lifecycle
      ├─ AgentScope Redis storage/message bus and SSE
      ├─ per-WorkRun workspace and injected HIVE tools
      └─ hm_bridge tails AgentScope SSE and forwards events to Core
  → Core normalizes/deduplicates/persists events and serves WorkRun SSE
  → Da-vinci renders progress, tool calls, answer deltas, tasks, and artifacts
```

The UI streams from Core, not directly from this runtime. AgentScope's session
events reach the UI only after `hm_bridge.py` forwards them and Core accepts and
persists them. A healthy runtime or HTTP 200 alone does not prove end-to-end
visible streaming; verify first visible deltas in the browser.

## What this runtime provides

- AgentScope 2.0.8 `create_app` service, native agents/sessions/chat, Redis
  storage and message bus, SSE, workspace manager, scheduler/channel worker
  configuration, and optional MCP/skill hubs.
- Cloudflare AI Gateway model credential through the AgentScope credential
  extension point. Keep credentials in the runtime secret store/environment;
  never commit values.
- HIVE WorkRun binding endpoints: `POST /workrun/`, `GET /workrun/{id}`,
  `POST /workrun/{id}/cancel`, and `DELETE /workrun/{id}`. A Redis binding maps
  WorkRun identity to AgentScope agent/session/turn/workspace; repeated binding
  requests are checked for identity consistency.
- `hm_bridge.py` SSE tailer forwards event records to Core's WorkRun event sink.
  Core owns durable lifecycle and browser-facing stream; a successful model
  reply ends a turn, not necessarily the multi-turn WorkRun.
- `extra_agent_tools.py` injects HIVE context/memory, playbook discovery,
  artifact operations, prospect/web capabilities, and evidence-gated WorkRun
  completion as AgentScope tools.
- `workspace_backend.py` selects the configured AgentScope workspace backend.
  Backend availability does not itself prove production-grade isolation or
  distributed workspace durability.
- Prompt policy distinguishes direct answers from company work: direct answers
  should use minimal relevant context and no operating plan; company work should
  select a playbook, create/update AgentScope tasks, use only relevant tools,
  persist requested artifacts, and request HIVE completion validation.

## Source map

| Path | Responsibility |
| --- | --- |
| [`app.py`](app.py) | AgentScope app wiring, auth override, gateway model, WorkRun routes and prompts |
| [`hm_auth.py`](hm_auth.py) | Core-backed principal verification and constrained local development auth |
| [`hm_bridge.py`](hm_bridge.py) | Durable WorkRun/session binding and AgentScope SSE event forwarding |
| [`extra_agent_tools.py`](extra_agent_tools.py) | HIVE tools, context/playbook/artifact access, completion request |
| [`workspace_backend.py`](workspace_backend.py) | Configurable AgentScope workspace backend selection |
| [`gateway_credential.py`](gateway_credential.py) | Cloudflare AI Gateway AgentScope credential/model extension |
| [`cloudflare_gateway.py`](cloudflare_gateway.py) | Gateway headers/client behavior |
| [`requirements.txt`](requirements.txt) | Pinned AgentScope version and selected extras |
| [`Dockerfile`](Dockerfile) / [`docker-compose.yml`](docker-compose.yml) | Runtime image and local service topology |
| [`tests/`](tests/) | Runtime and bridge contract tests |
| [`skills/agentscope-runtime/`](skills/agentscope-runtime/) | Runtime integration notes and AgentScope-specific constraints |

Control-plane ownership is in `core/src/employees/work-runs.js` and related
`core/src` routes/contracts. Frontend ownership is in the `frontend/Da-vinci`
submodule. Those components have their own release artifacts and verification.

## Local development

From repository root, inspect the compose file and required environment keys
before starting services. Use local-only credentials and never paste secret
values into logs or docs.

```bash
docker compose -f deploy/hm-agent-runtime-v2/docker-compose.yml config
docker compose -f deploy/hm-agent-runtime-v2/docker-compose.yml up -d --build
docker compose -f deploy/hm-agent-runtime-v2/docker-compose.yml ps
curl -fsS http://127.0.0.1:8000/livez
```

`/livez` is an unauthenticated liveness probe. Functional endpoints require
configured caller identity. For local development, use the explicitly enabled
development-auth mode only on a loopback/private service; do not expose it
publicly. See [`hm_auth.py`](hm_auth.py) and compose configuration for exact
environment names.

Run focused tests from repository root:

```bash
python3 -m pytest deploy/hm-agent-runtime-v2/tests -q
```

## Version and release discipline

AgentScope package version is pinned in [`requirements.txt`](requirements.txt).
The runtime source branch and deployed image are separate facts: record source
SHA, image digest, target control plane, and canary results for any deployment.
This documentation change does not deploy anything. Never infer preview or
production rollout from a source push.

Before preview release, validate the exact Core/runtime/UI compatibility and
run the acceptance gates in [ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md). Keep
production release on its separate governed path.
