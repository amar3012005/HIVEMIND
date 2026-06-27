#!/usr/bin/env bash
# HIVEMIND BYOD setup — runs on YOUR server. Stands up the .amr agent + Postgres (your memory data plane),
# validates your API key, and registers the agent so the central engine ships finished memories here.
# The engine + dashboard stay central; your memory data (content + vectors + graph) lives in the .amr on
# THIS box. Only query results traverse the link.
#   git clone --branch byod --single-branch <repo> hivemind-byod && cd hivemind-byod && ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.byod.yml"
CENTRAL="${HIVEMIND_CENTRAL_URL:-https://api.singulancelabs.com}"   # control-plane (where you minted the key)
log(){ printf '\033[1;36m[byod]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[byod] %s\033[0m\n' "$*" >&2; exit 1; }
command -v docker >/dev/null || die "install Docker first (curl -fsSL https://get.docker.com | sh)"
gen(){ openssl rand -hex "${1:-24}"; }

if [ ! -f .env ]; then
  API_KEY="${HIVEMIND_API_KEY:-}"
  if [ -z "$API_KEY" ]; then
    printf 'Paste your HIVEMIND API key (dashboard → Settings → Self-host): '
    read -r API_KEY </dev/tty || true   # /dev/tty so this works under `curl … | bash`
  fi
  [ -n "$API_KEY" ] || die "no key entered (or pass HIVEMIND_API_KEY=… for non-interactive)"
  log "validating key with $CENTRAL …"
  RESP="$(curl -fsS -X POST "$CENTRAL/v1/selfhost/enroll" -H 'content-type: application/json' -d "{\"apiKey\":\"$API_KEY\"}")" \
    || die "key validation failed — check the key + that $CENTRAL is reachable"
  ORG="$(printf '%s' "$RESP" | grep -oE '"orgId":"[^"]+"' | cut -d'"' -f4)"; [ -n "$ORG" ] || die "no org for key: $RESP"
  log "key OK → org $ORG"
  # How will the central engine reach this agent? Direct HTTPS (a domain) or Tailscale (private).
  PUBURL="${AGENT_PUBLIC_URL:-}"
  if [ -z "$PUBURL" ]; then
    printf 'Public URL the engine will reach this agent at (e.g. https://agent.yourdomain.com), or blank for Tailscale: '
    read -r PUBURL </dev/tty || true
  fi
  cat > .env <<EOF
HIVEMIND_API_KEY=$API_KEY
HIVEMIND_ORG_ID=$ORG
EMBEDDING_DIMENSION=1024
POSTGRES_USER=hivemind
POSTGRES_PASSWORD=$(gen)
POSTGRES_DB=hivemind
AGENT_TOKEN=$(gen 32)
AGENT_PORT=8787
AGENT_BIND=0.0.0.0
# Direct-HTTPS exposure: the URL the central engine POSTs to (put your TLS proxy in front). Leave blank
# to use Tailscale instead (set TS_AUTHKEY + run with --profile tailnet).
AGENT_PUBLIC_URL=$PUBURL
TS_AUTHKEY=
TS_HOSTNAME=hivemind-byod
EOF
  log ".env written. If using Tailscale, add TS_AUTHKEY then re-run. Otherwise re-run to bring it up."
  exit 0
fi
set -a; . ./.env; set +a

# 1. bring up Postgres + the .amr agent (+ tunnel if Tailscale)
if [ -n "${TS_AUTHKEY:-}" ]; then
  log "starting Postgres + .amr agent + Tailscale tunnel…"; $COMPOSE --profile tailnet up -d --build
else
  log "starting Postgres + .amr agent…"; $COMPOSE up -d --build
fi

# 2. resolve the agent URL the engine will use
AGENT_URL="${AGENT_PUBLIC_URL:-}"
if [ -z "$AGENT_URL" ] && [ -n "${TS_AUTHKEY:-}" ]; then
  log "waiting for tailscale hostname…"; for i in $(seq 1 20); do
    TSHOST="$($COMPOSE exec -T tunnel tailscale status --json 2>/dev/null | grep -oE '"DNSName":"[^"]+"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')" || true
    [ -n "${TSHOST:-}" ] && break; sleep 3; done
  [ -n "${TSHOST:-}" ] && AGENT_URL="http://${TSHOST}:${AGENT_PORT:-8787}"
fi
[ -n "$AGENT_URL" ] || die "no agent URL — set AGENT_PUBLIC_URL in .env (https://… with TLS) or use Tailscale"

# 3. register the agent with the central engine (engine ships finished memories here via /v1/write)
log "registering the .amr agent with HIVEMIND ($AGENT_URL)…"
curl -fsS -X POST "$CENTRAL/v1/selfhost/register" -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$HIVEMIND_API_KEY\",\"agentUrl\":\"$AGENT_URL\",\"agentToken\":\"$AGENT_TOKEN\"}" >/dev/null \
  || die "registration failed"

log "✅ connected. org $HIVEMIND_ORG_ID — your memory data lives in the .amr on THIS box ($PWD/data)."
log "Use the HIVEMIND dashboard as normal. Stop: $COMPOSE down  |  BACK UP ./data."
