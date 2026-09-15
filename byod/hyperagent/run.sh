#!/usr/bin/env bash
# Local HyperAgent-only Harness (native web). Does not deploy production.
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="${HIVEMIND_HYPERAGENT_ENV_FILE:-$PWD/.env}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$PWD/docker-compose.hyperagent.yml")

log(){ printf '[byod-hyperagent] %s\n' "$*"; }
die(){ printf '[byod-hyperagent] %s\n' "$*" >&2; exit 1; }

ensure_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    cp env.example "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    log "wrote $ENV_FILE"
  else
    while IFS= read -r line; do
      [[ "$line" =~ ^[A-Z_][A-Z0-9_]*= ]] || continue
      key="${line%%=*}"
      grep -q "^${key}=" "$ENV_FILE" || echo "$line" >> "$ENV_FILE"
    done < env.example
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  [[ "${#HIVE_HARNESS_TICKET_SECRET}" -ge 32 ]] || die "HIVE_HARNESS_TICKET_SECRET must be >= 32 chars"
  [[ "${#HIVE_HARNESS_RUNNER_SERVICE_SECRET}" -ge 32 ]] || die "HIVE_HARNESS_RUNNER_SERVICE_SECRET must be >= 32 chars"
  [[ "$HIVE_HARNESS_TICKET_SECRET" != "$HIVE_HARNESS_RUNNER_SERVICE_SECRET" ]] || die "ticket and runner secrets must differ"
}

ensure_fs() {
  local org="${HIVEMIND_ORG_ID:-00000000-0000-4000-8000-000000000001}"
  local root="$PWD/data/fs/org/${org}"
  mkdir -p "$root/shared" "$root/users/${HIVEMIND_USER_ID:-_owner}/workspace"
  log "filesystem $root"
}

wait_health() {
  local port="${HARNESS_PORT:-13080}" i
  for i in $(seq 1 40); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      log "healthy http://127.0.0.1:${port}"
      return 0
    fi
    sleep 2
  done
  docker logs hm-byod-harness --tail 80 >&2 || true
  die "harness did not become healthy on :${port}"
}

command_name="${1:-up}"
case "$command_name" in
  up)
    command -v docker >/dev/null || die "Docker is required"
    docker info >/dev/null 2>&1 || die "Docker daemon is not reachable"
    docker network inspect hivemind-network >/dev/null 2>&1 || die "hivemind-network is missing; start local HIVEMIND compose first"
    ensure_env
    ensure_fs
    "${COMPOSE[@]}" up -d --build --force-recreate --remove-orphans
    wait_health
    ;;
  down)
    ensure_env
    "${COMPOSE[@]}" down
    ;;
  logs)
    docker logs hm-byod-harness --tail 100
    ;;
  *)
    die "usage: $0 [up|down|logs]"
    ;;
esac
