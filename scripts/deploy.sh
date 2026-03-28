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

start_core() {
  log "Starting hm-core (bind-mount /opt/HIVEMIND/core, Coolify .env)..."
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
    -e "DATABASE_URL=postgresql://hivemind_user:hivemind_secure_pwd_2026@${COOLIFY_PG}:5432/hivemind?schema=hivemind&connection_limit=20&pool_timeout=30" \
    -e "REDIS_URL=redis://:redis_secure_vault_7711@${COOLIFY_REDIS}:6379/0" \
    -e "HIVEMIND_ALLOWED_ORIGINS=https://hivemind.davinciai.eu" \
    node:20 \
    sh -c "npx prisma generate 2>/dev/null; npx prisma migrate deploy 2>&1 || echo '[migrate] skipped'; node src/server.js"

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
  log "Restarting control-plane..."
  docker restart $COOLIFY_CONTROL 2>/dev/null || err "control-plane not found"
  sleep 3
  log "Control-plane restarted."
}

verify() {
  local KEY="hmk_live_24c848dbef0e152cf6d47bcb1413d9eb85de48c1e0fb436d"
  local B="https://core.hivemind.davinciai.eu:8050"
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
  check "Web Search"      "$B/api/web/search/jobs" POST '{"query":"test"}'
  check "Eval Results"    "$B/api/evaluate/results"
  check "Executor Status" "$B/api/swarm/executor/status"
  echo ""
  log "Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
}

status() {
  echo -e "${CYAN}HIVEMIND:${NC}"
  docker ps --filter "name=hm-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null
  echo ""
  echo -e "${CYAN}Coolify:${NC}"
  docker ps --filter "name=s0k0s0k40wo44w4w8gcs8ow0" --format "table {{.Names}}\t{{.Status}}" 2>/dev/null
}

logs() {
  docker logs -f --tail 50 "${1:-hm-core}"
}

case "${1:-all}" in
  core)    start_core && verify ;;
  control) start_control ;;
  restart) start_core && start_control && verify ;;
  status)  status ;;
  logs)    logs "${2:-hm-core}" ;;
  verify)  verify ;;
  all)     start_core && start_control && verify ;;
  *)       echo "Usage: $0 {all|core|control|restart|status|logs [name]|verify}"; exit 1 ;;
esac
