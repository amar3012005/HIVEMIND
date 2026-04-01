#!/bin/bash
# HIVEMIND Remote Deploy — Run from your local laptop
#
# Syncs local code → server, restarts services, verifies endpoints.
# No need to SSH manually — one command does everything.
#
# Usage:
#   ./scripts/remote-deploy.sh              — sync + restart core + control + verify
#   ./scripts/remote-deploy.sh core         — sync + restart core only
#   ./scripts/remote-deploy.sh control      — restart control-plane only
#   ./scripts/remote-deploy.sh sync         — sync code only (no restart)
#   ./scripts/remote-deploy.sh status       — show container status
#   ./scripts/remote-deploy.sh logs [name]  — tail remote logs
#   ./scripts/remote-deploy.sh verify       — verify endpoints
#   ./scripts/remote-deploy.sh ssh          — open SSH session
#   ./scripts/remote-deploy.sh benchmark    — sync + restart in benchmark mode
#
# First-time setup:
#   1. Copy your SSH key: ssh-copy-id root@your-server-ip
#   2. Set SERVER_HOST below (or use env var)
#   3. chmod +x scripts/remote-deploy.sh

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
# Override with env vars: SERVER_HOST=1.2.3.4 ./scripts/remote-deploy.sh
SERVER_HOST="${SERVER_HOST:-5.78.97.200}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_PATH="${SERVER_PATH:-/opt/HIVEMIND}"
SSH_KEY="${SSH_KEY:-}"  # Leave empty to use default key

# Local project root (auto-detect from script location)
LOCAL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# SSH options
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
[ -n "$SSH_KEY" ] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY"

# Colors
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[0;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[deploy]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1"; }

# SSH + remote exec helpers
ssh_cmd() {
  ssh $SSH_OPTS "${SERVER_USER}@${SERVER_HOST}" "$@"
}

remote() {
  ssh_cmd "cd ${SERVER_PATH} && $1"
}

# ── Sync ────────────────────────────────────────────────────────────────────

sync_core() {
  log "Syncing core/ → ${SERVER_HOST}:${SERVER_PATH}/core/"

  rsync -azP --delete \
    --exclude 'node_modules' \
    --exclude '.env' \
    --exclude 'prisma/migrations/manual' \
    --exclude '*.log' \
    --exclude '.prisma' \
    -e "ssh $SSH_OPTS" \
    "${LOCAL_ROOT}/core/" \
    "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/core/"

  log "Core synced."
}

sync_scripts() {
  log "Syncing scripts/ → ${SERVER_HOST}:${SERVER_PATH}/scripts/"

  rsync -azP \
    -e "ssh $SSH_OPTS" \
    "${LOCAL_ROOT}/scripts/" \
    "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/scripts/"

  log "Scripts synced."
}

sync_all() {
  sync_core
  sync_scripts
}

# ── Remote Commands ─────────────────────────────────────────────────────────

restart_core() {
  log "Restarting hm-core on ${SERVER_HOST}..."
  remote "bash scripts/deploy.sh core"
}

restart_core_benchmark() {
  log "Restarting hm-core in BENCHMARK mode on ${SERVER_HOST}..."
  remote "bash scripts/deploy.sh benchmark"
}

restart_control() {
  log "Restarting control-plane on ${SERVER_HOST}..."
  remote "bash scripts/deploy.sh control"
}

verify() {
  log "Verifying endpoints on ${SERVER_HOST}..."
  remote "bash scripts/deploy.sh verify"
}

show_status() {
  log "Status on ${SERVER_HOST}:"
  remote "bash scripts/deploy.sh status"
}

show_logs() {
  local target="${1:-hm-core}"
  log "Tailing ${target} logs on ${SERVER_HOST}... (Ctrl+C to stop)"
  ssh_cmd "docker logs -f --tail 50 ${target}"
}

open_ssh() {
  log "Opening SSH session to ${SERVER_HOST}..."
  ssh $SSH_OPTS "${SERVER_USER}@${SERVER_HOST}" -t "cd ${SERVER_PATH} && bash"
}
#intercewpt

# ── Git Operations ──────────────────────────────────────────────────────────

git_push_frontend() {
  log "Pushing frontend to GitHub (triggers Vercel deploy)..."
  cd "${LOCAL_ROOT}/frontend/Da-vinci"

  if [ -z "$(git status --porcelain)" ]; then
    log "Frontend: no changes to push."
    return 0
  fi

  git add -A
  git commit -m "deploy: $(date +%Y-%m-%d_%H:%M)" || true
  git push origin main
  log "Frontend pushed → Vercel will auto-deploy."
}

# ── Main ────────────────────────────────────────────────────────────────────

check_connection() {
  if ! ssh_cmd "echo ok" >/dev/null 2>&1; then
    err "Cannot connect to ${SERVER_HOST}. Check SSH key and SERVER_HOST."
    exit 1
  fi
}

case "${1:-all}" in
  sync)
    check_connection
    sync_all
    ;;
  core)
    check_connection
    sync_all
    restart_core
    ;;
  control)
    check_connection
    restart_control
    ;;
  benchmark)
    check_connection
    sync_all
    restart_core_benchmark
    ;;
  frontend)
    git_push_frontend
    ;;
  status)
    check_connection
    show_status
    ;;
  logs)
    check_connection
    show_logs "${2:-hm-core}"
    ;;
  verify)
    check_connection
    verify
    ;;
  ssh)
    check_connection
    open_ssh
    ;;
  restart)
    check_connection
    sync_all
    restart_core
    restart_control
    ;;
  all)
    check_connection
    log "Full deploy: sync → core → control → verify"
    echo ""
    sync_all
    restart_core
    restart_control
    git_push_frontend 2>/dev/null || true
    ;;
  *)
    echo "HIVEMIND Remote Deploy"
    echo ""
    echo "Usage: $0 {command}"
    echo ""
    echo "Commands:"
    echo "  all        Sync + restart core + control + push frontend (default)"
    echo "  core       Sync + restart core only"
    echo "  control    Restart control-plane only"
    echo "  benchmark  Sync + restart in benchmark mode (bge-m3 + BENCHMARK collection)"
    echo "  frontend   Push frontend to GitHub (triggers Vercel)"
    echo "  sync       Sync code only (no restart)"
    echo "  restart    Sync + restart core + control"
    echo "  status     Show container status"
    echo "  logs       Tail logs (default: hm-core)"
    echo "  verify     Verify all endpoints"
    echo "  ssh        Open SSH session"
    echo ""
    echo "Config (override with env vars):"
    echo "  SERVER_HOST=${SERVER_HOST}"
    echo "  SERVER_USER=${SERVER_USER}"
    echo "  SERVER_PATH=${SERVER_PATH}"
    echo ""
    echo "Examples:"
    echo "  ./scripts/remote-deploy.sh core                    # Sync + restart core"
    echo "  SERVER_HOST=1.2.3.4 ./scripts/remote-deploy.sh all # Deploy to custom server"
    echo "  ./scripts/remote-deploy.sh logs hm-core            # Tail core logs"
    exit 1
    ;;
esac

echo ""
log "Done."
