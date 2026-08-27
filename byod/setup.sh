#!/usr/bin/env bash
# HIVEMIND Memory Box setup. Preferred: short-lived enrollment token plus a
# broker-managed Cloudflare tunnel. API-key/custom HTTPS and Tailscale remain
# supported for existing enterprise installations.
set -euo pipefail
cd "$(dirname "$0")"
INSTALL_DIR="${HIVEMIND_MEMORY_BOX_INSTALL_DIR:-$(pwd)}"
CONFIG_DIR="${HIVEMIND_MEMORY_BOX_CONFIG_DIR:-/etc/hivemind-memory-box}"
STATE_DIR="${HIVEMIND_MEMORY_BOX_STATE_DIR:-/var/lib/hivemind-memory-box}"
ENV_FILE="${HIVEMIND_MEMORY_BOX_ENV_FILE:-$CONFIG_DIR/memory-box.env}"
CENTRAL="${HIVEMIND_CENTRAL_URL:-https://api.singulancelabs.com}"
[[ -f "$INSTALL_DIR/memory-box-common.sh" ]] || { echo 'memory-box-common.sh is missing' >&2; exit 1; }
. "$INSTALL_DIR/memory-box-common.sh"
mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$INSTALL_DIR/data" "$INSTALL_DIR/backups"
chmod 700 "$CONFIG_DIR" "$STATE_DIR"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$INSTALL_DIR/docker-compose.byod.yml")
log(){ printf '\033[1;36m[memory-box]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[memory-box] %s\033[0m\n' "$*" >&2; exit 1; }
gen(){ openssl rand -hex "${1:-24}"; }
case "$CENTRAL" in https://*) ;; *) die "HIVEMIND_CENTRAL_URL must use HTTPS" ;; esac
command -v docker >/dev/null || die "Docker is required"
command -v node >/dev/null || die "Node.js 18 or newer is required"
docker info >/dev/null 2>&1 || die "Docker daemon is not reachable"

ENROLLMENT_TOKEN="${HIVEMIND_ENROLLMENT_TOKEN:-}"
API_KEY="${HIVEMIND_API_KEY:-}"
if [[ ! -f "$ENV_FILE" ]]; then
  INITIAL_IMAGE="${BYOD_INITIAL_AGENT_IMAGE:-}"
  INITIAL_RELEASE="${BYOD_INITIAL_AGENT_RELEASE:-}"
  [[ "$INITIAL_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || die "a digest-pinned signed agent image is required"
  [[ "$INITIAL_RELEASE" =~ ^[A-Za-z0-9._-]{7,80}$ ]] || die "a signed agent release is required"
  if [[ -z "$ENROLLMENT_TOKEN" && -z "$API_KEY" ]]; then
    printf 'Paste your HIVEMIND API key (dashboard -> Self-host): '
    read -r API_KEY </dev/tty || true
  fi
  [[ -n "$ENROLLMENT_TOKEN" || -n "$API_KEY" ]] || die "supply HIVEMIND_ENROLLMENT_TOKEN or HIVEMIND_API_KEY"
  [[ -z "$API_KEY" || "$API_KEY" =~ ^[A-Za-z0-9._-]{20,256}$ ]] || die "API key format is invalid"
  [[ -z "$ENROLLMENT_TOKEN" || "$ENROLLMENT_TOKEN" =~ ^[A-Za-z0-9._~-]{20,2048}$ ]] || die "enrollment token format is invalid"

  log "enrolling this server with its organization"
  ENROLL_BODY="$(API_KEY="$API_KEY" ENROLLMENT_TOKEN="$ENROLLMENT_TOKEN" node -e 'const b={};if(process.env.ENROLLMENT_TOKEN)b.enrollmentToken=process.env.ENROLLMENT_TOKEN;if(process.env.API_KEY)b.apiKey=process.env.API_KEY;process.stdout.write(JSON.stringify(b))')"
  RESP="$(curl -fsS --proto '=https' --tlsv1.2 --max-time 30 -X POST "$CENTRAL/v1/selfhost/enroll" -H 'content-type: application/json' --data-binary "$ENROLL_BODY")" || die "organization enrollment failed"
  ORG="$(RESP="$RESP" node -e 'const x=JSON.parse(process.env.RESP);if(!/^[0-9a-f-]{36}$/i.test(x.orgId||""))process.exit(1);process.stdout.write(x.orgId)' 2>/dev/null || true)"
  [[ -n "$ORG" ]] || die "enrollment response did not contain a valid organization"
  MANAGED_URL="$(RESP="$RESP" node -e 'const x=JSON.parse(process.env.RESP);process.stdout.write(x.agentUrl||x.agent_url||"")')"
  TUNNEL_TOKEN="$(RESP="$RESP" node -e 'const x=JSON.parse(process.env.RESP);process.stdout.write(x.tunnelToken||x.tunnel_token||"")')"
  if [[ -n "$TUNNEL_TOKEN" || -n "$MANAGED_URL" ]]; then
    [[ -n "$TUNNEL_TOKEN" && "$MANAGED_URL" == https://* ]] || die "managed tunnel enrollment response is incomplete"
    [[ "$TUNNEL_TOKEN" != *$'\n'* && "$TUNNEL_TOKEN" != *$'\r'* ]] || die "managed tunnel token is malformed"
  fi
  PUBLIC_URL="${AGENT_PUBLIC_URL:-$MANAGED_URL}"
  if [[ -z "$PUBLIC_URL" && -z "$ENROLLMENT_TOKEN" && -z "${TS_AUTHKEY:-}" && -r /dev/tty ]]; then
    printf 'Public HTTPS URL (leave blank when this host already uses Tailscale): '
    read -r PUBLIC_URL </dev/tty || true
  fi

  for env_pair in \
    "HIVEMIND_API_KEY=$API_KEY" "HIVEMIND_ORG_ID=$ORG" \
    "HIVEMIND_AGENT_IMAGE=$INITIAL_IMAGE" "VERSION=$INITIAL_RELEASE" \
    "AGENT_PUBLIC_URL=$PUBLIC_URL" "CLOUDFLARE_TUNNEL_TOKEN=$TUNNEL_TOKEN" \
    "TS_AUTHKEY=${TS_AUTHKEY:-}" "TS_HOSTNAME=${TS_HOSTNAME:-hivemind-byod}"; do
    hm_key="${env_pair%%=*}"; hm_value="${env_pair#*=}"
    hm_validate_env_value "$hm_key" "$hm_value"
  done

  log "pulling signed agent and local data services"
  : > "$STATE_DIR/warm.log"
  HIVEMIND_AGENT_IMAGE="$INITIAL_IMAGE" VERSION="$INITIAL_RELEASE" POSTGRES_PASSWORD=warm AGENT_TOKEN=warm HIVEMIND_ORG_ID="$ORG" \
    docker compose -f "$INSTALL_DIR/docker-compose.byod.yml" pull agent postgres qdrant >>"$STATE_DIR/warm.log" 2>&1 || die "image pull failed; inspect $STATE_DIR/warm.log"
  umask 077
  cat > "$ENV_FILE" <<EOF
HIVEMIND_API_KEY=$API_KEY
HIVEMIND_BOX_TOKEN=
HIVEMIND_ORG_ID=$ORG
HIVEMIND_AGENT_IMAGE=$INITIAL_IMAGE
VERSION=$INITIAL_RELEASE
EMBEDDING_DIMENSION=1024
POSTGRES_USER=hivemind
POSTGRES_PASSWORD=$(gen)
POSTGRES_DB=hivemind
AGENT_TOKEN=$(gen 32)
AGENT_PORT=8787
AGENT_BIND=127.0.0.1
AGENT_PUBLIC_URL=$PUBLIC_URL
CLOUDFLARE_TUNNEL_TOKEN=$TUNNEL_TOKEN
CLOUDFLARED_IMAGE=cloudflare/cloudflared@sha256:0aa26e284f05e6c77ae375b8c9c11d9eb6a448fb7bcd8d40f31cb6176189eb38
TS_AUTHKEY=${TS_AUTHKEY:-}
TS_HOSTNAME=${TS_HOSTNAME:-hivemind-byod}
EOF
  chmod 600 "$ENV_FILE"
else
  log "existing protected configuration found; reconciling services"
fi

hm_load_env_file "$ENV_FILE"
[[ "${HIVEMIND_AGENT_IMAGE:-}" =~ @sha256:[a-f0-9]{64}$ ]] || die "configuration has no digest-pinned signed agent image"
if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  TRANSPORT=cloudflare; "${COMPOSE[@]}" --profile cloudflare up -d
elif [[ -n "${TS_AUTHKEY:-}" ]]; then
  TRANSPORT=tailscale; "${COMPOSE[@]}" --profile tailnet up -d
else
  TRANSPORT=custom_https; "${COMPOSE[@]}" up -d
fi

AGENT_PORT="${AGENT_PORT:-8787}"; AGENT_URL="${AGENT_PUBLIC_URL:-}"
if [[ -z "$AGENT_URL" ]] && command -v tailscale >/dev/null 2>&1; then
  TSIP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  [[ -z "$TSIP" ]] || { AGENT_URL="http://${TSIP}:${AGENT_PORT}"; TRANSPORT=tailscale; }
fi
if [[ -z "$AGENT_URL" && "$TRANSPORT" == tailscale ]]; then
  for _ in $(seq 1 60); do
    TSIP="$(docker exec hm-byod-tunnel tailscale ip -4 2>/dev/null | head -1 || true)"
    if [[ -n "$TSIP" ]]; then AGENT_URL="http://${TSIP}:${AGENT_PORT}"; break; fi
    sleep 1
  done
fi
[[ -n "$AGENT_URL" ]] || die "no managed tunnel, custom HTTPS URL, or Tailscale address is configured"
case "$AGENT_URL" in
  https://*|http://100.*|http://10.*|http://192.168.*|http://172.1[6-9].*|http://172.2[0-9].*|http://172.3[0-1].*|http://*.ts.net*) ;;
  *) die "agent URL must use HTTPS or an approved private/Tailscale address" ;;
esac

log "waiting for local agent health"
LOCAL_READY=false
for _ in $(seq 1 60); do
  if curl -fsS -m 3 "http://127.0.0.1:${AGENT_PORT}/health" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{process.exit(JSON.parse(b).ok===true?0:1)}catch{process.exit(1)}})' >/dev/null 2>&1; then LOCAL_READY=true; break; fi
  sleep 1
done
[[ "$LOCAL_READY" == true ]] || die "agent did not become healthy; run: hivemind-memory-box logs"

REGISTER_BODY="$(API_KEY="${HIVEMIND_API_KEY:-$API_KEY}" ENROLLMENT_TOKEN="$ENROLLMENT_TOKEN" BOX_TOKEN="${HIVEMIND_BOX_TOKEN:-}" AGENT_URL="$AGENT_URL" AGENT_TOKEN="$AGENT_TOKEN" TRANSPORT="$TRANSPORT" node -e 'const b={agentUrl:process.env.AGENT_URL,agentToken:process.env.AGENT_TOKEN,transport:process.env.TRANSPORT};if(process.env.ENROLLMENT_TOKEN)b.enrollmentToken=process.env.ENROLLMENT_TOKEN;if(process.env.BOX_TOKEN)b.boxToken=process.env.BOX_TOKEN;if(process.env.API_KEY)b.apiKey=process.env.API_KEY;process.stdout.write(JSON.stringify(b))')"
REGISTER_RESPONSE="$(curl -fsS --proto '=https' --tlsv1.2 --max-time 30 -X POST "$CENTRAL/v1/selfhost/register" -H 'content-type: application/json' --data-binary "$REGISTER_BODY")" || die "agent registration failed"
NEW_BOX_TOKEN="$(REGISTER_RESPONSE="$REGISTER_RESPONSE" node -e 'const x=JSON.parse(process.env.REGISTER_RESPONSE);process.stdout.write(x.boxToken||x.box_token||"")')"
if [[ -n "$NEW_BOX_TOKEN" ]]; then
  . "$INSTALL_DIR/memory-box-common.sh"
  hm_set_env_value "$ENV_FILE" HIVEMIND_BOX_TOKEN "$NEW_BOX_TOKEN"
  hm_set_env_value "$ENV_FILE" HIVEMIND_API_KEY ""
  HIVEMIND_BOX_TOKEN="$NEW_BOX_TOKEN"; HIVEMIND_API_KEY=""
fi

log "verifying authenticated central reachability"
STATUS_BODY="$(API_KEY="${HIVEMIND_API_KEY:-}" BOX_TOKEN="${HIVEMIND_BOX_TOKEN:-}" node -e 'const b={};if(process.env.BOX_TOKEN)b.boxToken=process.env.BOX_TOKEN;else b.apiKey=process.env.API_KEY;process.stdout.write(JSON.stringify(b))')"
REMOTE_READY=false
for _ in $(seq 1 24); do
  STATUS="$(curl -fsS --proto '=https' --tlsv1.2 --max-time 15 -X POST "$CENTRAL/v1/selfhost/status" -H 'content-type: application/json' --data-binary "$STATUS_BODY" 2>/dev/null || true)"
  if STATUS="$STATUS" node -e 'try{const x=JSON.parse(process.env.STATUS);process.exit(x.registered===true&&x.reachable===true?0:1)}catch{process.exit(1)}'; then REMOTE_READY=true; break; fi
  sleep 5
done
[[ "$REMOTE_READY" == true ]] || die "agent is locally healthy but not centrally reachable; rerun after checking transport status"
printf '\n  \033[1;32m✓ Memory Box connected\033[0m\n  organization: %s\n  transport:    %s\n  endpoint:     %s\n\n' "$HIVEMIND_ORG_ID" "$TRANSPORT" "$AGENT_URL"
