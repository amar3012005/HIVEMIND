# Hermes Agent — Docker Deployment Reference

Source: https://hermes-agent.nousresearch.com/docs/user-guide/docker

## Image

- Image: `nousresearch/hermes-agent:latest` (Docker Hub)
- Base OS: `debian:13.4`
- PID 1: s6-overlay v3 (not tini). Per-profile gateways auto-restart on crash. Do NOT override the entrypoint — keep `/init` in the command chain.
- Non-root enforced. Override (not recommended): `HERMES_ALLOW_ROOT_GATEWAY=1`.

## Commands (subcommands passed as container CMD)

### One-time interactive setup
```bash
mkdir -p ~/.hermes
docker run -it --rm \
  -v ~/.hermes:/opt/data \
  nousresearch/hermes-agent setup
```

### Gateway mode (production, headless server-side)
```bash
docker run -d \
  --name hermes \
  --restart unless-stopped \
  -v ~/.hermes:/opt/data \
  -p 8642:8642 \
  nousresearch/hermes-agent gateway run
```

### Gateway + dashboard
```bash
docker run -d \
  --name hermes \
  --restart unless-stopped \
  -v ~/.hermes:/opt/data \
  -p 8642:8642 \
  -p 9119:9119 \
  -e HERMES_DASHBOARD=1 \
  nousresearch/hermes-agent gateway run
```

### Gateway + OpenAI-compatible API server exposed
```bash
docker run -d \
  --name hermes \
  --restart unless-stopped \
  -v ~/.hermes:/opt/data \
  -p 8642:8642 \
  -e API_SERVER_ENABLED=true \
  -e API_SERVER_HOST=0.0.0.0 \
  -e API_SERVER_KEY="$(openssl rand -hex 32)" \
  -e API_SERVER_CORS_ORIGINS='*' \
  nousresearch/hermes-agent gateway run
```
Note: `API_SERVER_CORS_ORIGINS='*'` violates the project CORS baseline for production — set explicit origins.

## docker-compose.yml

```yaml
services:
  hermes:
    image: nousresearch/hermes-agent:latest
    container_name: hermes
    restart: unless-stopped
    command: gateway run
    ports:
      - "8642:8642"    # gateway API
      - "9119:9119"    # dashboard
    volumes:
      - ~/.hermes:/opt/data
    environment:
      - HERMES_DASHBOARD=1
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: "2.0"
```

## Ports

- `8642` — Gateway API server (OpenAI-compatible), optional
- `9119` — Web dashboard, optional, requires `HERMES_DASHBOARD=1`

## Environment variables

| Variable | Purpose | Default / Example |
|----------|---------|-------------------|
| `HERMES_DASHBOARD` | Enable web dashboard | `1` |
| `HERMES_DASHBOARD_PORT` | Dashboard HTTP port | `9119` |
| `HERMES_DASHBOARD_HOST` | Dashboard bind address | `0.0.0.0` |
| `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` / `_PASSWORD` | Basic-auth gating | — |
| `HERMES_DASHBOARD_OAUTH_CLIENT_ID` | OAuth gating | — |
| `HERMES_DASHBOARD_OIDC_ISSUER` / `_CLIENT_ID` | OIDC gating | — |
| `HERMES_DASHBOARD_INSECURE` | Disable dashboard auth (only behind own auth layer) | `1` |
| `API_SERVER_ENABLED` | Expose OpenAI-compatible API | `true` |
| `API_SERVER_HOST` | API server bind address | `0.0.0.0` |
| `API_SERVER_KEY` | API key, min 8 chars | `openssl rand -hex 32` |
| `API_SERVER_CORS_ORIGINS` | Allowed CORS origins | `*` (set explicit in prod) |
| `PUID` / `PGID` (or `HERMES_UID` / `HERMES_GID`) | NAS / host-user UID/GID mapping | match host user |
| `HERMES_SKIP_CONFIG_MIGRATION` | Skip auto-migration on upgrade | unset = migrate |
| `HERMES_ALLOW_ROOT_GATEWAY` | Permit root gateway (not recommended) | `1` |

## Volume — host `~/.hermes` → container `/opt/data`

All state persists here:
- `.env` — API keys / secrets
- `config.yaml` — all configuration
- `sessions/` — conversation history
- `memories/` — persistent memory store
- `skills/` — installed skills
- `home/` — per-profile HOME for tool subprocesses
- `logs/` — runtime logs

## config.yaml — model connectivity

```yaml
model:
  provider: custom
  model: my-model
  base_url: http://vllm:8000/v1
  api_key: "none"
```

## Upgrade

```bash
docker pull nousresearch/hermes-agent:latest
docker rm -f hermes
docker run -d \
  --name hermes \
  --restart unless-stopped \
  -v ~/.hermes:/opt/data \
  nousresearch/hermes-agent gateway run
```
Compose: `docker compose pull && docker compose up -d`

## Resource requirements

- Memory: min 1 GB; recommended 2–4 GB (Playwright/Chromium is memory-heavy)
- CPU: min 1 core; recommended 2
- Disk: min 500 MB; 2+ GB recommended for sessions/skills

## Gotchas

- NEVER run two gateway containers against the same data directory — session files and memory stores have no concurrent-write protection.
- Playwright/browser tools require shared memory: add `--shm-size=1g`.
- Browser-based VPS web consoles corrupt special chars (`:`→`;`, `@` mis-rendered) in `-v`/`-e` flags — connect via SSH for `docker run`.
- Dashboard defaults to gated auth on non-loopback binds; supply exactly one provider (basic-auth, OAuth, or OIDC) or set `HERMES_DASHBOARD_INSECURE=1` only behind your own auth.
- Do not override the container entrypoint (`/init`); s6-overlay supervision depends on it.
