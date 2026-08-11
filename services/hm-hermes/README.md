# hm-hermes — Hermes runtime container

Hosts NousResearch Hermes as HIVEMIND's per-tenant "external agent brains".
Base image `nousresearch/hermes-agent:latest`; state in the `/opt/data` volume;
HiveMind MCP is the memory system of record (Phase 3). hm-control is the only
caller (Phase 4) — FE never talks to Hermes directly.

## Artifacts (Phase 2)
- `Dockerfile` — extends the base image, bakes a `:8642` healthcheck + the shim.
- `shim.mjs` — hm-control↔gateway bridge **stub** (completed Phase 4).
- `.env.example` — env template (gateway/dashboard/MCP). Real secrets via Coolify env only.
- `hm-hermes` service block in `docker-compose.coolify.yml` (additive; `shm_size: 1g` for browser tools, `/opt/data` on the `hermes-data` volume, ports 8642/9119, `hivemind-network`).

## ⛔ Deploy is human-gated (Phase 2 BLOCKED here)
Booting this on prod = a deliberate infra decision the autonomous runner will NOT take alone:
1. Pulls a **new third-party image** (`nousresearch/hermes-agent`) onto the Hetzner box.
2. Mutates the **live Coolify stack** (new service, new volume, exposed ports 8642/9119).
3. Requires secrets set in Coolify env: `API_SERVER_KEY` (`openssl rand -hex 32`), dashboard auth.

### Operator steps to unblock (run once, with backup + rollback)
```bash
# 1. Set secrets in Coolify env: API_SERVER_KEY, HERMES_DASHBOARD_BASIC_AUTH_*
# 2. Pull + smoke-test the image in ISOLATION first (no stack impact):
ssh myserver "docker run -d --name hm-hermes-smoke --rm --shm-size=1g \
  -e API_SERVER_ENABLED=true -e API_SERVER_HOST=0.0.0.0 -e API_SERVER_KEY=\$(openssl rand -hex 32) \
  -p 18642:8642 nousresearch/hermes-agent:latest gateway run"
ssh myserver "sleep 20 && curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18642/ ; docker rm -f hm-hermes-smoke"
# 3. If smoke OK → apply the compose change via Coolify (redeploy), confirm
#    container healthy, dashboard reachable, /opt/data persists across restart.
```
Verify gates: `:8642` answers · dashboard `:9119` loads · stop+start container → profiles/sessions survive (volume persisted). Rollback = remove the `hm-hermes` service + redeploy.

## Resource / safety notes
- Browser (Playwright) tools need `--shm-size=1g`; 2–4 GB RAM, ~2 CPU.
- Do NOT expose 8642/9119 publicly without auth — gateway has `API_SERVER_KEY`, dashboard has basic-auth/OIDC.
- Hermes local `memories/` is NOT the source of truth — HiveMind MCP is (Phase 3).
