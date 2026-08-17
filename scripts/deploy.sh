#!/bin/bash
# HIVEMIND Deploy Script
# Usage:
#   ./scripts/deploy.sh              — restart core + control-plane
#   ./scripts/deploy.sh core         — restart core only
#   ./scripts/deploy.sh control      — restart control-plane only
#   ./scripts/deploy.sh status       — show container status
#   ./scripts/deploy.sh logs [name]  — tail logs (default: hm-core)
#   ./scripts/deploy.sh verify       — verify all endpoints

set -euo pipefail
cd "$(dirname "$0")/.."

COOLIFY_ENV="/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/.env"
NETWORK="hmtest"
COOLIFY_PG="postgres-s0k0s0k40wo44w4w8gcs8ow0-223235326771"
COOLIFY_REDIS="redis-s0k0s0k40wo44w4w8gcs8ow0-223235365936"
COOLIFY_QDRANT="qdrant-s0k0s0k40wo44w4w8gcs8ow0-223235347017"
COOLIFY_EMBED="embeddings-eu-f8osow0so0w0c0w8gow8ok8s-235454534875"
COOLIFY_CONTROL="control-plane-s0k0s0k40wo44w4w8gcs8ow0"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[deploy]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1"; }

ensure_networks() {
  for c in $COOLIFY_PG $COOLIFY_REDIS $COOLIFY_QDRANT $COOLIFY_EMBED; do
    docker network connect $NETWORK "$c" 2>/dev/null || true
  done
}

start_employees() {
  # Host port: 8061 (8060 is owned by hivemind-caddy-csi). Container port
  # stays 8060 so internal docker-network refs like hm-employees:8060
  # are unchanged for hm-core + control-plane.
  HM_EMP_HOST_PORT="${HM_EMP_HOST_PORT:-8061}"
  local REDIS_AUTH_SEG=""
  if [ -n "${REDIS_PASSWORD:-}" ]; then
    REDIS_AUTH_SEG=":${REDIS_PASSWORD}@"
  fi
  log "Starting hm-employees (Digital Employees, host ${HM_EMP_HOST_PORT} → container 8060)..."
  docker stop hm-employees 2>/dev/null || true
  docker rm hm-employees 2>/dev/null || true
  ensure_networks

  # Vendored SlackAgents lives under /opt/HIVEMIND/employees-service/vendor/slackagents
  # Wrapper lives under /opt/HIVEMIND/employees-service/src/hivemind_employees
  if [ ! -d /opt/HIVEMIND/employees-service ]; then
    err "Missing /opt/HIVEMIND/employees-service — Phase 2 not yet pushed"
    return 1
  fi

  docker run -d \
    --name hm-employees \
    --network $NETWORK \
    --restart unless-stopped \
    -p ${HM_EMP_HOST_PORT}:8060 \
    -v /opt/HIVEMIND/employees-service:/app \
    -v /etc/localtime:/etc/localtime:ro \
    -w /app \
    --env-file "$COOLIFY_ENV" \
    -e PYTHONUNBUFFERED=1 \
    -e PORT=8060 \
    -e LOG_LEVEL=info \
    -e REPLICA_ID="${HOSTNAME:-rep1}" \
    -e REPLICA_COUNT="${HM_EMPLOYEES_REPLICA_COUNT:-1}" \
    -e "HIVEMIND_CORE_URL=http://hm-core:3000" \
    -e "HIVEMIND_CP_URL=http://hm-control:3000" \
    -e "HIVEMIND_PUBLIC_CORE_URL=https://core.hivemind.davinciai.eu:8050" \
    -e "HIVEMIND_PUBLIC_CP_URL=https://api.hivemind.davinciai.eu:8040" \
    -e "DATABASE_URL=postgresql://hivemind_user:hivemind_secure_pwd_2026@${COOLIFY_PG}:5432/hivemind?schema=hivemind" \
    -e "REDIS_URL=redis://${REDIS_AUTH_SEG}${COOLIFY_REDIS}:6379/0" \
    -e "HIVEMIND_ALLOWED_ORIGINS=https://hivemind.davinciai.eu,https://www.davinciai.eu,https://davinciai.eu" \
    python:3.12-slim \
    sh -c "set -e; \
      apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null && \
      pip install --no-cache-dir -q -e vendor/slackagents -e . && \
      python -m hivemind_employees.main"

  log "Waiting for hm-employees health..."
  for i in $(seq 1 60); do
    sleep 2
    # Probe via host port AND via container network (docker exec curl)
    if curl -sf http://localhost:${HM_EMP_HOST_PORT}/health >/dev/null 2>&1; then
      log "hm-employees is ${GREEN}healthy${NC} on host port ${HM_EMP_HOST_PORT} (container 8060)"
      return 0
    fi
    if docker exec hm-employees curl -sf http://localhost:8060/health >/dev/null 2>&1; then
      log "hm-employees is ${GREEN}healthy${NC} on container 8060 (host port ${HM_EMP_HOST_PORT} may be NAT-blocked)"
      return 0
    fi
    echo -n "."
  done
  err "hm-employees not healthy after 120s"
  docker logs hm-employees --tail 40
  return 1
}

start_workspace_mcp() {
  # Google Workspace MCP — stateless sidecar that handles 12 Google services
  # (Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, Tasks, Contacts,
  # Chat, Apps Script, Search). HIVEMIND owns OAuth + tokens; this server
  # is just a stateless executor that takes Bearer ya29.* tokens per request.
  log "Starting workspace-mcp (Google Workspace MCP, port 8070 external → 8000 internal)..."
  docker stop workspace-mcp 2>/dev/null || true
  docker rm workspace-mcp 2>/dev/null || true
  ensure_networks

  if [ ! -d /opt/HIVEMIND/google_workspace_mcp ]; then
    err "Missing /opt/HIVEMIND/google_workspace_mcp — clone it first:"
    err "  cd /opt/HIVEMIND && git clone https://github.com/taylorwilsdon/google_workspace_mcp.git"
    return 1
  fi

  # Read GOOGLE_CLIENT_ID + secret from Coolify env (already used by HIVEMIND)
  # Note: `set -e` + grep no-match would exit; use `|| true` to tolerate.
  local GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET JWT_SIGNING_KEY
  GOOGLE_CLIENT_ID="$(grep '^GOOGLE_CLIENT_ID=' "$COOLIFY_ENV" 2>/dev/null | cut -d= -f2- || true)"
  GOOGLE_CLIENT_SECRET="$(grep '^GOOGLE_CLIENT_SECRET=' "$COOLIFY_ENV" 2>/dev/null | cut -d= -f2- || true)"

  if [ -z "$GOOGLE_CLIENT_ID" ]; then
    err "GOOGLE_CLIENT_ID not set in Coolify .env"
    return 1
  fi

  # JWT signing key — generated once, kept stable in Coolify .env
  JWT_SIGNING_KEY="$(grep '^WORKSPACE_MCP_JWT_KEY=' "$COOLIFY_ENV" 2>/dev/null | cut -d= -f2- || true)"
  if [ -z "$JWT_SIGNING_KEY" ]; then
    JWT_SIGNING_KEY="$(openssl rand -hex 32)"
    log "Generated WORKSPACE_MCP_JWT_KEY — appending to $COOLIFY_ENV"
    echo "WORKSPACE_MCP_JWT_KEY=$JWT_SIGNING_KEY" >> "$COOLIFY_ENV"
  fi

  # Service account JSON (for optional domain-wide delegation)
  local SA_KEY_PATH="/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/google-workspace-sa.json"
  local SA_MOUNT_ARG=""
  if [ -f "$SA_KEY_PATH" ]; then
    SA_MOUNT_ARG="-v $SA_KEY_PATH:/app/google-workspace-sa.json:ro"
  fi

  docker run -d \
    --name workspace-mcp \
    --network $NETWORK \
    --restart unless-stopped \
    -p 8070:8000 \
    -v /opt/HIVEMIND/google_workspace_mcp:/app \
    $SA_MOUNT_ARG \
    -w /app \
    -e PORT=8000 \
    -e "GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_CLIENT_ID" \
    -e "GOOGLE_OAUTH_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET" \
    -e "FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY=$JWT_SIGNING_KEY" \
    -e MCP_ENABLE_OAUTH21=true \
    -e EXTERNAL_OAUTH21_PROVIDER=true \
    -e WORKSPACE_MCP_STATELESS_MODE=true \
    -e WORKSPACE_MCP_TRANSPORT=streamable-http \
    -e PYTHONUNBUFFERED=1 \
    -e USER_GOOGLE_EMAIL="ingest@hivemind.davinciai.eu" \
    python:3.11-slim \
    sh -c "set -e; \
      apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null && \
      pip install --no-cache-dir -q uv && \
      uv sync --frozen --no-dev --extra disk && \
      uv run main.py --transport streamable-http"

  log "Waiting for workspace-mcp health..."
  for i in $(seq 1 60); do
    sleep 2
    if curl -sf http://localhost:8070/health >/dev/null 2>&1; then
      log "workspace-mcp is ${GREEN}healthy${NC} on host 8070 → container 8000"
      return 0
    fi
    if docker exec workspace-mcp curl -sf http://localhost:8000/health >/dev/null 2>&1; then
      log "workspace-mcp is ${GREEN}healthy${NC} on container 8000"
      return 0
    fi
    echo -n "."
  done
  err "workspace-mcp not healthy after 120s"
  docker logs workspace-mcp --tail 30
  return 1
}

start_core() {
  log "Starting hm-core (bind-mount /opt/HIVEMIND/core, Coolify .env)..."
  docker stop hm-core 2>/dev/null || true
  docker rm hm-core 2>/dev/null || true
  ensure_networks

  # Mount Google service account JSON if available
  local CORE_SA_MOUNT=""
  if [ -f "/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/google-workspace-sa.json" ]; then
    CORE_SA_MOUNT="-v /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/google-workspace-sa.json:/app/google-workspace-sa.json:ro"
  fi

  docker run -d \
    --name hm-core \
    --network $NETWORK \
    --restart unless-stopped \
    -p 3001:3000 \
    -v /opt/HIVEMIND/core:/app \
    -v /etc/localtime:/etc/localtime:ro \
    $CORE_SA_MOUNT \
    -w /app \
    --env-file "$COOLIFY_ENV" \
    -e NODE_ENV=production \
    -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
    -e "QDRANT_COLLECTION=BUNDB AGENT" \
    -e "DATABASE_URL=postgresql://hivemind_user:hivemind_secure_pwd_2026@${COOLIFY_PG}:5432/hivemind?schema=hivemind&connection_limit=20&pool_timeout=30" \
    -e "REDIS_URL=redis://:redis_secure_vault_7711@${COOLIFY_REDIS}:6379/0" \
    -e "HIVEMIND_ALLOWED_ORIGINS=https://hivemind.davinciai.eu,https://www.davinciai.eu,https://davinciai.eu" \
    -e "WORKSPACE_MCP_URL=http://workspace-mcp:8000" \
    node:20 \
    sh -c "command -v gs >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq --no-install-recommends ghostscript >/dev/null 2>&1; }; sed -i 's#rights=\"none\" pattern=\"PDF\"#rights=\"read|write\" pattern=\"PDF\"#' /etc/ImageMagick-6/policy.xml 2>/dev/null || true; npx prisma generate 2>/dev/null && node scripts/prisma-migrate-deploy.mjs && node src/server.js"

  log "Waiting for health..."
  for i in $(seq 1 30); do
    sleep 2
    if curl -sf http://localhost:3001/health >/dev/null 2>&1; then
      log "hm-core is ${GREEN}healthy${NC}"
      return 0
    fi
    echo -n "."
  done
  err "hm-core not healthy after 60s"
  docker logs hm-core --tail 20
  return 1
}

start_control() {
  log "Starting control-plane (bind-mount /opt/HIVEMIND/core, port 3002)..."
  docker stop hm-control 2>/dev/null || true
  docker rm hm-control 2>/dev/null || true
  ensure_networks

  docker run -d \
    --name hm-control \
    --network $NETWORK \
    --restart unless-stopped \
    -p 3002:3000 \
    -v /opt/HIVEMIND/core:/app \
    -v /etc/localtime:/etc/localtime:ro \
    -w /app \
    --env-file "$COOLIFY_ENV" \
    -e NODE_ENV=production \
    -e PORT=3000 \
    -e "HIVEMIND_API_URL=http://hm-core:3000" \
    -e "HIVEMIND_CORE_API_BASE_URL=http://hm-core:3000" \
    -e "HIVEMIND_CONTROL_PLANE_PUBLIC_URL=https://api.hivemind.davinciai.eu:8040" \
    -e "DATABASE_URL=postgresql://hivemind_user:hivemind_secure_pwd_2026@${COOLIFY_PG}:5432/hivemind?schema=hivemind&connection_limit=20&pool_timeout=30" \
    -e "REDIS_URL=redis://:redis_secure_vault_7711@${COOLIFY_REDIS}:6379/0" \
    -e "HIVEMIND_ALLOWED_ORIGINS=https://hivemind.davinciai.eu,https://www.davinciai.eu,https://davinciai.eu" \
    -e "WORKSPACE_MCP_URL=http://workspace-mcp:8000" \
    node:20 \
    sh -c "npx prisma generate 2>/dev/null; node src/control-plane-server.js"

  log "Waiting for control-plane health..."
  for i in $(seq 1 20); do
    sleep 2
    if curl -sf http://localhost:3002/health >/dev/null 2>&1; then
      log "control-plane is ${GREEN}healthy${NC} on port 3002"
      return 0
    fi
    echo -n "."
  done
  err "control-plane not healthy after 40s"
  docker logs hm-control --tail 20
  return 1
}

verify() {
  local KEY
  KEY=$(grep '^HIVEMIND_MASTER_API_KEY=' "$COOLIFY_ENV" 2>/dev/null | tail -1 | cut -d= -f2-)
  if [ -z "$KEY" ]; then
    KEY=$(grep '^HIVEMIND_API_KEY=' "$COOLIFY_ENV" 2>/dev/null | tail -1 | cut -d= -f2-)
  fi
  if [ -z "$KEY" ]; then
    err "No HIVEMIND_MASTER_API_KEY or HIVEMIND_API_KEY found in $COOLIFY_ENV"
    return 1
  fi

  local B="${HIVEMIND_VERIFY_BASE_URL:-http://localhost:3001}"
  local pass=0 fail=0

  check() {
    local label=$1 url=$2 method=${3:-GET} body=${4:-}
    local code
    if [ "$method" = "POST" ]; then
      code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 15 -X POST -H "X-API-Key:$KEY" -H "Content-Type:application/json" -d "$body" "$url")
    else
      code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 15 -H "X-API-Key:$KEY" "$url")
    fi
    if [ "$code" = "200" ] || [ "$code" = "202" ]; then
      echo -e "  ${GREEN}✓${NC} $label ($code)"
      pass=$((pass+1))
    else
      echo -e "  ${RED}✗${NC} $label ($code)"
      fail=$((fail+1))
    fi
  }

  log "Verifying endpoints..."
  check "Health"          "$B/health"
  check "Memories"        "$B/api/memories?limit=3"
  check "Graph"           "$B/api/graph?limit=5"
  check "Web Limits"      "$B/api/web/limits"
  check "Web Monthly"     "$B/api/web/usage/monthly"
  check "Admin Metrics"   "$B/api/web/admin/metrics"
  check "Domain Policy"   "$B/api/web/policy/check-domain" POST '{"url":"https://example.com"}'
  check "Web Search API"  "$B/api/web/limits"
  check "Eval Dataset"    "$B/api/evaluate/dataset"
  check "Executor Status" "$B/api/swarm/executor/status"
  echo ""
  log "Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
}

status() {
  echo -e "${CYAN}HIVEMIND:${NC}"
  docker ps --filter "name=hm-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null
  echo ""
  echo -e "${CYAN}MiroFish:${NC}"
  docker ps --filter "name=mf-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null
  echo ""
  echo -e "${CYAN}Coolify:${NC}"
  docker ps --filter "name=s0k0s0k40wo44w4w8gcs8ow0" --format "table {{.Names}}\t{{.Status}}" 2>/dev/null
}

logs() {
  docker logs -f --tail 50 "${1:-hm-core}"
}

start_mirofish() {
  log "Building mf-backend image from MiroFish/backend/Dockerfile..."
  docker build -t mirofish-backend:latest /opt/HIVEMIND/MiroFish/backend

  log "Starting mf-backend (port 5001, network $NETWORK)..."
  docker stop mf-backend 2>/dev/null || true
  docker rm   mf-backend 2>/dev/null || true
  ensure_networks

  # Persistent uploads volume — survives redeploys
  docker volume create mirofish-uploads 2>/dev/null || true

  docker run -d \
    --name mf-backend \
    --network $NETWORK \
    --restart unless-stopped \
    -p 5001:5001 \
    -v mirofish-uploads:/app/uploads \
    -v /etc/localtime:/etc/localtime:ro \
    --env-file "$COOLIFY_ENV" \
    -e FLASK_DEBUG=false \
    -e FLASK_PORT=5001 \
    -e GRAPH_PROVIDER=hivemind \
    -e "HIVEMIND_API_URL=http://hm-core:3000" \
    -e HIVEMIND_SYNC_EPISODES=false \
    -e USE_ZEP=false \
    -e "LLM_BASE_URL=https://api.groq.com/openai/v1" \
    -e LLM_MODEL_NAME=groq/compound \
    mirofish-backend:latest

  log "Waiting for mf-backend health..."
  for i in $(seq 1 30); do
    sleep 2
    if curl -sf http://localhost:5001/health >/dev/null 2>&1; then
      log "mf-backend is ${GREEN}healthy${NC} on port 5001"
      return 0
    fi
    echo -n "."
  done
  err "mf-backend not healthy after 60s"
  docker logs mf-backend --tail 30
  return 1
}

start_core_benchmark() {
  log "Starting hm-core in BENCHMARK mode (bge-m3 + BENCHMARK collection)..."
  docker stop hm-core 2>/dev/null || true
  docker rm hm-core 2>/dev/null || true
  ensure_networks

  docker run -d \
    --name hm-core \
    --network $NETWORK \
    --restart unless-stopped \
    -p 3001:3000 \
    -v /opt/HIVEMIND/core:/app \
    -v /etc/localtime:/etc/localtime:ro \
    -w /app \
    --env-file "$COOLIFY_ENV" \
    -e NODE_ENV=production \
    -e "QDRANT_COLLECTION=BENCHMARK" \
    -e "EMBEDDING_PROVIDER=litellm" \
    -e "EMBEDDING_DIMENSION=1024" \
    -e "DATABASE_URL=postgresql://hivemind_user:hivemind_secure_pwd_2026@${COOLIFY_PG}:5432/hivemind?schema=hivemind&connection_limit=20&pool_timeout=30" \
    -e "REDIS_URL=redis://:redis_secure_vault_7711@${COOLIFY_REDIS}:6379/0" \
    -e "HIVEMIND_ALLOWED_ORIGINS=https://hivemind.davinciai.eu,https://www.davinciai.eu,https://davinciai.eu" \
    -e "WORKSPACE_MCP_URL=http://workspace-mcp:8000" \
    node:20 \
    sh -c "command -v gs >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq --no-install-recommends ghostscript >/dev/null 2>&1; }; sed -i 's#rights=\"none\" pattern=\"PDF\"#rights=\"read|write\" pattern=\"PDF\"#' /etc/ImageMagick-6/policy.xml 2>/dev/null || true; npx prisma generate 2>/dev/null && node scripts/prisma-migrate-deploy.mjs && node src/server.js"

  log "Waiting for health..."
  for i in $(seq 1 30); do
    sleep 2
    if curl -sf http://localhost:3001/health >/dev/null 2>&1; then
      log "hm-core is ${GREEN}healthy${NC} (BENCHMARK mode: bge-m3 1024d)"
      return 0
    fi
    echo -n "."
  done
  err "hm-core not healthy after 60s"
  docker logs hm-core --tail 20
  return 1
}

case "${1:-all}" in
  core)              start_core && verify ;;
  benchmark)         start_core_benchmark && verify ;;
  control)           start_control ;;
  mirofish)          start_mirofish ;;
  employees|digital-employees|slack-agents)
                     start_employees ;;
  workspace-mcp|gws) start_workspace_mcp ;;
  restart)           start_workspace_mcp && start_core && start_control && start_mirofish && start_employees && verify ;;
  status)            status ;;
  logs)              logs "${2:-hm-core}" ;;
  verify)            verify ;;
  all)               start_workspace_mcp && start_core && start_control && start_mirofish && start_employees && verify ;;
  *)                 echo "Usage: $0 {all|core|benchmark|control|mirofish|employees|workspace-mcp|restart|status|logs [name]|verify}"; exit 1 ;;
esac
