#!/usr/bin/env bash
# Deploy the exact parent-referenced Da-vinci revision behind
# next.singulancelabs.com/hivemind using an immutable release tag.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
FRONTEND="$ROOT/frontend/Da-vinci"
REF="${1:-HEAD}"
HOST="${SINGULANCE_SSH:-singulance}"
RELEASE_ID="${RELEASE_ID:?Set RELEASE_ID=prod-YYYYMMDD-<parent-sha>}"
SHA="$(git -C "$FRONTEND" rev-parse --verify "$REF")"
SHORT_SHA="${SHA:0:12}"
PARENT_SHA="$(git -C "$ROOT" rev-parse HEAD)"
GITLINK_SHA="$(git -C "$ROOT" ls-tree HEAD frontend/Da-vinci | awk '{print $3}')"
WORKDIR="/root/builds/$RELEASE_ID-frontend"
IMAGE="hivemind/fe:$RELEASE_ID-single"

git -C "$FRONTEND" fetch origin --quiet
test "$SHA" = "$GITLINK_SHA" || {
  echo "Frontend $SHA is not the parent gitlink $GITLINK_SHA. Commit the gitlink first." >&2
  exit 1
}
git -C "$FRONTEND" branch -r --contains "$SHA" | grep -q 'origin/' || {
  echo "Frontend $SHA is not present on an origin branch." >&2
  exit 1
}
git -C "$ROOT" branch -r --contains "$PARENT_SHA" | grep -q 'origin/' || {
  echo "Parent $PARENT_SHA is not present on an origin branch." >&2
  exit 1
}

ssh "$HOST" bash -s -- "$SHA" "$WORKDIR" "$IMAGE" "$RELEASE_ID" <<'REMOTE_SCRIPT'
set -euo pipefail
SHA="$1"
WORKDIR="$2"
IMAGE="$3"
RELEASE_ID="$4"
REPO="https://github.com/amar3012005/Da-vinci.git"
ENV_FILE="/root/hivemind-next/.env.embedding-canary-runtime"
COMPOSE_FILE="/root/hivemind-next/infra/docker-compose.next.yml"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

rm -rf "$WORKDIR"
trap 'docker rm -f hm-frontend-smoke >/dev/null 2>&1 || true; rm -rf "$WORKDIR"' EXIT
git clone --quiet "$REPO" "$WORKDIR"
git -C "$WORKDIR" checkout --quiet "$SHA"
test -z "$(git -C "$WORKDIR" status --porcelain)"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" "$WORKDIR"
fi
docker run -d --name hm-frontend-smoke --rm -p 127.0.0.1:18088:80 "$IMAGE" >/dev/null
sleep 2
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18088/hivemind)" = "200"

PREVIOUS="$(docker inspect hivemind-next-frontend-1 --format '{{.Image}}')"
PREVIOUS_VERSION="$(sed -n 's/^NEXT_VERSION=//p' "$ENV_FILE" | tail -1)"
BACKUP="$ENV_FILE.bak.$STAMP"
docker tag "$PREVIOUS" "hivemind/fe:rollback-$STAMP-single"
cp -a "$ENV_FILE" "$BACKUP"
if grep -q '^NEXT_VERSION=' "$ENV_FILE"; then
  sed -i "s|^NEXT_VERSION=.*|NEXT_VERSION=$RELEASE_ID|" "$ENV_FILE"
else
  printf '\nNEXT_VERSION=%s\n' "$RELEASE_ID" >> "$ENV_FILE"
fi

rollback() {
  cp -a "$BACKUP" "$ENV_FILE"
  if [ -n "$PREVIOUS_VERSION" ]; then
    (cd /root/hivemind-next/infra && docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile single up -d --no-deps --force-recreate frontend)
  fi
}

RESOLVED="$(cd /root/hivemind-next/infra && docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile single config | sed -n 's/^[[:space:]]*image: //p' | grep 'hivemind/fe:' | tail -1)"
test "$RESOLVED" = "$IMAGE" || { echo "Compose resolved $RESOLVED, expected $IMAGE" >&2; rollback; exit 1; }

if ! (cd /root/hivemind-next/infra && docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile single up -d --no-deps --force-recreate frontend); then
  rollback
  exit 1
fi

sleep 2
if ! test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:2388/hivemind)" = "200"; then
  rollback
  exit 1
fi

docker tag "$IMAGE" hivemind/fe:stable-single
docker tag "$IMAGE" hivemind/fe:latest-single
REMOTE_SCRIPT

MAIN_JS="$(curl -fsSL --max-time 20 https://next.singulancelabs.com/hivemind | sed -n 's/.*\(\/static\/js\/main\.[^" ]*\.js\).*/\1/p' | head -1)"
test -n "$MAIN_JS"
curl -fsSL --max-time 20 "https://next.singulancelabs.com$MAIN_JS" >/dev/null
printf 'Deployed frontend %s as %s to https://next.singulancelabs.com/hivemind\n' "$SHORT_SHA" "$RELEASE_ID"
