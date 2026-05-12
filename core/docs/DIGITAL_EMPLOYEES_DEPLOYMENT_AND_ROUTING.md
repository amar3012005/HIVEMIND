# Digital Employees Deployment And Routing

## Summary

This document records the production work that stabilized Digital Employees,
fixed the migration path, repaired Slack connector behavior, moved the
employees runtime under Coolify management, and replaced the abandoned
`employees.hivemind.davinciai.eu` public edge with
`https://core.hivemind.davinciai.eu:8061`.

Current production shape:

- `hm-employees` is the Python sidecar service, internal on `8060`
- `hivemind-caddy-employees` is a dedicated TLS sidecar, external on `8061`
- Public admin/health endpoint is `https://core.hivemind.davinciai.eu:8061`
- TLS cert is reused from `core.hivemind.davinciai.eu`
- Coolify remains the source of truth for the running compose stack

## What was failing

### 1. Prisma migrations failed from the host shell

Running this from the VPS host failed repeatedly:

```bash
cd core && npx prisma migrate deploy
```

Error:

```text
P1001: Can't reach database server at postgres:5432
```

Root cause:

- the Prisma config used `postgres` as the database host
- `postgres` resolves inside Docker networking, not from the host shell
- migrations were safe inside containers but not safe from normal deploy shell usage

### 2. Slack connector state was degraded in the UI

The connectors page showed Slack as broken because token/scope state was not
being mapped correctly and the expected scopes were incomplete.

### 3. Employees sidecar deployment was unstable

The initial `hm-employees` path had several issues:

- runtime bootstrap/config gaps
- UUID normalization bugs when loading bootstrap snapshots
- factory/runtime issues in the Python sidecar
- vendored SlackAgents import-time side effects
- incorrect or incomplete employee filtering during bootstrap

### 4. Public routing for `employees.hivemind.davinciai.eu` became too costly

The original plan was to expose the service at its own hostname. That path was
not a good fit for the actual production edge:

- public `:443` is owned by `coolify-proxy` (Traefik), not host Caddy
- existing production certs were manual Certbot DNS certs, not Traefik-managed
- proxy-visible cert mount paths mattered more than host cert paths
- stale Docker labels created conflicting routes
- the edge config became harder to reason about than the service itself

The final decision was to stop fighting the separate hostname and expose the
service on the already-valid `core.hivemind.davinciai.eu` certificate with a
new port.

## Final architecture

### Internal services

- `hm-core` serves the main Node core runtime
- `hm-control-plane` serves the API/control-plane surface
- `hm-employees` serves the Python Digital Employees runtime on internal port `8060`

### Public edges

- `https://api.hivemind.davinciai.eu` terminates through the API sidecar/proxy chain
- `https://core.hivemind.davinciai.eu` terminates through the core sidecar/proxy chain
- `https://core.hivemind.davinciai.eu:8061` now terminates through a dedicated employees Caddy sidecar

### Why port `8061`

At the time of the change:

- `8040` was already used by `hivemind-caddy-api`
- `8050` was already used by `hivemind-caddy`
- `8060` was already used on the host by `hivemind-caddy-csi`
- `hm-employees` itself only needed to stay internal on container port `8060`

`8061` was the clean unused host port.

## Files changed

### Migration safety

- `core/scripts/prisma-migrate-deploy.mjs`

Behavior:

- reads env like normal Prisma deploy
- detects when the configured DB host is not reachable from the host shell
- falls back to running `prisma migrate deploy` via `docker exec hm-core`

This makes migrations safe from both Docker context and host-shell deploy flows.

### Coolify and edge config

- `docker-compose.coolify.yml`
- `/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/docker-compose.yaml`
- `Caddyfile.employees`

`Caddyfile.employees`:

```caddy
{
    admin off
}

https://core.hivemind.davinciai.eu:443 {
    reverse_proxy hm-employees:8060
    tls /etc/letsencrypt/live/core.hivemind.davinciai.eu/fullchain.pem /etc/letsencrypt/live/core.hivemind.davinciai.eu/privkey.pem
}
```

The new compose service is `caddy-employees`, publishing:

```yaml
ports:
  - '8061:443'
```

### Control-plane and employee runtime stabilization

Key touched areas during the rollout:

- `core/src/control-plane-server.js`
- `core/src/employees/store.js`
- `employees-service/src/hivemind_employees/slack/gateway.py`
- `employees-service/src/hivemind_employees/db.py`
- `employees-service/src/hivemind_employees/agents/factory.py`
- `employees-service/vendor/slackagents/...`

Important resulting behavior:

- bootstrap returns the scoped API key and Slack bot token correctly
- employee list for bootstrap includes the right active statuses
- UUIDs are normalized correctly between Postgres snapshots and Python runtime objects
- the Slack gateway can load workspaces and report status reliably
- SlackAgents no longer crashes during import because heavy initialization is deferred

### Slack connector and OAuth fixes

Relevant areas:

- `core/src/connectors/providers/slack/oauth.js`
- `frontend/Da-vinci/src/components/hivemind/app/pages/Connectors.jsx`

Fixes included:

- adding `chat:write.public`
- adding `reactions:write`
- mapping expired or invalid token state to a reconnect/reauth UX

## Current deployment workflow

### 1. Source of truth

Keep these files aligned:

- source compose: `/opt/HIVEMIND/docker-compose.coolify.yml`
- live Coolify compose: `/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/docker-compose.yaml`
- employees TLS sidecar config: `/opt/HIVEMIND/Caddyfile.employees`

### 2. Safe migration command

Use this from the host shell:

```bash
cd /opt/HIVEMIND/core
node scripts/prisma-migrate-deploy.mjs
```

Do not rely on raw `npx prisma migrate deploy` from the host shell unless the
configured DB host is resolvable from the host.

### 3. Bring up the employees edge sidecar

```bash
docker compose -f /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/docker-compose.yaml up -d --no-deps caddy-employees
```

### 4. Verify containers

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'hivemind-caddy-employees|hm-employees'
```

Expected shape:

- `hivemind-caddy-employees` publishes `0.0.0.0:8061->443/tcp`
- `hm-employees` stays internal and healthy on `8060/tcp`

## Verification steps

### Public endpoint verification

```bash
curl -sk https://core.hivemind.davinciai.eu:8061/health
```

Expected response shape:

```json
{"ok":true,"version":"0.1.0","replica_id":"rep1","replica_count":1,"employees":0}
```

Note:

- `HEAD /health` returns `405` because the endpoint only allows `GET`
- that is expected and not a regression

### Internal backend verification

```bash
docker exec coolify-proxy wget -qO- http://hm-employees:8060/health
```

### Caddy sidecar logs

```bash
docker logs --tail 40 hivemind-caddy-employees
```

Healthy startup indicators:

- config loaded from `/etc/caddy/Caddyfile`
- automatic certificate management skipped because matching certs are already loaded
- HTTP server running on `:443`

## Why `scripts/deploy.sh employees` felt slow

The manual path was slow because it did too much mutable setup work at deploy
time instead of reusing a built image:

- package install work happened during deployment
- Python dependency setup was heavier than the normal Node service restart path
- health checks had to wait for sidecar startup and bootstrap completion
- repeated manual deploys bypassed Coolify's normal image/build lifecycle

Moving `hm-employees` into the Coolify-managed compose flow removes most of that
cost because the runtime becomes an image rollout plus a targeted restart.

## Why the separate employees hostname was abandoned

This is the main operational lesson from the work.

`employees.hivemind.davinciai.eu` was technically possible, but it created a
lot of edge complexity relative to the value:

- Traefik file-provider config and Docker labels could conflict
- the proxy only had access to certs mounted inside `/data/coolify/proxy`
- the existing cert issuance flow was manual DNS, not the same as the proxy's ACME story
- stale labels on old containers could keep reviving bad routers
- debugging edge ownership across Traefik and nested Caddy instances cost too much time

Using `core.hivemind.davinciai.eu:8061` avoided all of that while keeping valid
TLS and a simple, inspectable proxy path.

## Recommended operational rules

1. Keep `hm-employees` internal-only and put public exposure behind a small dedicated proxy.
2. Reuse an already-valid certificate/domain when a new dedicated hostname adds no product value.
3. Validate the resolved live Coolify compose, not only the source YAML in git.
4. Remove stale Docker labels by recreating containers, not by assuming compose edits are enough.
5. Use the migration wrapper for host-shell deploys.

## Follow-up work

The following cleanup is still recommended:

1. Replace any remaining references to `employees.hivemind.davinciai.eu` in non-core docs.
2. Update admin UI or bootstrap config surfaces if any of them still display the old public hostname.
3. Add a lightweight smoke test script that checks `/health`, `/v1/employees`, and `/api/employees/slack-action` after deploy.
4. Decide whether the abandoned employees-domain cert and proxy config should be archived or deleted.

## Quick commands

```bash
# Safe Prisma deploy
cd /opt/HIVEMIND/core && node scripts/prisma-migrate-deploy.mjs

# Recreate only employees TLS sidecar
docker compose -f /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/docker-compose.yaml up -d --no-deps caddy-employees

# Check public health
curl -sk https://core.hivemind.davinciai.eu:8061/health

# Check sidecar logs
docker logs --tail 40 hivemind-caddy-employees
```