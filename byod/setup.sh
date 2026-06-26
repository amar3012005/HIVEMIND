#!/usr/bin/env bash
# HIVEMIND BYOD (data-only) setup. Runs on YOUR server. Stands up Postgres + Qdrant (your memory data)
# + an outbound tunnel, validates your API key with HIVEMIND, and registers the two stores so the
# central engine routes ONLY your org's memory data here. Engine + dashboard stay central; you use
# the normal dashboard. Your data never leaves this box.
#   git clone --branch byod --single-branch <repo> hivemind-byod && cd hivemind-byod && ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.byod.yml"
CENTRAL="${HIVEMIND_CENTRAL_URL:-https://api.hivemind.davinciai.eu}"   # control-plane (where you minted the key)
log(){ printf '\033[1;36m[byod]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[byod] %s\033[0m\n' "$*" >&2; exit 1; }
command -v docker >/dev/null || die "install Docker first (curl -fsSL https://get.docker.com | sh)"
gen(){ openssl rand -hex "${1:-24}"; }

if [ ! -f .env ]; then
  printf 'Paste your HIVEMIND API key (dashboard → Settings → Self-host): '
  read -r API_KEY; [ -n "$API_KEY" ] || die "no key entered"
  log "validating key with $CENTRAL …"
  RESP="$(curl -fsS -X POST "$CENTRAL/v1/selfhost/enroll" -H 'content-type: application/json' -d "{\"apiKey\":\"$API_KEY\"}")" \
    || die "key validation failed — check the key + that $CENTRAL is reachable"
  ORG="$(printf '%s' "$RESP" | grep -oE '"orgId":"[^"]+"' | cut -d'"' -f4)"; [ -n "$ORG" ] || die "no org for key: $RESP"
  log "key OK → org $ORG"
  cat > .env <<EOF
HIVEMIND_API_KEY=$API_KEY
HIVEMIND_ORG_ID=$ORG
POSTGRES_USER=hivemind
POSTGRES_PASSWORD=$(gen)
POSTGRES_DB=hivemind
QDRANT_API_KEY=$(gen)
# Tailscale auth key (so HIVEMIND central can reach your pg/qdrant over the tunnel). Get one at
# https://login.tailscale.com/admin/settings/keys  — leave blank to wire your own tunnel + set the
# reachable hostnames below manually.
TS_AUTHKEY=
TS_HOSTNAME=hivemind-byod
# Filled after the tunnel is up (or set manually if you bring your own):
PG_TUNNEL_HOST=
QDRANT_TUNNEL_HOST=
EOF
  log ".env written. Add TS_AUTHKEY (Tailscale) to .env, then re-run ./setup.sh"
  exit 0
fi
set -a; . ./.env; set +a

# 1. up the stores + tunnel
log "starting Postgres + Qdrant + tunnel…"
$COMPOSE up -d

# 2. resolve the tunnel-reachable hostnames (Tailscale assigns a stable name; or use what you set)
if [ -z "${PG_TUNNEL_HOST:-}" ] && [ -n "${TS_AUTHKEY:-}" ]; then
  log "waiting for tailscale…"; for i in $(seq 1 20); do
    TSHOST="$($COMPOSE exec -T tunnel tailscale status --json 2>/dev/null | grep -oE '"DNSName":"[^"]+"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')" || true
    [ -n "${TSHOST:-}" ] && break; sleep 3; done
  PG_TUNNEL_HOST="${TSHOST:-}"; QDRANT_TUNNEL_HOST="${TSHOST:-}"
fi
[ -n "${PG_TUNNEL_HOST:-}" ] || die "no tunnel host — set PG_TUNNEL_HOST + QDRANT_TUNNEL_HOST in .env (your tunnel's reachable address)"

PG_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${PG_TUNNEL_HOST}:5432/${POSTGRES_DB}?sslmode=disable"
QDRANT_URL_FULL="http://${QDRANT_TUNNEL_HOST}:6333"

# 3. (schema) the central engine migrates the memory-subgraph tables into your PG on first connect.
log "registering your stores with HIVEMIND…"
curl -fsS -X POST "$CENTRAL/v1/selfhost/register" -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$HIVEMIND_API_KEY\",\"pgUrl\":\"$PG_URL\",\"qdrantUrl\":\"$QDRANT_URL_FULL\"}" >/dev/null \
  || die "registration failed"

log "✅ connected. org $HIVEMIND_ORG_ID — your memory data lives on THIS box ($PWD/data)."
log "Use the HIVEMIND dashboard as normal. Stop: $COMPOSE down  |  BACK UP ./data."
