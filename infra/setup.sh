#!/usr/bin/env bash
# HIVEMIND fresh-box bring-up. Idempotent. Run from the repo root on a clean Hetzner/Docker host:
#   git clone <repo> hivemind && cd hivemind && ./infra/setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="docker compose -f $ROOT/infra/docker-compose.hetzner.yml"
ENV_FILE="$ROOT/.env"

log() { printf '\033[1;36m[setup]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[setup] %s\033[0m\n' "$*" >&2; exit 1; }

# 1. prerequisites
command -v docker >/dev/null || die "docker not installed. Install Docker Engine + compose plugin first."
docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin required."

# 2. .env — generate secrets on first run, never overwrite
gen() { openssl rand -hex "${1:-32}"; }
if [ ! -f "$ENV_FILE" ]; then
  log "no .env — generating with fresh secrets (fill provider keys after)"
  cat > "$ENV_FILE" <<EOF
# ── generated secrets (do not commit) ──
POSTGRES_USER=hivemind_user
POSTGRES_PASSWORD=$(gen 24)
POSTGRES_DB=hivemind
REDIS_PASSWORD=$(gen 24)
QDRANT_API_KEY=$(gen 24)
SESSION_SECRET=$(gen 32)
HIVEMIND_ADMIN_SECRET=$(gen 32)
HIVEMIND_MASTER_API_KEY=hm_master_$(gen 24)
NANGO_SECRET_KEY=$(gen 24)
# ── .amr memory engine ──  (empty = hybrid for all; set an orgId or "*" to enable .amr)
MNEME_ORGS=
MNEME_DATA_ROOT=/app/data/mneme
# ── model providers — FILL THESE ──
GROQ_API_KEY=
OPENROUTER_API_KEY=
OPENAI_API_KEY=
MISTRAL_API_KEY=
ANTHROPIC_API_KEY=
VERSION=latest
EOF
  log ".env created. Edit it to add GROQ/OPENROUTER keys, then re-run this script."
  log "secrets generated; DB/Redis/Qdrant/master-key are set. Provider keys are blank."
fi

# 3. fail fast if the must-have provider key is missing
grep -qE '^GROQ_API_KEY=.+' "$ENV_FILE" || die "GROQ_API_KEY empty in .env — required for distillation/recall. Fill it, re-run."

# 4. build + up
log "building images + starting stack…"
$COMPOSE --env-file "$ENV_FILE" up -d --build

# 5. wait for Postgres + core health
log "waiting for postgres…"
for i in $(seq 1 30); do
  $COMPOSE exec -T postgres pg_isready -U hivemind_user -d hivemind >/dev/null 2>&1 && break
  [ "$i" = 30 ] && die "postgres did not become healthy"; sleep 3
done

# 6. schema — prisma migrate (core image ships the schema + client)
log "applying database schema…"
$COMPOSE exec -T core npx prisma migrate deploy 2>/dev/null || \
  $COMPOSE exec -T core npx prisma db push --skip-generate 2>/dev/null || \
  log "WARN: prisma migrate/push failed — run it manually inside hm-core"

# 7. wait for core /health
log "waiting for core /health…"
for i in $(seq 1 30); do
  $COMPOSE exec -T core node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break
  [ "$i" = 30 ] && die "core /health never came up — check: $COMPOSE logs core"; sleep 3
done

log "✅ stack up. core:${CORE_PORT:-2026}  control:${CONTROL_PORT:-2027}  nango:${NANGO_PORT:-3003}"
log "next: put a reverse proxy (Caddy/Traefik) in front of :2026, point your domain, set MNEME_ORGS to enable .amr per org."
log "BACK UP the hivemind-data volume — it holds the .amr files (sole copy for .amr orgs)."
