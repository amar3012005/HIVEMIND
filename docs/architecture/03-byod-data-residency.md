# 03 — BYOD data residency (self-host)

The customer runs only their **data** on their box; our engine + dashboard stay central. End-to-end:
onboarding → enroll → tunnel → register → schema → live.

## URL map
### Engine (central, public) — the SAME for everyone
| URL | service |
|-----|---------|
| `hivemind.<domain>` | FE / dashboard |
| `api.hivemind.<domain>` | control-plane (auth, bootstrap, orgs, billing, **`/v1/selfhost/*`**) |
| `core.hivemind.<domain>` | core engine API |
| `nango.hivemind.<domain>` | connectors |

### Engine internal (Docker DNS)
`postgres:5432` · `qdrant:6333` · `redis:6379` · `core:3000` · `control:3000` · `employees:8060` ·
`nango:8080` · `docling:5001` · `tara:8090` · `hermes:8642`.

### Customer data (per-org, via tunnel) — the ONLY URLs that differ
The customer registers two endpoints; core uses them as that org's `DATABASE_URL` / `QDRANT_URL`:
- `pgUrl` → `postgresql://…@<tunnel>:5432/hivemind`
- `qdrantUrl` → `http://<tunnel>:6333`

## The flow
```
1. FE onboarding (central): user picks "Self-host" → SelfHostSetup screen → Mint API key
   (apiClient.createApiKey — same key as Settings → API Keys).

2. Customer box:  git clone --branch byod --single-branch <repo>  &&  ./setup.sh
   setup.sh:
     a. prompt API key
     b. POST api.<domain>/v1/selfhost/enroll {apiKey}  → validates key → { orgId }
     c. docker compose up:  Postgres + Qdrant + outbound tunnel (Tailscale)
     d. resolve the tunnel-reachable host
     e. POST api.<domain>/v1/selfhost/register {apiKey, pgUrl, qdrantUrl}

3. control-plane /v1/selfhost/register:
     a. validate key → orgId
     b. write { orgId: {pgUrl, qdrantUrl} } into the shared registry file (MNEME_AGENT_REGISTRY_FILE)
     c. apply the CURATED memory schema to the customer PG (prisma db execute --file byod-memory-schema.sql)

4. core (per request/job for that org):
     memory → customer PG (split client) · vectors → customer Qdrant (qbase)
     global user/org/key info → central PG · managed orgs unaffected
```

## The components
| component | file / location | role |
|-----------|-----------------|------|
| FE onboarding | `frontend/Da-vinci/.../SelfHostSetup.jsx` + `Onboarding.jsx` | Managed/Self-host choice + 2-step (clone+run, mint key) |
| enroll/register | `control-plane-server.js` `/v1/selfhost/{enroll,register}` | key→org, record stores, apply schema |
| registry | `MNEME_AGENT_REGISTRY_FILE` (shared volume; written by control, read by core via `remote-backend`) | org → {pgUrl, qdrantUrl, url} |
| customer bundle | `byod/` (+ `byod` branch) | `docker-compose.byod.yml` (PG+Qdrant+tunnel), `setup.sh`, `memory-schema.sql`, README |
| curated schema | `byod/memory-schema.sql` (+ shipped at `core/byod-memory-schema.sql`) | 14 memory tables, **FKs to global tables relaxed**, triggers stripped, enums+extensions included — clean on a fresh PG |

## Why the curated schema (not the full migrate)
The full prod schema can't drop onto a fresh customer PG: (1) cross-schema FK ordering, (2) the memory
tables **FK to global tables** (`org_id`→organizations, `user_id`→users) we keep central. So
`byod/memory-schema.sql` is the 14 memory tables `pg_dump`'d from prod with those FKs **relaxed** (plain
columns — integrity at the app layer, like `.amr`), triggers stripped (the engine does that logic),
plus the enum types + extensions. **Verified clean on a fresh PG: 14 tables, insert works, no FK block.**

## Tunnel transport
Bundle ships **Tailscale** (WireGuard, E2E, raw TCP for Postgres + Qdrant). cloudflared can tunnel the
Qdrant HTTP port but Postgres is raw TCP → Tailscale (or `cloudflared access tcp`). Outbound-only from
the customer; no inbound ports.

## Activation (deliberate — left OFF in prod)
Self-host is **inert** until `MNEME_AGENT_REGISTRY_FILE` is set on `hm-core` **and** `hm-control`
(shared volume, same path). Empty registry → every org is managed → zero behavior change. Set it to
enable self-host onboarding fleet-wide.

## What stays central regardless
Auth (Google), billing, identity, API-key minting, PQC signing key, the FE, all engine compute.
The customer box holds only their memory data.
