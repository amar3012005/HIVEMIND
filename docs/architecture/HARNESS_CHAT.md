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

1. Browser stays on `https://next.preview.singulancelabs.com/hivemind/app/overview`.
2. Control plane authenticates the HIVE user and issues a short-lived admission ticket.
3. The runner establishes a tenant-scoped session cookie from that ticket.
4. Native Harness serves conversation, session projection, tools, and replay.
5. Core remains memory and connector authority. Harness must not invent tenant facts.
6. External writes go through persisted draft → approval → provider completion.

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

The only supported local entrypoint is `./scripts/harness-chat-env`. It combines
the existing Core stack, local service stack, and
`infra/docker-compose.hivemind-chat.yml` under the single Compose project
`hivemind-chat-local` and network `hivemind-network`. The runner is built from
the locked Harness SHA with Docker layer cache and contains the whole resolved
native profile. It reuses the same PostgreSQL and Redis services; it never
creates a parallel persistence stack.

Older development overlays that bind-mount individual Harness packages
(`infra/docker-compose.harness-hotfix.yml` and sibling `*.fast-runtime.yml`,
`*.clean-frontend.yml`, `*.runtime.yml`, `*.override.yml`) are recovery artifacts.
They are recovery evidence, not supported inputs to the canonical command.

## Ingress

Repo files disagree, so do not assume Caddy from chat history:

- `infra/docker-compose.production.yml` uses Traefik.
- Root `Caddyfile*` and `docker-compose.caddy.yml` still exist.
- `infra/docker-compose.hetzner.yml` still mentions `hm-caddy` for `/voice2`.

Live production ingress must be confirmed with SSH before a production cutover.
Until that check is recorded here, treat Traefik, Caddy, Cloudflare, and Coolify
as coexisting documents, not one live fact.

## Agent start command

```bash
./scripts/harness-chat-env status
```

Then follow `docs/runbooks/HARNESS_CHAT_LOCAL.md`.
