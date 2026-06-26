#!/usr/bin/env bash
# HIVEMIND BYOD one-command setup. Run on YOUR server:
#   git clone --branch byod --single-branch <repo> hivemind-byod && cd hivemind-byod && ./setup.sh
# Asks for your dashboard API key, starts the local data plane (your .amr on your disk), opens an
# OUTBOUND tunnel, and connects it to HIVEMIND. Your memory stays on this box; you use the normal
# dashboard. No inbound ports opened.
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.byod.yml"
BROKER_URL="${BROKER_URL:-https://api.davinciai.eu}"   # our central broker
log(){ printf '\033[1;36m[byod]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[byod] %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "install Docker first (curl -fsSL https://get.docker.com | sh)"

# 1. API key + agent token
if [ ! -f .env ]; then
  printf 'Paste your HIVEMIND API key (from the dashboard → Settings → BYOD): '
  read -r API_KEY
  [ -n "$API_KEY" ] || die "no key entered"
  AGENT_TOKEN="$(openssl rand -hex 24)"
  cat > .env <<EOF
HIVEMIND_API_KEY=$API_KEY
AGENT_TOKEN=$AGENT_TOKEN
MNEME_DIM=1024
# DATABASE_URL=postgresql://byod:byod@postgres:5432/hivemind   # uncomment + 'docker compose --profile pg up -d' for local PG
EOF
  log ".env written (key + agent token)."
fi
set -a; . ./.env; set +a

# 2. bring up the agent + outbound tunnel
log "starting local data plane (.amr) + outbound tunnel…"
$COMPOSE up -d --build

# 3. discover the public tunnel URL (cloudflared prints it)
log "waiting for the tunnel URL…"
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL="$($COMPOSE logs tunnel 2>/dev/null | grep -oE 'https://[a-z0-9.-]+\.trycloudflare\.com' | tail -1 || true)"
  [ -n "$TUNNEL_URL" ] && break; sleep 2
done
[ -n "${AGENT_PUBLIC_URL:-}" ] && TUNNEL_URL="$AGENT_PUBLIC_URL"   # or bring your own domain
[ -n "$TUNNEL_URL" ] || die "tunnel URL not found — check: $COMPOSE logs tunnel"
log "tunnel: $TUNNEL_URL"

# 4. enroll with the central broker (validates the key → binds this agent to your org)
log "connecting to HIVEMIND…"
RESP="$(curl -fsS -X POST "$BROKER_URL/v1/byod/enroll" -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$HIVEMIND_API_KEY\",\"agentUrl\":\"$TUNNEL_URL\",\"agentToken\":\"$AGENT_TOKEN\"}")" \
  || die "enrollment failed — check the API key + that $BROKER_URL is reachable"
ORG="$(printf '%s' "$RESP" | grep -oE '"orgId":"[^"]+"' | cut -d'"' -f4 || true)"

log "✅ connected. org=$ORG"
log "Your memory lives on THIS box ($PWD/data). Use the HIVEMIND dashboard as normal —"
log "recall, ingest, HyperAgents all work; your data never leaves here."
log "Stop:  $COMPOSE down     |    Logs: $COMPOSE logs -f agent"
log "BACK UP ./data — it is the sole copy of your .amr memory."
