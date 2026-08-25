#!/usr/bin/env bash
# Shared customer-host paths and release-channel helpers. This file contains no secrets.

HM_INSTALL_DIR="${HIVEMIND_MEMORY_BOX_INSTALL_DIR:-/opt/hivemind-memory-box}"
HM_CONFIG_DIR="${HIVEMIND_MEMORY_BOX_CONFIG_DIR:-/etc/hivemind-memory-box}"
HM_STATE_DIR="${HIVEMIND_MEMORY_BOX_STATE_DIR:-/var/lib/hivemind-memory-box}"
HM_CHANNEL_BASE="${HIVEMIND_MEMORY_BOX_CHANNEL_BASE:-https://get.singulancelabs.com/memory-box}"
HM_LOCK_FILE="${HIVEMIND_MEMORY_BOX_LOCK_FILE:-/run/lock/hivemind-memory-box.lock}"
HM_CHANNEL_FILE="$HM_CONFIG_DIR/channel"
HM_PUBLIC_KEY="${BYOD_RELEASE_PUBLIC_KEY:-$HM_CONFIG_DIR/release.pub}"
HM_CURRENT_RECEIPT="$HM_STATE_DIR/CURRENT_RELEASE.json"
HM_PREVIOUS_RECEIPT="$HM_STATE_DIR/PREVIOUS_RELEASE.json"

hm_die() { printf 'hivemind-memory-box: %s\n' "$*" >&2; exit 1; }
hm_log() { printf 'hivemind-memory-box: %s\n' "$*"; }

hm_require_root() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || hm_die 'run this command as root (sudo)'
}

hm_channel() {
  local value="stable"
  [[ -f "$HM_CHANNEL_FILE" ]] && value="$(tr -d '[:space:]' < "$HM_CHANNEL_FILE")"
  case "$value" in stable|canary) printf '%s\n' "$value" ;; *) hm_die "invalid configured channel: $value" ;; esac
}

hm_atomic_write() {
  local destination="$1" mode="${2:-600}" temporary
  mkdir -p "$(dirname "$destination")"
  temporary="$(mktemp "$(dirname "$destination")/.tmp.XXXXXX")"
  cat > "$temporary"
  chmod "$mode" "$temporary"
  mv -f "$temporary" "$destination"
}

hm_lock() {
  mkdir -p "$(dirname "$HM_LOCK_FILE")"
  exec 9>"$HM_LOCK_FILE"
  flock -n 9 || hm_die 'another install, update, or rollback is already running'
}

hm_download() {
  local url="$1" destination="$2" temporary
  case "$url" in https://*) ;; *) hm_die "release URL must use HTTPS: $url" ;; esac
  temporary="${destination}.partial"
  rm -f "$temporary"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 300 \
    "$url" -o "$temporary"
  mv -f "$temporary" "$destination"
}

hm_json_field() {
  local file="$1" expression="$2"
  node -e "const x=require(process.argv[1]);const v=($expression);if(v===undefined||v===null)process.exit(1);process.stdout.write(typeof v==='string'?v:JSON.stringify(v))" "$file"
}

hm_compose_prefix() {
  HM_COMPOSE=(docker compose)
  [[ -z "${BYOD_COMPOSE_PROJECT_NAME:-}" ]] || HM_COMPOSE+=(-p "$BYOD_COMPOSE_PROJECT_NAME")
  [[ ! -f "$HM_CONFIG_DIR/memory-box.env" ]] || HM_COMPOSE+=(--env-file "$HM_CONFIG_DIR/memory-box.env")
  HM_COMPOSE+=(-f "${BYOD_COMPOSE_FILE:-$HM_INSTALL_DIR/docker-compose.byod.yml}")
}
