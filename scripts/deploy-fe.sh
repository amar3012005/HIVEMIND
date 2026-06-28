#!/usr/bin/env bash
#
# deploy-fe.sh — build + deploy the SINGULANCE self-host frontend (hm-fe).
#
# The dashboard (frontend/Da-vinci, its own repo) is a CRA build served by Caddy
# in the hivemind/fe:latest image. Control-plane/core URLs are baked at BUILD time
# via Dockerfile ARGs (default → *.singulancelabs.com), so a redeploy = rebuild.
# This pulls the latest Da-vinci `main` on the box, rebuilds, and recreates the
# standalone hm-fe container (bridge net, restart unless-stopped, :8088→80).
#
# Usage: scripts/deploy-fe.sh [git-ref]      # default ref: origin/main
# Env:   SINGULANCE_SSH (ssh host alias, default "singulance")
set -euo pipefail

HOST="${SINGULANCE_SSH:-singulance}"
REF="${1:-origin/main}"

ssh -o ConnectTimeout=25 "$HOST" bash -s "$REF" <<'REMOTE'
set -euo pipefail
REF="$1"
FE=/root/hivemind/frontend/Da-vinci
cd "$FE"
git fetch origin main -q
git reset --hard "$REF" -q
echo "[deploy-fe] Da-vinci @ $(git rev-parse --short HEAD): $(git log -1 --pretty=%s | cut -c1-60)"
echo "[deploy-fe] building hivemind/fe:latest …"
if ! docker build -t hivemind/fe:latest . >/tmp/fe-build.log 2>&1; then
  echo "[deploy-fe] BUILD FAILED — tail:"; tail -25 /tmp/fe-build.log; exit 1
fi
docker rm -f hm-fe >/dev/null 2>&1 || true
docker run -d --name hm-fe --restart unless-stopped -p 8088:80 hivemind/fe:latest >/dev/null
sleep 3
code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8088/ || echo 000)"
echo "[deploy-fe] hm-fe up — localhost:8088 → HTTP $code"
[ "$code" = "200" ] || { echo "[deploy-fe] WARN: non-200 from hm-fe"; exit 1; }
REMOTE
echo "✅ FE deployed to ${HOST} (port 8088)."
