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
env_args() { docker inspect "$1" --format '{{range .Config.Env}}-e {{.}} {{end}}'; }
nets()     { docker inspect "$1" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'; }

log "pulling immutable artifact $REF"
docker pull "$REF"

# 1. Ephemeral smoke against the real env — never route traffic to an unproven image.
FIRST="${CONTAINERS%% *}"
SMOKE="hm-smoke-${IMAGE_TAG:0:12}"
docker rm -f "$SMOKE" >/dev/null 2>&1 || true
# shellcheck disable=SC2046
docker run -d --name "$SMOKE" $(for n in $(nets "$FIRST"); do echo --network "$n"; done) \
  $(env_args "$FIRST") "$REF" >/dev/null
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
  log "swap $c → $REF"
  EARGS="$(env_args "$c")"; NET="$(nets "$c")"
  docker rename "$c" "${c}-old" 2>/dev/null || true
  # shellcheck disable=SC2046,SC2086
  docker run -d --name "$c" --restart unless-stopped \
    $(for n in $NET; do echo --network "$n"; done) $EARGS "$REF" >/dev/null
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
