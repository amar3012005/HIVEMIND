# Platform Registry D1 migration

`workers/platform-control` is an additive, disabled-by-default authority candidate for permanent platform control-plane records. It does not own memory, evidence, vectors, documents, raw API keys, OAuth refresh tokens, encryption material, or user session cookies.

## Modes

- `off` (default): PostgreSQL only; no Worker traffic.
- `shadow`: PostgreSQL remains authoritative; mirror writes and compare results.
- `dual_write`: PostgreSQL remains authoritative while durable reconciliation is required before cutover.
- `authoritative`: D1 commits first; PostgreSQL is a projection only.

Create the production database once with EU jurisdiction: `wrangler d1 create hivemind-platform-registry-eu --jurisdiction=eu`. Put the returned id in `wrangler.jsonc`; never commit credentials. Configure `PLATFORM_REGISTRY_ADMISSION_SECRET` as a Worker secret and use a Cloudflare Access service token for the server-to-Worker route.

Production cutover is forbidden until import/reconciliation, server-loss restore, authenticated bootstrap, invitation, membership, API-key, entitlement, and BYOD/AMR parity checks pass. Keep PostgreSQL projections for 30 days after authority cutover.
