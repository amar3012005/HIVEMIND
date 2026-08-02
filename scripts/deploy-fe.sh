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

# ── BUILD FROM A WORKTREE, NEVER FROM THE SHARED TREE ─────────────────────────
# Same model as core: `main` is the one clean production branch, sessions work in
# their own branches, and a release builds from a throwaway checkout of a named
# commit. The shared tree is never reset, so a session with uncommitted work is
# not a blocker and cannot be destroyed.
#
# What this replaces: `cd $FE && git reset --hard "$REF"`. That permanently
# destroyed uncommitted work in the tree EVERY session shares — caught 2026-08-02
# with 231 uncommitted lines of HyperAgents.jsx sitting in it, from a session that
# had deployed 18 minutes earlier. The reset would have destroyed the source AND
# shipped a build without it.
git -C "$FE" fetch origin --quiet --prune

# Resolve the ref to an immutable SHA up front, so what gets built, tagged and
# rolled back to are all provably the same commit.
FE_SHA_FULL="$(git -C "$FE" rev-parse --verify "${REF}^{commit}" 2>/dev/null)" || {
  echo "[deploy-fe] REFUSING: '$REF' does not resolve to a commit in $FE" >&2; exit 1; }
FE_SHA="$(git -C "$FE" rev-parse --short=9 "$FE_SHA_FULL")"

# The commit must be on the remote. A build from a box-only commit is
# unreproducible and cannot be rolled forward by anyone else.
if [ -z "$(git -C "$FE" branch -r --contains "$FE_SHA_FULL" 2>/dev/null | head -1)" ]; then
  echo "[deploy-fe] REFUSING: $FE_SHA is on NO remote branch — push it first." >&2
  echo "[deploy-fe]   git -C $FE push origin HEAD:main" >&2
  [ "${FE_ALLOW_UNPUSHED:-}" = "1" ] || exit 1
  echo "[deploy-fe] WARN: FE_ALLOW_UNPUSHED=1 — this build is not reproducible." >&2
fi

BUILD_DIR="/root/builds/fe-${FE_SHA}"
cleanup() { git -C "$FE" worktree remove --force "$BUILD_DIR" >/dev/null 2>&1 || true; }
trap cleanup EXIT

rm -rf "$BUILD_DIR"; mkdir -p /root/builds
git -C "$FE" worktree prune >/dev/null 2>&1 || true
git -C "$FE" worktree add --detach "$BUILD_DIR" "$FE_SHA_FULL" >/dev/null
cd "$BUILD_DIR"
echo "[deploy-fe] worktree @ ${FE_SHA}: $(git log -1 --pretty=%s | cut -c1-60)"

# Announce who currently serves the FE, so superseding another session's release
# is a visible act rather than a silent one.
LIVE_IMG="$(docker ps --format '{{.Names}} {{.Image}} {{.Status}}' 2>/dev/null \
  | grep -iE 'hm-fe|frontend' | grep -v frozen | head -2 || true)"
[ -n "$LIVE_IMG" ] && echo "[deploy-fe] currently live: $LIVE_IMG"

# Tag by COMMIT SHA. A mutable-only tag makes "what is live?" unanswerable and
# rollback guesswork; :latest still moves so nothing referencing it breaks.
echo "[deploy-fe] building hivemind/fe:sha-${FE_SHA} (+ :latest) …"
if ! docker build -t "hivemind/fe:sha-${FE_SHA}" -t hivemind/fe:latest . >/tmp/fe-build.log 2>&1; then
  echo "[deploy-fe] BUILD FAILED — tail:"; tail -25 /tmp/fe-build.log; exit 1
fi

# Record the outgoing image BEFORE removing the container — inspecting it after
# `docker rm` always yields nothing, leaving an empty rollback file exactly when
# it is needed.
docker inspect hm-fe --format '{{.Config.Image}}' > /root/hivemind/.last-fe-rollback 2>/dev/null || true
[ -s /root/hivemind/.last-fe-rollback ] && echo "[deploy-fe] rollback target: $(cat /root/hivemind/.last-fe-rollback)"
docker rm -f hm-fe >/dev/null 2>&1 || true
docker run -d --name hm-fe --restart unless-stopped -p 8088:80 "hivemind/fe:sha-${FE_SHA}" >/dev/null
sleep 3
code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8088/ || echo 000)"
echo "[deploy-fe] hm-fe up — localhost:8088 → HTTP $code (sha-${FE_SHA})"
[ "$code" = "200" ] || { echo "[deploy-fe] WARN: non-200 from hm-fe"; exit 1; }
REMOTE
echo "✅ FE deployed to ${HOST} (port 8088)."
