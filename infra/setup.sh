#!/usr/bin/env bash
# HIVEMIND self-host bring-up. Runs the FULL engine on YOUR server, linked to HIVEMIND by your API key.
#   git clone --branch infra --single-branch <repo> hivemind && cd hivemind && ./setup.sh
# Asks for the API key you mint in the dashboard (Settings → Self-host). The engine validates it against
# HIVEMIND central, learns which org this instance serves, and comes up configured + linked. Pick your
# storage at first run: hybrid (Postgres+Qdrant) or .amr (single-file memory engine, +Postgres).
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.hetzner.yml"
CENTRAL="${HIVEMIND_CENTRAL_URL:-https://api.davinciai.eu}"   # where you minted the key
ENV_FILE="../.env"
log(){ printf '\033[1;36m[hivemind]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[hivemind] %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "install Docker first (curl -fsSL https://get.docker.com | sh)"
docker compose version >/dev/null 2>&1 || die "docker compose v2 required"

gen(){ openssl rand -hex "${1:-32}"; }

if [ ! -f "$ENV_FILE" ]; then
  # 1. API key → validate against central → learn the org this instance is for
  printf 'Paste your HIVEMIND API key (dashboard → Settings → Self-host): '
  read -r API_KEY
  [ -n "$API_KEY" ] || die "no key entered"
  log "validating key against $CENTRAL …"
  RESP="$(curl -fsS -X POST "$CENTRAL/v1/selfhost/enroll" -H 'content-type: application/json' \
    -d "{\"apiKey\":\"$API_KEY\"}")" || die "key validation failed — check the key + that $CENTRAL is reachable"
  ORG_ID="$(printf '%s' "$RESP" | grep -oE '"orgId":"[^"]+"' | cut -d'"' -f4)"
  [ -n "$ORG_ID" ] || die "central did not return an org for this key: $RESP"
  log "key OK → this instance serves org $ORG_ID"

  # 2. storage choice
  printf 'Storage engine — [1] hybrid (Postgres+Qdrant)  [2] .amr (single-file +Postgres) : '
  read -r CHOICE
  if [ "$CHOICE" = "2" ]; then MNEME_ORGS="$ORG_ID"; MNEME_MODE="dual"; log "storage: .amr (org $ORG_ID) + Postgres";
  else MNEME_ORGS=""; MNEME_MODE="dual"; log "storage: hybrid (Postgres+Qdrant)"; fi

  # 3. write env (generated secrets + the org link + storage choice)
  cat > "$ENV_FILE" <<EOF
# ── self-host identity (from your API key) ──
HIVEMIND_ORG_ID=$ORG_ID
HIVEMIND_API_KEY=$API_KEY
HIVEMIND_CENTRAL_URL=$CENTRAL
# ── storage ──
MNEME_ORGS=$MNEME_ORGS
MNEME_MODE=$MNEME_MODE
MNEME_DATA_ROOT=/app/data/mneme
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
# ── providers — FILL THESE ──
GROQ_API_KEY=
OPENROUTER_API_KEY=
VERSION=latest
EOF
  log ".env written. Add GROQ_API_KEY + OPENROUTER_API_KEY to $ENV_FILE, then re-run ./setup.sh"
  exit 0
fi

set -a; . "$ENV_FILE"; set +a
grep -qE '^GROQ_API_KEY=.+' "$ENV_FILE" || die "GROQ_API_KEY empty in $ENV_FILE — fill it, re-run"

# 4. bring up the full stack, configured for the org
log "starting the engine for org $HIVEMIND_ORG_ID (storage: ${MNEME_ORGS:+.amr}${MNEME_ORGS:-hybrid})…"
$COMPOSE --env-file "$ENV_FILE" up -d --build

log "waiting for postgres…"; for i in $(seq 1 30); do $COMPOSE exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 && break; [ "$i" = 30 ] && die "postgres unhealthy"; sleep 3; done
log "applying schema…"; $COMPOSE exec -T core npx prisma migrate deploy 2>/dev/null || $COMPOSE exec -T core npx prisma db push --skip-generate 2>/dev/null || log "WARN: run prisma migrate manually"
log "waiting for core…"; for i in $(seq 1 30); do $COMPOSE exec -T core node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break; [ "$i" = 30 ] && die "core unhealthy — $COMPOSE logs core"; sleep 3; done

# 5. tell central this instance is live (so the dashboard can reach/manage it)
PUBLIC_URL="${INSTANCE_PUBLIC_URL:-}"
if [ -n "$PUBLIC_URL" ]; then
  curl -fsS -X POST "$HIVEMIND_CENTRAL_URL/v1/selfhost/register" -H 'content-type: application/json' \
    -d "{\"apiKey\":\"$HIVEMIND_API_KEY\",\"instanceUrl\":\"$PUBLIC_URL\"}" >/dev/null 2>&1 \
    && log "registered instance $PUBLIC_URL with central dashboard" || log "WARN: instance registration skipped"
fi

log "✅ HIVEMIND engine live for org $HIVEMIND_ORG_ID. core:${CORE_PORT:-2026}  control:${CONTROL_PORT:-2027}"
log "Put a domain/reverse-proxy on :2026, set INSTANCE_PUBLIC_URL=https://yourdomain + re-run to link the dashboard."
[ -n "$MNEME_ORGS" ] && log "BACK UP ./data — it holds your .amr memory."
