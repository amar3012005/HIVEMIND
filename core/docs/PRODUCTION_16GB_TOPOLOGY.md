# Production Topology for 16 GB RAM

This document maps the current HIVEMIND container inventory to the smallest
production topology that stays stable on a 16 GB machine.

It is intentionally pragmatic:

- keep the HTTP path fast
- keep stateful data protected
- keep heavy sidecars away from the request path
- use the new `HIVEMIND_RUNTIME_ROLE` split for `hm-core`

## Current Container Inventory

The current stack discussed for production is:

- `hm-byod-broker`
- `hm-caddy`
- `hm-control`
- `hm-core`
- `hm-docling`
- `hm-employees`
- `hm-fe`
- `hm-nango`
- `hm-playwright`
- `hm-postgres`
- `hm-qdrant`
- `hm-redis`
- `tara-aaas`
- `tara-deepgram`
- `waitlist-relay`

## What a 16 GB Node Cannot Safely Do

A single 16 GB box should **not** be the long-term home for all of these at
once under real traffic.

The worst combination is:

- `hm-postgres`
- `hm-qdrant`
- `hm-docling`
- `hm-playwright`
- `hm-employees`
- `hm-core`

Those compete for memory, CPU, file cache, and IO in exactly the places where
production hangs start:

- Postgres loses cache and starts stalling
- Qdrant competes for RAM and IO
- Docling/Playwright spike memory unpredictably
- Employees/agent turns hold CPU while app latency rises
- core request workers get pinned on long work

## Recommended Minimum Production Shape

### Node A — App Path

Run the latency-sensitive path here:

- `hm-caddy`
- `hm-fe`
- `hm-control`
- `hm-core-app`
- `hm-core-maintenance` only if there is no second worker node
- `hm-redis`

Runtime settings:

- `hm-core-app`: `HIVEMIND_RUNTIME_ROLE=app`
- `hm-core-maintenance`: `HIVEMIND_RUNTIME_ROLE=maintenance`
- both core roles: `HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS=true`

### Node B — Heavy Workers

Move bursty / non-latency-sensitive services here:

- `hm-docling`
- `hm-employees`
- `hm-playwright`
- `hm-byod-broker`
- `hm-nango`
- `tara-aaas`
- `tara-deepgram`
- `waitlist-relay`

### Managed or Separate Data Node

Prefer managed or isolated stateful services:

- `hm-postgres`
- `hm-qdrant`

If they must be self-hosted, do not colocate both with docling/playwright on a
16 GB box.

## Best Split by Budget

### Best practical split

- Node A, 8-12 GB: `hm-caddy`, `hm-fe`, `hm-control`, `hm-core-app`, `hm-redis`
- Node B, 8-16 GB: `hm-core-maintenance`, `hm-employees`, `hm-docling`, `hm-playwright`, `hm-byod-broker`, `hm-nango`, `tara-*`, `waitlist-relay`
- Managed or isolated: `hm-postgres`, `hm-qdrant`

### If forced to use one 16 GB box

Keep always-on:

- `hm-caddy`
- `hm-fe`
- `hm-control`
- `hm-core-app`
- `hm-core-maintenance`
- `hm-redis`
- `hm-postgres`
- `hm-qdrant`

Do **not** keep always-on unless traffic is tiny:

- `hm-docling`
- `hm-playwright`
- `hm-employees`
- `tara-aaas`
- `tara-deepgram`
- `waitlist-relay`

Those should be disabled, moved, or brought up separately when needed.

## Memory Priority

If a single-node deployment is unavoidable, protect these first:

1. `hm-postgres`
2. `hm-qdrant`
3. `hm-core-app`
4. `hm-control`
5. `hm-redis`
6. `hm-fe`
7. `hm-caddy`

Cap aggressively:

- `hm-docling`
- `hm-playwright`
- `hm-employees`
- `tara-aaas`
- `tara-deepgram`

## Resource Heuristic for One 16 GB Box

Rough ceiling targets:

- `hm-postgres`: 2-3 GB
- `hm-qdrant`: 2-3 GB
- `hm-core-app`: 1.5-2 GB
- `hm-core-maintenance`: 0.5-1 GB
- `hm-control`: 0.5-1 GB
- `hm-redis`: 0.5 GB
- `hm-fe` + `hm-caddy`: <0.5 GB combined

That leaves too little safe headroom for docling/playwright/employees to share
the same node comfortably under real use. That is the reason for the split.

## Failure Isolation Rules

The app path should continue functioning if these are down:

- `hm-docling`
- `hm-playwright`
- `hm-employees`
- `tara-aaas`
- `tara-deepgram`
- `waitlist-relay`

If chat, login, basic recall, or standard dashboard usage break when one of
those is down, the stack is still too tightly coupled.

## Branch-Specific Runtime Rules

This branch introduced:

- `HIVEMIND_RUNTIME_ROLE=app`
- `HIVEMIND_RUNTIME_ROLE=maintenance`
- `HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS=true`

Use them in production.

Do not run `hm-core` as an all-in-one process on the main app node if you can
avoid it.

## Parallel vNext Canary

`infra/docker-compose.next.yml` provides a parallel test stack without
touching the production `hivemind` Compose project. It uses:

- B2B hosts: `b2b-next-core` and `b2b-next-api`
- B2C hosts: `b2c-next-core` and `b2c-next-api`
- separate `postgres-next`, `qdrant-next`, and `redis-next` volumes
- loopback-only ports `2126/2127` (B2B) and `2226/2227` (B2C)
- hard CPU/memory ceilings plus independent B2B/B2C app, maintenance, and
  HyperAgent pools

Start one profile first, never both blindly:

```bash
docker compose --env-file infra/.env.next -f infra/docker-compose.next.yml --profile b2b up -d
```

The vNext environment must use generated `NEXT_*` secrets and its own data
volumes. It must never use the production `hivemind-data` volume, ports
`2026/2027`, or production database URL.

## Deployment Order

1. Move `hm-core` to split app/maintenance roles.
2. Force queued KB uploads.
3. Keep `hm-control` separate from heavy worker services.
4. Move `hm-docling`, `hm-playwright`, and `hm-employees` off the app node.
5. Move `hm-postgres` and `hm-qdrant` to managed or isolated hosts if possible.

## What This Branch Already Supports

The production-hardening branch already contains:

- app vs maintenance runtime split
- queue-required KB upload mode
- HyperAgent stream fanout seam
- deployment manifests with separate app and maintenance services

This document is the operational mapping for those code changes on a 16 GB
production footprint.
