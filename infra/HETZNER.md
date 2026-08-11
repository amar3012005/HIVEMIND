# Deploy HIVEMIND on a fresh Hetzner box

Portable, Coolify-independent. The whole stack from one `git clone` + one script.

## What you get
8 services on internal Docker DNS: **core** (engine), **control-plane**, **employees**, **postgres-age**
(PG15 + Apache AGE graph), **qdrant** v1.12.4, **redis**, **nango** (connectors), **docling** (PDF parse).
The `.amr` memory engine ships inside the core image — enabled per-org by a flag, no extra service.

## 1. Box prep (Ubuntu 22.04+, ≥8 GB RAM, ≥80 GB disk)
```bash
curl -fsSL https://get.docker.com | sh           # Docker Engine + compose v2
git clone <repo-url> hivemind && cd hivemind
```

## 2. Bring up
```bash
./infra/setup.sh        # 1st run: writes .env with generated secrets, then stops
# edit .env → fill GROQ_API_KEY + OPENROUTER_API_KEY
./infra/setup.sh        # 2nd run: build → up → migrate → health-check
```
`setup.sh` is idempotent: generates DB/Redis/Qdrant/master secrets once, builds, waits for Postgres,
applies the Prisma schema, waits for `core /health`.

## 3. Edge (TLS + domain)
Put Caddy or Traefik in front of `core:3000` (host port `:2026`). Reuse `infra/traefik/` or:
```
yourdomain.com { reverse_proxy localhost:2026 }
```

## 4. Enable `.amr` for an org
`.amr` is off by default (hybrid Postgres+Qdrant for everyone). To make a tenant's memory a single
`.amr` file:
```
# in .env
MNEME_ORGS=<orgId>        # csv for several, "*" for all
```
`docker compose -f infra/docker-compose.hetzner.yml up -d core` to apply. The org's memory subgraph +
vectors + typed graph now live in `/app/data/mneme/org_<id>.amr` — no Postgres rows for that org.

## 5. Backups — REQUIRED for `.amr`
The `hivemind-data` volume holds the `.amr` files, which are the **sole copy** for an `.amr` org
(flag-off is NOT a safe rollback). Snapshot it:
```bash
docker run --rm -v hivemind_hivemind-data:/data -v $PWD:/out alpine \
  tar czf /out/amr-backup-$(date +%F).tgz -C /data .
```
Schedule daily (cron) + ship off-box. Postgres has `offen/docker-volume-backup` patterns in
`docker-compose.coolify.yml` you can port.

## Operate
| action | command |
|---|---|
| logs | `docker compose -f infra/docker-compose.hetzner.yml logs -f core` |
| restart core | `… up -d core` |
| migrate | `… exec core npx prisma migrate deploy` |
| .amr status | `… exec core ls -la /app/data/mneme/` |
| smoke recall | `curl -s -XPOST localhost:2026/api/memories/search -H 'X-API-Key: <key>' -d '{"query":"test"}'` |

## Notes
- Single box, single replica. `.amr` is single-writer (flock) — do NOT scale `core` to 2 replicas
  against the same `.amr` volume without a writer election (see docs/BYOD-ARCHITECTURE.md §9 G5).
- This compose supersedes the stale `infra/docker-compose.production.yml` (March, pre-mneme).
- For customer self-host where data must stay on THEIR box while our engine stays central, see the
  BYOD remote-agent design in `docs/BYOD-ARCHITECTURE.md` (next phase).
