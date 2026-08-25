#!/usr/bin/env bash
# HIVEMIND BYOD setup — runs on YOUR server. Stands up the Postgres + Qdrant agent (your memory data plane),
# validates your API key, and registers the agent so the central engine ships finished memories here.
# The engine + dashboard stay central; your memory data (content + vectors + graph) lives in the .amr on
# THIS box. Only query results traverse the link.
#   git clone --branch byod --single-branch <repo> hivemind-byod && cd hivemind-byod && ./setup.sh
#
# Single smooth flow: the heavy work (building the .amr agent image + pulling Postgres + starting it)
# runs in the BACKGROUND while you paste your key — so by the time the key is validated, the box is
# already warmed and the agent comes up instantly. No second run needed.
set -euo pipefail
cd "$(dirname "$0")"
INSTALL_DIR="${HIVEMIND_MEMORY_BOX_INSTALL_DIR:-$(pwd)}"
CONFIG_DIR="${HIVEMIND_MEMORY_BOX_CONFIG_DIR:-/etc/hivemind-memory-box}"
STATE_DIR="${HIVEMIND_MEMORY_BOX_STATE_DIR:-/var/lib/hivemind-memory-box}"
ENV_FILE="${HIVEMIND_MEMORY_BOX_ENV_FILE:-$CONFIG_DIR/memory-box.env}"
mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$INSTALL_DIR/data" "$INSTALL_DIR/backups"
chmod 700 "$STATE_DIR"
COMPOSE="docker compose --env-file $ENV_FILE -f docker-compose.byod.yml"
CENTRAL="${HIVEMIND_CENTRAL_URL:-https://api.singulancelabs.com}"   # control-plane (where you minted the key)
log(){ printf '\033[1;36m[byod]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[byod] %s\033[0m\n' "$*" >&2; exit 1; }
command -v docker >/dev/null || die "install Docker first (curl -fsSL https://get.docker.com | sh)"
gen(){ openssl rand -hex "${1:-24}"; }
C='\033[1;36m'; D='\033[0;90m'; G='\033[1;32m'; Z='\033[0m'
step(){ printf "  ${C}◆${Z} %-22s ${D}%s${Z}\n" "$1" "$2"; }
ok(){   printf "  ${G}✓${Z} %-22s ${D}%s${Z}\n" "$1" "$2"; }
banner(){ printf "
${C}  ███████╗██╗███╗   ██╗ ██████╗ ██╗   ██╗██╗      █████╗ ███╗   ██╗ ██████╗███████╗
  ██╔════╝██║████╗  ██║██╔════╝ ██║   ██║██║     ██╔══██╗████╗  ██║██╔════╝██╔════╝
  ███████╗██║██╔██╗ ██║██║  ███╗██║   ██║██║     ███████║██╔██╗ ██║██║     █████╗
  ╚════██║██║██║╚██╗██║██║   ██║██║   ██║██║     ██╔══██║██║╚██╗██║██║     ██╔══╝
  ███████║██║██║ ╚████║╚██████╔╝╚██████╔╝███████╗██║  ██║██║ ╚████║╚██████╗███████╗
  ╚══════╝╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝╚══════╝${Z}
  ${D}self-hosted agent · your server · your data · connected to the SINGULANCE engine${Z}

"; }
banner

# Idempotent re-run: .env already exists → just bring everything up and re-register.
if [ -f "$ENV_FILE" ]; then
  log "existing configuration found — bringing up + re-registering…"
else
  # ── 1. WARM IN BACKGROUND ──────────────────────────────────────────────────────────────────────
  # Build the agent image + pull Postgres while you fetch/paste your key. This is the slow part; doing
  # it now means the agent starts instantly once the key is in.
  log "warming up (building the data-plane agent + pulling Postgres + Qdrant in the background while you grab your key)…"
  : > .byod-warm.log
  ( $COMPOSE build agent >>.byod-warm.log 2>&1 && docker pull postgres:16-alpine >>.byod-warm.log 2>&1 && docker pull qdrant/qdrant:latest >>.byod-warm.log 2>&1 ) &
  WARM_PID=$!

  # ── 2. KEY ─────────────────────────────────────────────────────────────────────────────────────
  API_KEY="${HIVEMIND_API_KEY:-}"
  if [ -z "$API_KEY" ]; then
    printf 'Paste your HIVEMIND API key (dashboard → Self-host): '
    read -r API_KEY </dev/tty || true   # /dev/tty so this works under `curl … | bash`
  fi
  [ -n "$API_KEY" ] || die "no key entered (or pass HIVEMIND_API_KEY=… for non-interactive)"
  log "validating key with $CENTRAL …"
  RESP="$(curl -fsS -X POST "$CENTRAL/v1/selfhost/enroll" -H 'content-type: application/json' -d "{\"apiKey\":\"$API_KEY\"}")" \
    || die "key validation failed — check the key + that $CENTRAL is reachable"
  ORG="$(printf '%s' "$RESP" | grep -oE '"orgId":"[^"]+"' | cut -d'"' -f4)"; [ -n "$ORG" ] || die "no org for key: $RESP"
  log "key OK → org $ORG"

  # ── 3. EXPOSURE ────────────────────────────────────────────────────────────────────────────────
  # How will the central engine reach this agent? Direct HTTPS (a domain) or Tailscale (private).
  # Blank → auto-detect in step 7 (Tailscale IP, else public IP). Only ask interactively, and only
  # if a terminal is attached — piped/non-interactive installs proceed fully unattended.
  PUBURL="${AGENT_PUBLIC_URL:-}"
  if [ -z "$PUBURL" ] && [ -t 0 ]; then
    printf 'Public URL the engine reaches this agent at (e.g. https://agent.yourdomain.com), or blank to auto-detect: '
    read -r PUBURL </dev/tty || true
  fi

  # ── 4. WAIT FOR WARM ───────────────────────────────────────────────────────────────────────────
  log "finishing warm-up (image build + Postgres + Qdrant pull)…"
  if ! wait "$WARM_PID"; then die "warm-up failed — see $(pwd)/.byod-warm.log"; fi
  log "warm-up done — box is primed."

  # ── 5. WRITE .env ──────────────────────────────────────────────────────────────────────────────
  umask 077
  cat > "$ENV_FILE" <<EOF
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
  chmod 600 "$ENV_FILE"
  log "protected configuration written."
fi

set -a; . "$ENV_FILE"; set +a

# ── 6. BRING UP (fast — image already built + Postgres/Qdrant pulled during warm) ────────────────────
if [ -n "${TS_AUTHKEY:-}" ]; then
  log "starting Postgres + Qdrant + .amr agent + Tailscale tunnel…"; $COMPOSE --profile tailnet up -d
else
  log "starting Postgres + Qdrant + .amr agent…"; $COMPOSE up -d
fi

# ── 7. RESOLVE THE AGENT URL THE ENGINE WILL USE ───────────────────────────────────────────────────
# The control plane rejects cleartext public HTTP because it would expose memory
# content and the bearer token. Operators must provide HTTPS, or an already
# reachable private/Tailscale URL. Do not guess a public IP and register it.
AGENT_PORT="${AGENT_PORT:-8787}"
AGENT_URL="${AGENT_PUBLIC_URL:-}"
# (1) Host already on Tailscale? Use its mesh IP — no authkey, no tunnel container needed.
if [ -z "$AGENT_URL" ] && command -v tailscale >/dev/null 2>&1; then
  TSIP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  [ -n "${TSIP:-}" ] && { AGENT_URL="http://${TSIP}:${AGENT_PORT}"; log "auto-detected Tailscale IP → $AGENT_URL"; }
fi
[ -n "$AGENT_URL" ] || die "set AGENT_PUBLIC_URL to an HTTPS reverse-proxy URL or a private/Tailscale URL reachable by the central engine"
case "$AGENT_URL" in
  https://*|http://100.*|http://10.*|http://192.168.*|http://172.1[6-9].*|http://172.2[0-9].*|http://172.3[0-1].*|http://*.ts.net*) ;;
  *) die "AGENT_PUBLIC_URL must be https:// or an approved private/Tailscale http:// address" ;;
esac

# ── 8. WAIT FOR THE AGENT TO BE HEALTHY, THEN REGISTER ─────────────────────────────────────────────
log "waiting for the agent to be ready…"
for i in $(seq 1 30); do
  if curl -fsS -m 3 "http://127.0.0.1:${AGENT_PORT:-8787}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
log "registering the BYOD agent with HIVEMIND ($AGENT_URL)…"
curl -fsS -X POST "$CENTRAL/v1/selfhost/register" -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$HIVEMIND_API_KEY\",\"agentUrl\":\"$AGENT_URL\",\"agentToken\":\"$AGENT_TOKEN\"}" >/dev/null \
  || die "registration failed"

ok "agent registered" "$AGENT_URL"
printf "
  ${C}→ connected to SINGULANCE${Z}

     ${D}org${Z}        %s
     ${D}agent${Z}      %s
     ${D}data${Z}       %s  ${D}(content + vectors + graph — never leaves this box)${Z}
     ${D}status${Z}     ${G}live${Z} · the dashboard flips to 'Agent connected' automatically

" "$HIVEMIND_ORG_ID" "$AGENT_URL" "$PWD/data"
log "Use the SINGULANCE dashboard now. BACK UP ./data."
