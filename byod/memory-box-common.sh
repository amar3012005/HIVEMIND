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

hm_promote_host_tree() {
  local source="$1" destination="$2" relative target temporary
  [[ -d "$source" ]] || hm_die "host-tool source is missing: $source"
  mkdir -p "$destination"
  while IFS= read -r -d '' relative; do
    relative="${relative#./}"
    [[ -n "$relative" ]] || continue
    target="$destination/$relative"
    if [[ -d "$source/$relative" ]]; then
      mkdir -p "$target"
      continue
    fi
    [[ -f "$source/$relative" && ! -L "$source/$relative" ]] || hm_die "unsupported host-tool entry: $relative"
    mkdir -p "$(dirname "$target")"
    temporary="$(mktemp "$(dirname "$target")/.promote.XXXXXX")"
    cp -p "$source/$relative" "$temporary"
    mv -f "$temporary" "$target"
  done < <(cd "$source" && find . -mindepth 1 -print0)
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

hm_set_env_value() {
  local file="$1" key="$2" value="$3" temporary
  hm_allowed_env_key "$key" || hm_die "unsupported environment key: $key"
  hm_validate_env_value "$key" "$value"
  mkdir -p "$(dirname "$file")"
  temporary="$(mktemp "$(dirname "$file")/.env.XXXXXX")"
  if [[ -f "$file" ]]; then awk -v key="$key" 'index($0,key "=")!=1 {print}' "$file" > "$temporary"; fi
  printf '%s=%s\n' "$key" "$value" >> "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$file"
}

# memory-box.env is a Docker Compose env file, not a shell program. Never
# source it: enrollment and transport values cross a trust boundary and shell
# evaluation would turn a crafted value into root command execution.
hm_validate_env_value() {
  local key="$1" value="$2"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || hm_die "invalid control character in $key"
  [[ "$value" =~ ^[A-Za-z0-9._~:/?=@%+,\-]*$ ]] || hm_die "unsupported character in $key"
}

hm_allowed_env_key() {
  case "$1" in
    HIVEMIND_API_KEY|HIVEMIND_BOX_TOKEN|HIVEMIND_ORG_ID|HIVEMIND_AGENT_IMAGE|HIVEMIND_CENTRAL_URL|VERSION|\
    EMBEDDING_DIMENSION|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB|POSTGRES_IMAGE|QDRANT_IMAGE|\
    AGENT_TOKEN|AGENT_PORT|AGENT_BIND|AGENT_PUBLIC_URL|CLOUDFLARE_TUNNEL_TOKEN|CLOUDFLARED_IMAGE|\
    TS_AUTHKEY|TS_HOSTNAME|TAILSCALE_IMAGE|BYOD_COMPOSE_PROJECT_NAME) return 0 ;;
    *) return 1 ;;
  esac
}

hm_load_env_file() {
  local file="$1" line key value
  [[ -f "$file" ]] || hm_die "configuration not found: $file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || hm_die "invalid configuration line in $file"
    key="${line%%=*}"; value="${line#*=}"
    hm_allowed_env_key "$key" || hm_die "unsupported environment key in $file: $key"
    hm_validate_env_value "$key" "$value"
    printf -v "$key" '%s' "$value"
    export "$key"
  done < "$file"
}

hm_compose_prefix() {
  HM_COMPOSE=(docker compose)
  [[ -z "${BYOD_COMPOSE_PROJECT_NAME:-}" ]] || HM_COMPOSE+=(-p "$BYOD_COMPOSE_PROJECT_NAME")
  [[ ! -f "$HM_CONFIG_DIR/memory-box.env" ]] || HM_COMPOSE+=(--env-file "$HM_CONFIG_DIR/memory-box.env")
  HM_COMPOSE+=(-f "${BYOD_COMPOSE_FILE:-$HM_INSTALL_DIR/docker-compose.byod.yml}")
}
