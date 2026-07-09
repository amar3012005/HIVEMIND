# vNext B2B/B2C Canary Runbook

This starts an isolated test stack beside the live `hivemind` Compose project.
It never changes the production checkout, volumes, or `2026/2027` routes.

## Preconditions

- Confirm production health first: `curl -fsS http://127.0.0.1:2026/health` and
  `curl -fsS http://127.0.0.1:2027/v1/bootstrap`.
- Build from a clean clone at `/root/hivemind-next`, not `/root/hivemind`.
- Generate new `NEXT_*` secrets in `/root/hivemind-next/infra/.env.next`.
- Do not copy production database, Redis, Qdrant, or `hivemind-data` volumes.

## Build And Start

```bash
git clone --branch codex/production-hardening-runtime \
  https://github.com/amar3012005/HIVEMIND.git /root/hivemind-next
cd /root/hivemind-next

docker build -f Dockerfile.production -t hivemind/core-api:hivemind-next-<sha> .
docker build -f Dockerfile.control-plane -t hivemind/control-plane:hivemind-next-<sha> .
docker build -t hivemind/employees:hivemind-next-<sha> employees-service

cp infra/.env.next.example infra/.env.next
# Replace every placeholder in infra/.env.next with a unique random value.
docker compose --env-file infra/.env.next -f infra/docker-compose.next.yml --profile b2b config --quiet
docker compose --env-file infra/.env.next -f infra/docker-compose.next.yml up -d postgres-next qdrant-next redis-next

# Bootstrap only the authoritative schema structure. This copies no customer rows.
# Do not run `prisma migrate deploy` for a fresh canary yet: historical migrations
# contain public-schema references that do not replay against hivemind.
docker exec hm-postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema=hivemind --schema-only \
  --no-owner --no-privileges' \
  | docker compose --env-file infra/.env.next -f infra/docker-compose.next.yml \
    exec -T postgres-next psql -v ON_ERROR_STOP=1 -U hivemind_next -d hivemind_next

docker compose --env-file infra/.env.next -f infra/docker-compose.next.yml --profile b2b up -d
```

Start B2C only after B2B remains healthy under synthetic load:

```bash
docker compose --env-file infra/.env.next -f infra/docker-compose.next.yml --profile b2c up -d
```

## Verification

```bash
curl -fsS http://127.0.0.1:2126/health
curl -fsS http://127.0.0.1:2127/v1/bootstrap
curl -fsS http://127.0.0.1:2226/health
curl -fsS http://127.0.0.1:2227/v1/bootstrap
docker stats --no-stream
```

Only after loopback checks pass and DNS resolves for all four hosts, append
`infra/Caddyfile.next.snippet` to the live Caddyfile and restart `hm-caddy`.
Use `docker restart hm-caddy`; do not use Caddy reload.

## Rollback

The production stack is independent. Remove only the vNext project:

```bash
cd /root/hivemind-next
docker compose --env-file infra/.env.next -f infra/docker-compose.next.yml --profile b2b --profile b2c down
```

Do not pass `-v` during rollback. Keep vNext volumes until the test evidence is
reviewed or an explicit cleanup decision is made.
