#!/usr/bin/env bash
# HIVEMIND engine bring-up — stands up the FULL central engine on a fresh box (ours, or a private
# deployment). Standalone: NO enrollment, no external calls. The customer DATA bundle is separate
# (byod/, the `byod` branch) — this is the engine.
#   git clone --branch infra --single-branch <repo> hivemind && cd hivemind && ./setup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="docker compose -f $ROOT/infra/docker-compose.hetzner.yml"
ENV_FILE="$ROOT/.env"
log(){ printf '\033[1;36m[hivemind]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[hivemind] %s\033[0m\n' "$*" >&2; exit 1; }
command -v docker >/dev/null || die "install Docker (curl -fsSL https://get.docker.com | sh)"
docker compose version >/dev/null 2>&1 || die "docker compose v2 required"
gen(){ openssl rand -hex "${1:-32}"; }

if [ ! -f "$ENV_FILE" ]; then
  log "first run — generating .env with fresh secrets"
  cat > "$ENV_FILE" <<EOF
# ── generated secrets ──
POSTGRES_USER=hivemind_user
POSTGRES_PASSWORD=$(gen 24)
POSTGRES_DB=hivemind
REDIS_PASSWORD=$(gen 24)
QDRANT_API_KEY=$(gen 24)
SESSION_SECRET=$(gen 32)
HIVEMIND_ADMIN_SECRET=$(gen 32)
HIVEMIND_MASTER_API_KEY=hm_master_$(gen 24)
NANGO_SECRET_KEY=$(gen 24)
# ── storage: hybrid (Postgres+Qdrant) by default. Set MNEME_ORGS=<orgId>|"*" to enable .amr (x86 only;
#    on arm hosts keep hybrid until an arm64 .amr binding is built). ──
MNEME_ORGS=
MNEME_MODE=dual
MNEME_DATA_ROOT=/app/data/mneme
# ── self-host data residency: leave UNSET for a normal engine. Set to a shared path + run the broker
#    only when offering BYOD (so core+control share one registry file). ──
# MNEME_AGENT_REGISTRY_FILE=/app/data/byod-agents.json
# ── model providers — FILL THESE ──
GROQ_API_KEY=
OPENROUTER_API_KEY=
OPENAI_API_KEY=
MISTRAL_API_KEY=
ANTHROPIC_API_KEY=
VERSION=latest
EOF
  log ".env written. Fill GROQ_API_KEY + OPENROUTER_API_KEY, then re-run ./setup.sh"
  exit 0
fi
set -a; . "$ENV_FILE"; set +a
grep -qE '^GROQ_API_KEY=.+' "$ENV_FILE" || die "GROQ_API_KEY empty in $ENV_FILE — fill it, re-run"

log "building + starting the engine…"
$COMPOSE --env-file "$ENV_FILE" up -d --build

log "waiting for postgres…"; for i in $(seq 1 30); do $COMPOSE exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 && break; [ "$i" = 30 ] && die "postgres unhealthy"; sleep 3; done
log "applying schema…"; $COMPOSE exec -T core npx prisma migrate deploy 2>/dev/null || $COMPOSE exec -T core npx prisma db push --skip-generate 2>/dev/null || log "WARN: run prisma migrate manually in hm-core"
log "waiting for core /health…"; for i in $(seq 1 30); do $COMPOSE exec -T core node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break; [ "$i" = 30 ] && die "core unhealthy — $COMPOSE logs core"; sleep 3; done

log "✅ engine up. core:${CORE_PORT:-2026}  control:${CONTROL_PORT:-2027}  nango:${NANGO_PORT:-3003}"
log "Put a reverse proxy (Caddy/Traefik) on :2026 + :2027, point your domains. The dashboard is the"
log "central FE (hivemind.<domain>). BACK UP the hivemind-data volume if you enabled .amr."
