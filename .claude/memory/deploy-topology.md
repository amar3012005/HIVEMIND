# Deploy topology

## Containers (Hetzner, docker)
| Container | Role |
|---|---|
| `hm-core` | core-api (Node/Express) — the recall/chat/ingestion/connector runtime. Image `hivemind/core-api:prod-<date>-<sha>`. |
| `hm-control` | control plane. `HIVEMIND_CORE_URL=http://hm-core:3000` (this is the FE→core hop). |
| `hm-fe` | frontend (`singulancelabs.com`). |
| `hivemind-next-frontend-1` | next frontend (`next.singulancelabs.com`). |
| `hm-employees` | HyperAgents / employees-service (Python AgentScope). |
| `tara-deepgram` | TARA voice service (Python). |
| `hm-caddy` | Caddy reverse proxy. Routes `core.singulancelabs.com`→core, the two FE hosts, etc. |

## Git remotes
- **Backend:** push verified work to `singulance-main`. Current HEAD `e01367541`.
- **Frontend:** `main` (currently `1ab5f62`). The repo has a gitlink to `frontend/Da-vinci`
  that must be bumped when FE changes.
- Also mirror durability to `/root/builds/v5-canonical/.claude/` where relevant.

## Deploy (RISK tier — human gate, rollback tag first)
- The current path is a **baked-image compose recreate** (NOT `quick-deploy.sh`): build the
  core-api image `hivemind/core-api:prod-<date>-<sha>` from a **singulance-main checkout**
  (a git worktree — NOT the `feat/mneme-foundation` working dir, which is diverged and lacks
  the recall/timeline prod fixes), bump `VERSION` in `/root/hivemind/.env`, then recreate.
- **Build:** `docker build -f Dockerfile.production --build-arg CACHE_BUST=$(date +%s) -t hivemind/core-api:<tag> <worktree>`
  (Dockerfile has a `CACHE_BUST` ARG before the src COPY — pass it or the src layer is stale).
- **Recreate — CRITICAL gotcha:** `docker compose -f infra/docker-compose.hetzner.yml up -d core`
  ALONE FAILS with `required variable BROKER_DATABASE_URL is missing` (+ blank-string warnings
  for POSTGRES_PASSWORD/OPENROUTER_API_KEY/…). Compose resolves `${VAR}` **interpolation** from
  its project dir (defaults to `infra/`, which has no `.env`), NOT from the per-service
  `env_file: [../.env]` (that only sets in-container env). **Always pass `--env-file` explicitly**
  and use the SERVICE name `core` (not container name `hm-core`):
  ```bash
  docker compose --env-file /root/hivemind/.env -f infra/docker-compose.hetzner.yml up -d core
  ```
- Before deploy: write a rollback marker (`.last-core-*-rollback` files) with the last-known-good
  image tag. Stable image snapshots for ALL containers live at `:stable-20260722` — see
  [rollback-manifest.md](rollback-manifest.md).
- After deploy: verify `docker logs hm-core --since 2m | grep "Recall warm-up complete"` + healthy.

## FE → core wiring (verified 2026-07-22)
FE (browser) → Caddy → `hm-control` (`HIVEMIND_CORE_URL=http://hm-core:3000`) → `hm-core`.
So FE chat/recall behavior is exactly whatever `hm-core`'s image serves. To make a recall/chat
fix "reflect in FE" you deploy hm-core — no FE rebuild needed unless the FE code itself changed
(e.g. the Overview.jsx scope-chooser, which DID need an FE build + gitlink bump).

## Env
- `/root/hivemind/.env` holds the runtime flags (CONNECTOR_RUNTIME_*, RECALL_*, HYBRID_*,
  MNEME_*, RERANK_*). Explicit env is authoritative in the connector config loader.
- LLM providers: **Cerebras or OpenRouter only.** `groq-fallback.js` now funnels
  `cerebras/*`|`google/*` bodies to `chat-provider.js` with OpenRouter fallback.
