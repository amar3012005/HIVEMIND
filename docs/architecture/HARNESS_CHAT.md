# HIVE native Harness chat

This is the durable architecture contract for HIVEMIND chat mode. Agents must
read this file and `docs/decisions/HARNESS_CHAT_DECISIONS.md` before changing
Harness, Overview, admission, Compose, or Composio connected-app code.

## Goal

Mount the complete native DeepSeek Harness `web` runtime inside the Da-vinci
HIVE shell. HIVE mode may hide and reposition native chrome. It must not delete
native renderers, plugins, session history, or the agent loop.

## Ownership

| Surface | Authority | Must remain responsible for |
| --- | --- | --- |
| Core | `core/`, `hm-core` | Memory, connectors, governed actions, tenant-scoped business APIs |
| Control plane | `core/src/control-plane-server.js`, `hm-control` | Identity, admission tickets, public proxy, policy |
| Harness runner | `deepseek-harness-hivemind` branch `hivemind-chat` | Native runtime, `hivemind-chat` profile, session events, tool cards, trajectory, replay |
| PostgreSQL | `hivemind` schema | Sessions, events, jobs, approvals, receipts |
| Redis | existing HIVE Redis | Admission nonces, coordination, leases |
| Da-vinci | `frontend/Da-vinci` | Visible product shell and navigation |
| Cloudflare preview Worker | `workers/harness-chat` | Same-origin static assets plus `/api/*` and `/api/remote.mux` WebSocket proxy |
| Production | `singulance-main` | Protected. Promote only after acceptance. Never edit as the development branch. |

## Request flow

1. Browser stays on the canonical Overview route family:
   - `/hivemind/app/overview` selects the newest accessible non-empty root
     session, or creates one when none exists.
   - `/hivemind/app/overview/new` creates one native Harness session and then
     replaces the URL with `/hivemind/app/overview/session/{opaqueSessionId}`.
   - `/hivemind/app/overview/session/{opaqueSessionId}` opens that exact
     tenant-authorized root session. Unknown, cross-tenant, and sub-agent IDs
     fail closed without disclosing which condition applied.
2. Control plane authenticates the HIVE user and issues a short-lived admission ticket.
3. The runner establishes a tenant-scoped session cookie from that ticket.
4. Native Harness serves conversation, session projection, tools, and replay.
5. Core remains memory and connector authority. Harness must not invent tenant facts.
6. External writes go through persisted draft → approval → provider completion.

The URL is a projection of the native Harness session service. It contains
only the opaque Harness session ID—never a user ID, organization ID, Composio
workflow ID, or a second frontend state store. Native session selection pushes
the canonical URL; browser back/forward and reload project the URL back through
the same tenant-scoped session service.

Private preview tunnels may ingress to a loopback Harness port. They must not
appear in the browser URL, become a second frontend, or remain in a production
request path.

## HIVE mode composition

When `data-dsh-mode="hivemind-chat"`:

- Keep native Markdown, tables, code, reasoning, tool cards, trajectory, replay, attachments, and session statistics.
- Hide, do not unregister, native sidebar, workspace chrome, settings, and developer controls.
- Project the five newest non-empty root sessions with native session-row components.
- Keep filesystem/shell/developer operations policy-denied.

When `data-dsh-mode="native"`, render stock Harness with no HIVE layout selectors.

## Local runtime shape

The only supported local entrypoint is `./scripts/harness-chat-env`. It uses
one Compose file, `infra/docker-compose.hivemind-chat.yml`, project
`hivemind-chat-local`, network `hivemind-network`. Required services:

origin-gateway, cloudflared, core, control-plane, harness-runner, postgres,
redis, qdrant, nango, employees, playwright, docling.

Internal calls use Compose DNS names. Persistent volumes are explicit:
`hivemind-postgres-data`, `hivemind-qdrant-data`, `hivemind-docling-models`,
`hivemind-redis-data`. The runner image is built from the locked Harness SHA
and must contain the whole resolved native profile.

`docker-compose.local-stack.yml`, `docker-compose.local-services.yml`, and
Harness hotfix overlays are recovery evidence, not supported inputs.

## Ingress

Browser stays on `https://next.preview.singulancelabs.com`. Cloudflare Worker
serves Da-vinci static assets and same-origin routing. One named Cloudflare
tunnel delivers remaining traffic to the local origin gateway (Caddy). Caddy
is host/path routing only:

| Public hostname/path | Internal destination |
| --- | --- |
| `next.preview...` static | Cloudflare-deployed Da-vinci |
| `next.preview.../v1/*` | `control-plane:3000` |
| `next.preview.../api/hivemind/session/*` | `harness-runner:3080` |
| `next.preview.../api/remote.mux` | `harness-runner:3080` (WebSocket) |
| `preview-api.singulancelabs.com` | `control-plane:3000` |
| `preview.singulancelabs.com` | `core:3000` |
| private Harness origin | `harness-runner:3080` |
| preview Nango hostname | `nango:8080` |

The private Harness origin is transport, not a second frontend.

Live production (SSH `singulance`, 2026-09-10) still uses `hm-caddy` on the
server. That production edge is out of scope for this local project.

## Agent start command

```bash
./scripts/harness-chat-env status
```

Then follow `docs/runbooks/HARNESS_CHAT_LOCAL.md`.
