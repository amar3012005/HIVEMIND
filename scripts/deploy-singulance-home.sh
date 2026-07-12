#!/usr/bin/env bash
# Deploy the committed Da-vinci frontend revision behind
# next.singulancelabs.com/hivemind. It only recreates the compose frontend.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
FRONTEND="$ROOT/frontend/Da-vinci"
REF="${1:-HEAD}"
HOST="${SINGULANCE_SSH:-46.224.4.164}"
SHA="$(git -C "$FRONTEND" rev-parse --verify "$REF")"
SHORT_SHA="${SHA:0:12}"
BRANCH="$(git -C "$FRONTEND" symbolic-ref --quiet --short HEAD)"
REMOTE="root@$HOST"
WORKDIR="/root/singulance-frontend-$SHORT_SHA"
CANDIDATE="hivemind/fe:candidate-$SHORT_SHA-single"

git -C "$FRONTEND" fetch origin --quiet
git -C "$FRONTEND" cat-file -e "$SHA^{commit}"
git -C "$FRONTEND" push origin "$BRANCH" >/dev/null

ssh "$REMOTE" bash -s -- "$SHA" "$WORKDIR" "$CANDIDATE" <<'REMOTE_SCRIPT'
set -euo pipefail
SHA="$1"
WORKDIR="$2"
CANDIDATE="$3"
REPO="https://github.com/amar3012005/Da-vinci.git"

rm -rf "$WORKDIR"
trap 'docker rm -f hm-frontend-smoke >/dev/null 2>&1 || true; rm -rf "$WORKDIR"' EXIT
git clone --quiet "$REPO" "$WORKDIR"
git -C "$WORKDIR" checkout --quiet "$SHA"

docker build -t "$CANDIDATE" "$WORKDIR"
docker run -d --name hm-frontend-smoke --rm -p 127.0.0.1:18088:80 "$CANDIDATE" >/dev/null
sleep 2
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18088/hivemind)" = "200"

PREVIOUS="$(docker inspect hivemind-next-frontend-1 --format '{{.Image}}')"
docker tag "$PREVIOUS" hivemind/fe:stable-single
docker tag "$CANDIDATE" hivemind/fe:latest-single

if ! (cd /root/hivemind-next/infra && NEXT_VERSION=latest docker compose --env-file /root/hivemind-next/.env.embedding-canary-runtime --profile single up -d --no-deps --force-recreate frontend); then
  docker tag "$PREVIOUS" hivemind/fe:latest-single
  (cd /root/hivemind-next/infra && NEXT_VERSION=latest docker compose --env-file /root/hivemind-next/.env.embedding-canary-runtime --profile single up -d --no-deps --force-recreate frontend)
  exit 1
fi

sleep 2
if ! test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:2388/hivemind)" = "200"; then
  docker tag "$PREVIOUS" hivemind/fe:latest-single
  (cd /root/hivemind-next/infra && NEXT_VERSION=latest docker compose --env-file /root/hivemind-next/.env.embedding-canary-runtime --profile single up -d --no-deps --force-recreate frontend)
  exit 1
fi

docker image rm "$CANDIDATE" >/dev/null 2>&1 || true
REMOTE_SCRIPT

MAIN_JS="$(curl -fsSL --max-time 20 https://next.singulancelabs.com/hivemind | sed -n 's/.*\(\/static\/js\/main\.[^" ]*\.js\).*/\1/p' | head -1)"
test -n "$MAIN_JS"
curl -fsSL --max-time 20 "https://next.singulancelabs.com$MAIN_JS" >/dev/null
printf 'Deployed frontend %s to https://next.singulancelabs.com/hivemind\n' "$SHORT_SHA"
