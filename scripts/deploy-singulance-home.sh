#!/usr/bin/env bash
# Deploy the committed Da-vinci frontend revision that serves singulancelabs.com
# and next.singulancelabs.com/hivemind. It only replaces hm-fe.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
FRONTEND="$ROOT/frontend/Da-vinci"
REF="${1:-HEAD}"
HOST="${SINGULANCE_SSH:-46.224.4.164}"
SHA="$(git -C "$FRONTEND" rev-parse --verify "$REF")"
SHORT_SHA="${SHA:0:12}"
BRANCH="$(git -C "$FRONTEND" symbolic-ref --quiet --short HEAD)"
REMOTE="root@$HOST"
WORKDIR="/root/singulance-home-$SHORT_SHA"
CANDIDATE="hivemind/fe:home-candidate-$SHORT_SHA"

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
trap 'docker rm -f hm-fe-home-smoke >/dev/null 2>&1 || true; rm -rf "$WORKDIR"' EXIT
git clone --quiet "$REPO" "$WORKDIR"
git -C "$WORKDIR" checkout --quiet "$SHA"

docker build -t "$CANDIDATE" "$WORKDIR"
docker run -d --name hm-fe-home-smoke --rm -p 127.0.0.1:18088:80 "$CANDIDATE" >/dev/null
sleep 2
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18088/hivemind)" = "200"

PREVIOUS="$(docker inspect hm-fe --format '{{.Image}}')"
docker tag "$PREVIOUS" hivemind/fe:home-stable
docker tag "$CANDIDATE" hivemind/fe:home-latest
docker rm -f hm-fe >/dev/null

if ! docker run -d --name hm-fe --restart unless-stopped -p 8088:80 hivemind/fe:home-latest >/dev/null; then
  docker run -d --name hm-fe --restart unless-stopped -p 8088:80 "$PREVIOUS" >/dev/null
  exit 1
fi

sleep 2
if ! test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8088/hivemind)" = "200"; then
  docker rm -f hm-fe >/dev/null
  docker run -d --name hm-fe --restart unless-stopped -p 8088:80 "$PREVIOUS" >/dev/null
  exit 1
fi

docker image rm "$CANDIDATE" >/dev/null 2>&1 || true
REMOTE_SCRIPT

MAIN_JS="$(curl -fsSL --max-time 20 https://next.singulancelabs.com/hivemind | sed -n 's/.*\(\/static\/js\/main\.[^" ]*\.js\).*/\1/p' | head -1)"
test -n "$MAIN_JS"
curl -fsSL --max-time 20 "https://next.singulancelabs.com$MAIN_JS" >/dev/null
printf 'Deployed frontend %s to https://next.singulancelabs.com/hivemind\n' "$SHORT_SHA"
