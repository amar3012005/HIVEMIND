#!/usr/bin/env bash
# NOW-tier safe deploy: pull an IMMUTABLE image tag, health-gate it in an
# ephemeral container BEFORE touching live traffic, swap each core replica to
# it, verify health post-swap (auto-revert if not), and record the previous tag
# for instant rollback. Replaces "git pull on the box + restart" (no artifact,
# drift-prone — the 383-commits-behind / stash-dance failure mode).
#
# Usage:   IMAGE_TAG=<git-sha> ./scripts/deploy-image.sh
#   env:   IMAGE        registry/name (default ghcr.io/amar3012005/hivemind-core)
#          IMAGE_TAG    REQUIRED — commit sha from CI (build-core-image workflow)
#          CONTAINERS   space-separated core replica names (default "hm-core hm-core-2")
#          HEALTH_PATH  in-container health probe (default /health on :3000)
#          STATE_DIR    where the last-good tag is recorded (default /opt/HIVEMIND/.deploy)
#
# Run ON the prod host. Exits non-zero WITHOUT swapping if the new image fails
# its health smoke. Pair with scripts/rollback.sh.
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/amar3012005/hivemind-core}"
IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required (the git sha from CI)}"
CONTAINERS="${CONTAINERS:-hm-core hm-core-2}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
STATE_DIR="${STATE_DIR:-/opt/HIVEMIND/.deploy}"
REF="${IMAGE}:${IMAGE_TAG}"
PROBE="wget -q -O- http://localhost:3000${HEALTH_PATH} >/dev/null 2>&1"

mkdir -p "$STATE_DIR"
log() { echo "[deploy-image] $*"; }

wait_healthy() { # $1=container
  for _ in $(seq 1 30); do
    docker exec "$1" sh -c "$PROBE" && return 0
    sleep 2
  done
  return 1
}
# Env via a temp --env-file, NOT word-split -e args: an env value containing a space
# (e.g. `..._NAME=DAVINCI AI`) word-splits into a bogus image arg ("invalid reference
# format: repository name (library/AI)"). env-file lines take the rest of the line
# literally, so spaces survive. (Multi-line env values are not supported — none exist.)
env_file() { # $1=container $2=outfile
  docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' > "$2"
}
nets()     { docker inspect "$1" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'; }
# Volumes/binds MUST follow the container across the swap — hm-core mounts /app/data
# (byod-agents registry, mneme shards) + /app/logs; dropping them on swap silently
# detaches the registry and breaks every remote org.
mount_args() {
  docker inspect "$1" --format '{{range .Mounts}}{{if eq .Type "volume"}}-v {{.Name}}:{{.Destination}} {{else}}-v {{.Source}}:{{.Destination}}{{if not .RW}}:ro{{end}} {{end}}{{end}}'
}
# Published ports must survive the swap too (e.g. hm-core 3000/tcp -> host 2026).
port_args() {
  docker inspect "$1" --format '{{range $p,$b := .HostConfig.PortBindings}}{{range $b}}-p {{if .HostIp}}{{.HostIp}}:{{end}}{{.HostPort}}:{{$p}} {{end}}{{end}}' | sed 's|/tcp||g'
}
# Network ALIASES must survive too: compose gives hm-core the service alias `core`, which
# hm-control's HIVEMIND_CORE_API_BASE_URL=http://core:3000 resolves. A bare `docker run
# --network` drops aliases → every /v1/proxy/* 502s (hit live 2026-07-03). Short-hex
# container-id aliases are auto-generated — filter them out.
net_aliases() { # $1=container $2=network → space-separated aliases
  docker inspect "$1" --format "{{with index .NetworkSettings.Networks \"$2\"}}{{range .Aliases}}{{println .}}{{end}}{{end}}" \
    | grep -vE '^[0-9a-f]{12}$' | grep -v '^$' | tr '\n' ' '
}

log "pulling immutable artifact $REF"
docker pull "$REF"

# 1. Ephemeral smoke against the real env — never route traffic to an unproven image.
FIRST="${CONTAINERS%% *}"
SMOKE="hm-smoke-${IMAGE_TAG:0:12}"
docker rm -f "$SMOKE" >/dev/null 2>&1 || true
ENVF="$(mktemp)"; env_file "$FIRST" "$ENVF"
# shellcheck disable=SC2046
docker run -d --name "$SMOKE" $(for n in $(nets "$FIRST"); do echo --network "$n"; done) \
  --env-file "$ENVF" "$REF" >/dev/null
rm -f "$ENVF"
if wait_healthy "$SMOKE"; then log "smoke PASSED"; else
  log "SMOKE FAILED — $REF never healthy. NOT deploying; live traffic untouched."
  docker logs "$SMOKE" --tail 25 2>&1 | sed 's/^/[smoke] /' || true
  docker rm -f "$SMOKE" >/dev/null 2>&1 || true
  exit 1
fi
docker rm -f "$SMOKE" >/dev/null 2>&1 || true

# 2. Record current tag for rollback.
PREV="$(cat "$STATE_DIR/current-tag" 2>/dev/null || echo '')"
[ -n "$PREV" ] && echo "$PREV" > "$STATE_DIR/previous-tag"
log "previous=${PREV:-<unknown>}  new=$IMAGE_TAG"

# 3. Swap each replica one at a time (the health-gated Caddy drains to the other).
for c in $CONTAINERS; do
  if ! docker inspect "$c" >/dev/null 2>&1; then log "skip $c (not present on this host)"; continue; fi
  log "swap $c → $REF"
  NET="$(nets "$c")"; MARGS="$(mount_args "$c")"; PARGS="$(port_args "$c")"
  # Capture each network's aliases BEFORE renaming (inspect keys by original name).
  declare -A NALIAS=()
  for n in $NET; do NALIAS[$n]="$(net_aliases "$c" "$n")"; done
  CENVF="$(mktemp)"; env_file "$c" "$CENVF"
  docker rename "$c" "${c}-old" 2>/dev/null || true
  docker stop "${c}-old" >/dev/null 2>&1 || true   # release ports + volume locks (mneme shard flock) before the new one binds
  # Create WITHOUT --network, then connect each net WITH its aliases, then start — so DNS
  # (e.g. `core`) is correct from the very first packet.
  # shellcheck disable=SC2046,SC2086
  docker create --name "$c" --restart unless-stopped $MARGS $PARGS --env-file "$CENVF" "$REF" >/dev/null
  rm -f "$CENVF"
  # `docker create` attaches a default bridge endpoint — drop it before wiring the real nets.
  docker network disconnect bridge "$c" >/dev/null 2>&1 || true
  for n in $NET; do
    ALIAS_FLAGS=""
    for a in ${NALIAS[$n]:-}; do ALIAS_FLAGS="$ALIAS_FLAGS --alias $a"; done
    # Always alias the container name itself (harmless if duplicated, saves us if capture was empty).
    ALIAS_FLAGS="$ALIAS_FLAGS --alias $c"
    # shellcheck disable=SC2086
    docker network connect $ALIAS_FLAGS "$n" "$c"
  done
  docker start "$c" >/dev/null
  if wait_healthy "$c"; then
    docker rm -f "${c}-old" >/dev/null 2>&1 || true
    log "$c healthy on new image"
  else
    log "POST-SWAP HEALTH FAILED on $c — reverting to ${c}-old"
    docker rm -f "$c" >/dev/null 2>&1 || true
    docker rename "${c}-old" "$c" 2>/dev/null || true
    docker start "$c" >/dev/null 2>&1 || true
    exit 1
  fi
done

echo "$IMAGE_TAG" > "$STATE_DIR/current-tag"
log "DEPLOYED $REF → $CONTAINERS. Rollback: ./scripts/rollback.sh"
