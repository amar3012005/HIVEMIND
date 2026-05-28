#!/bin/bash
# ─── Poool MCP Server — Deploy Script ──────────────────────────────────────
#
# Clones, builds, and runs the Poool MCP server in ~/poool-mcp on the server.
# Exposes on a configurable public URL (default: core.hivemind.davinciai.eu:8888)
#
# Usage (run ON the server, or via ssh):
#   bash mcp_poool.sh              — full install + start
#   bash mcp_poool.sh start        — start existing container
#   bash mcp_poool.sh stop         — stop container
#   bash mcp_poool.sh restart      — rebuild + restart
#   bash mcp_poool.sh logs         — tail logs
#   bash mcp_poool.sh status       — show container status
#   bash mcp_poool.sh uninstall    — remove container + image
#
# Claude Code config (add to ~/.claude.json):
#   {
#     "mcpServers": {
#       "poool": {
#         "type": "http",
#         "url": "http://${PUBLIC_HOST}:${PUBLIC_PORT}/mcp"
#       }
#     }
#   }

set -euo pipefail

# ── Config (override with env vars) ─────────────────────────────────────────
PUBLIC_HOST="${PUBLIC_HOST:-core.hivemind.davinciai.eu}"
PUBLIC_PORT="${PUBLIC_PORT:-8888}"
CONTAINER_NAME="poool-mcp"
IMAGE_NAME="poool-mcp"
INSTALL_DIR="${HOME}/poool-mcp"
REPO_URL="https://github.com/fabiankay/poool-mcp.git"

# Poool credentials — set these before running
POOOL_API_BASE_URL="${POOOL_API_BASE_URL:-https://api.poool.fr}"
POOOL_API_TOKEN="${POOOL_API_TOKEN:-}"

# Postgres (Prism analytics warehouse — optional, skip if no warehouse)
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DATABASE="${POSTGRES_DATABASE:-poool}"
POSTGRES_USERNAME="${POSTGRES_USERNAME:-poool}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"

# Colors
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[0;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[poool-mcp]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

# ── Helpers ──────────────────────────────────────────────────────────────────

check_deps() {
  command -v docker >/dev/null 2>&1 || err "docker not found"
  command -v git >/dev/null 2>&1 || err "git not found"
}

clone_or_update() {
  if [ -d "${INSTALL_DIR}/.git" ]; then
    log "Repo exists at ${INSTALL_DIR} — pulling latest..."
    git -C "${INSTALL_DIR}" pull --ff-only
  else
    log "Cloning ${REPO_URL} → ${INSTALL_DIR}"
    git clone "${REPO_URL}" "${INSTALL_DIR}"
  fi
}

write_env() {
  log "Writing ${INSTALL_DIR}/.env"
  cat > "${INSTALL_DIR}/.env" << EOF
# Poool MCP — environment config
# Edit this file then run: bash ${INSTALL_DIR}/mcp_poool.sh restart

# ── Public URL (informational — used by Claude Code config) ─────────────────
PUBLIC_HOST=${PUBLIC_HOST}
PUBLIC_PORT=${PUBLIC_PORT}

# ── Poool REST API ───────────────────────────────────────────────────────────
API_BASE_URL=${POOOL_API_BASE_URL}
API_TOKEN=${POOOL_API_TOKEN}

# ── Poool Prism Warehouse (analytics) — leave blank if no warehouse access ──
POSTGRES_HOST=${POSTGRES_HOST}
POSTGRES_PORT=${POSTGRES_PORT}
POSTGRES_DATABASE=${POSTGRES_DATABASE}
POSTGRES_USERNAME=${POSTGRES_USERNAME}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# ── MCP server internals ─────────────────────────────────────────────────────
MCP_TRANSPORT=streamable-http
MCP_HOST=0.0.0.0
MCP_PORT=8000
MCP_PATH=/mcp
LOG_LEVEL=INFO
MAX_DB_CONNECTIONS=10
EOF
  log ".env written. Edit ${INSTALL_DIR}/.env to set credentials."
}

build_image() {
  log "Building Docker image ${IMAGE_NAME}..."
  docker build -t "${IMAGE_NAME}" "${INSTALL_DIR}"
  log "Image built."
}

stop_container() {
  docker stop "${CONTAINER_NAME}" 2>/dev/null && log "Container stopped." || true
  docker rm   "${CONTAINER_NAME}" 2>/dev/null || true
}

start_container() {
  log "Starting ${CONTAINER_NAME} on host port ${PUBLIC_PORT}..."
  docker run -d \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    -p "${PUBLIC_PORT}:8000" \
    --env-file "${INSTALL_DIR}/.env" \
    "${IMAGE_NAME}"

  # Wait for health
  log "Waiting for container to be ready..."
  local retries=0
  until docker exec "${CONTAINER_NAME}" wget -qO- http://localhost:8000/mcp >/dev/null 2>&1 || [ $retries -ge 20 ]; do
    sleep 2
    retries=$((retries + 1))
  done

  if [ $retries -ge 20 ]; then
    warn "Container may not be ready yet — check logs: docker logs ${CONTAINER_NAME}"
  else
    log "Container healthy."
  fi
}

print_summary() {
  echo ""
  echo -e "${CYAN}─────────────────────────────────────────────${NC}"
  echo -e "${GREEN}Poool MCP is running${NC}"
  echo ""
  echo -e "  Public URL:   ${CYAN}http://${PUBLIC_HOST}:${PUBLIC_PORT}/mcp${NC}"
  echo -e "  Container:    ${CONTAINER_NAME}"
  echo -e "  Install dir:  ${INSTALL_DIR}"
  echo -e "  Config:       ${INSTALL_DIR}/.env"
  echo ""
  echo -e "  Add to Claude Code (${YELLOW}~/.claude.json${NC}):"
  echo -e '  {'
  echo -e '    "mcpServers": {'
  echo -e '      "poool": {'
  echo -e "        \"type\": \"http\","
  echo -e "        \"url\": \"http://${PUBLIC_HOST}:${PUBLIC_PORT}/mcp\""
  echo -e '      }'
  echo -e '    }'
  echo -e '  }'
  echo ""
  echo -e "  Test:  curl http://${PUBLIC_HOST}:${PUBLIC_PORT}/mcp"
  echo -e "${CYAN}─────────────────────────────────────────────${NC}"
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_install() {
  check_deps
  clone_or_update
  write_env

  if [ -z "${POOOL_API_TOKEN}" ]; then
    warn "POOOL_API_TOKEN is empty. Edit ${INSTALL_DIR}/.env before starting."
    warn "Then run: bash ${INSTALL_DIR}/mcp_poool.sh start"
    exit 0
  fi

  build_image
  stop_container
  start_container
  print_summary
}

cmd_start() {
  check_deps
  if ! docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
    warn "Image not found — running full install first"
    cmd_install
    return
  fi
  stop_container
  start_container
  print_summary
}

cmd_restart() {
  check_deps
  clone_or_update
  build_image
  stop_container
  start_container
  print_summary
}

cmd_stop() {
  stop_container
  log "Stopped."
}

cmd_logs() {
  docker logs -f --tail 100 "${CONTAINER_NAME}"
}

cmd_status() {
  echo ""
  docker ps --filter "name=${CONTAINER_NAME}" \
    --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
  echo ""
  echo -e "MCP endpoint: ${CYAN}http://${PUBLIC_HOST}:${PUBLIC_PORT}/mcp${NC}"
}

cmd_uninstall() {
  stop_container
  docker rmi "${IMAGE_NAME}" 2>/dev/null && log "Image removed." || true
  log "Container and image removed. Install dir ${INSTALL_DIR} kept."
}

# ── Main ─────────────────────────────────────────────────────────────────────
case "${1:-install}" in
  install)  cmd_install ;;
  start)    cmd_start ;;
  restart)  cmd_restart ;;
  stop)     cmd_stop ;;
  logs)     cmd_logs ;;
  status)   cmd_status ;;
  uninstall) cmd_uninstall ;;
  *)
    echo "Usage: $0 {install|start|stop|restart|logs|status|uninstall}"
    exit 1
    ;;
esac
