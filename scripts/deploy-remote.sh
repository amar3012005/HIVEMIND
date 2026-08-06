#!/usr/bin/env bash
# deploy-remote.sh — deploy core or control-plane, triggered from a laptop, but
# BUILT and RUN entirely on the box. MacBook-session equivalent of deploy-fe.sh:
# the laptop never builds, never rsyncs a working tree, never touches a running
# container directly. It only tells the box which already-pushed commit to
# build and deploy.
#
# What this deliberately does NOT do: scripts/remote-deploy.sh rsync's the
# LAPTOP'S RAW WORKING TREE (dirty or not, --delete) straight onto the server
# and restarts. That is the exact shape of the 2026-08-01 incident (see
# CLAUDE.md's top rule) -- code running in prod that exists in no committed
# branch. Do not use remote-deploy.sh for core/control; it predates and
# contradicts that rule. This script only ever builds from a commit that is
# provably an ancestor of origin/singulance-main.
#
# Usage (run from your laptop):
#   scripts/deploy-remote.sh core                       # deploy latest singulance-main
#   scripts/deploy-remote.sh control origin/singulance-main
#   scripts/deploy-remote.sh core <commit-sha>          # deploy a specific merged commit
#
# Env: SINGULANCE_SSH   ssh host alias (default "singulance", same as deploy-fe.sh)
set -euo pipefail

SERVICE="${1:?usage: deploy-remote.sh core-or-control ref}"
REF="${2:-origin/singulance-main}"
HOST="${SINGULANCE_SSH:-singulance}"

case "$SERVICE" in
  core)    IMAGE_REPO="hivemind/core-api";      DOCKERFILE="Dockerfile.production";     CONTAINER="hm-core";    COMPOSE_SVC="core" ;;
  control) IMAGE_REPO="hivemind/control-plane"; DOCKERFILE="Dockerfile.control-plane";  CONTAINER="hm-control"; COMPOSE_SVC="control" ;;
  *) echo "deploy-remote: unknown service '$SERVICE' -- must be core or control" >&2; exit 2 ;;
esac

ssh -o ConnectTimeout=25 "$HOST" bash -s "$SERVICE" "$REF" "$IMAGE_REPO" "$DOCKERFILE" "$CONTAINER" "$COMPOSE_SVC" <<'REMOTE'
set -euo pipefail
SERVICE="$1" REF="$2" IMAGE_REPO="$3" DOCKERFILE="$4" CONTAINER="$5" COMPOSE_SVC="$6"
REPO=/root/hivemind
COMPOSE_FILE="$REPO/infra/docker-compose.hetzner.yml"

git -C "$REPO" fetch origin --quiet --prune
SHA_FULL="$(git -C "$REPO" rev-parse --verify "${REF}^{commit}" 2>/dev/null)" || {
  echo "deploy-remote: REFUSING -- '$REF' does not resolve to a commit" >&2; exit 1; }
SHA="$(git -C "$REPO" rev-parse --short=9 "$SHA_FULL")"

if ! git -C "$REPO" merge-base --is-ancestor "$SHA_FULL" origin/singulance-main; then
  echo "deploy-remote: REFUSING -- $SHA is not an ancestor of origin/singulance-main." >&2
  echo "deploy-remote:   singulance-main is the only deployable ref -- merge your PR first." >&2
  exit 1
fi

LOCKSH="$REPO/scripts/path-lock.sh"
[ -x "$LOCKSH" ] && "$LOCKSH" acquire "infra/docker-compose.hetzner.yml" "deploy-remote.sh $SERVICE@$SHA"
release_lock() { [ -x "$LOCKSH" ] && "$LOCKSH" release "infra/docker-compose.hetzner.yml" || true; }

BUILD_DIR="/root/builds/deploy-${SERVICE}-${SHA}"
cleanup() { git -C "$REPO" worktree remove --force "$BUILD_DIR" >/dev/null 2>&1 || true; release_lock; }
trap cleanup EXIT

rm -rf "$BUILD_DIR"; mkdir -p /root/builds
git -C "$REPO" worktree prune >/dev/null 2>&1 || true
git -C "$REPO" worktree add --detach "$BUILD_DIR" "$SHA_FULL" >/dev/null
cd "$BUILD_DIR"
echo "deploy-remote: worktree @ ${SHA}: $(git log -1 --pretty=%s | cut -c1-60)"

if [ -x "./scripts/preflight-deploy.sh" ]; then
  ./scripts/preflight-deploy.sh || { echo "deploy-remote: preflight FAILED" >&2; exit 1; }
fi

TAG="${IMAGE_REPO}:sha-${SHA}"
echo "deploy-remote: building ${TAG} from ${DOCKERFILE} ..."
if ! docker build -f "$DOCKERFILE" --build-arg CACHE_BUST="$(date +%s)" -t "$TAG" . >/tmp/deploy-remote-build.log 2>&1; then
  echo "deploy-remote: BUILD FAILED -- tail:"; tail -30 /tmp/deploy-remote-build.log; exit 1
fi

PREV_TAG="$(grep -A2 "container_name: ${CONTAINER}$" "$COMPOSE_FILE" | grep "image:" | awk '{print $2}' || true)"
[ -z "$PREV_TAG" ] && PREV_TAG="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true)"
echo "deploy-remote: previous image: ${PREV_TAG:-unknown}"

if [ -n "$PREV_TAG" ]; then
  sed -i "s#image: ${PREV_TAG}#image: ${TAG}#" "$COMPOSE_FILE"
else
  echo "deploy-remote: REFUSING -- could not find current image for ${CONTAINER} in compose. Edit it by hand once, then retry." >&2
  exit 1
fi

docker compose --env-file "$REPO/.env" -f "$COMPOSE_FILE" up -d "$COMPOSE_SVC"

HEALTHY=0
for _ in $(seq 1 30); do
  st="$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo none)"
  [ "$st" = "healthy" ] && { HEALTHY=1; break; }
  sleep 2
done

if [ "$HEALTHY" = "1" ]; then
  echo "deploy-remote: DEPLOYED ${TAG} onto ${CONTAINER} -- healthy."
  ./scripts/record-deployment.sh --service "$SERVICE" --sha "$SHA" --image "$TAG" --rollback "$PREV_TAG" --health true 2>/dev/null || true
else
  echo "deploy-remote: HEALTH FAILED on ${CONTAINER} -- reverting compose to ${PREV_TAG}" >&2
  sed -i "s#image: ${TAG}#image: ${PREV_TAG}#" "$COMPOSE_FILE"
  docker compose --env-file "$REPO/.env" -f "$COMPOSE_FILE" up -d "$COMPOSE_SVC" >/dev/null 2>&1 || true
  ./scripts/record-deployment.sh --service "$SERVICE" --sha "$SHA" --image "$TAG" --rollback "$PREV_TAG" --health false 2>/dev/null || true
  exit 1
fi
REMOTE
echo "DONE: ${SERVICE} deployed to ${HOST} at ${REF}."
