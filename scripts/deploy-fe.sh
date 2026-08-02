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

# ── GUARD: this tree is SHARED, and the reset below is destructive ────────────
# `git reset --hard` permanently destroys uncommitted work — no stash, no backup,
# no recovery. And /root/hivemind/frontend/Da-vinci is the tree EVERY session on
# this box works in.
#
# Caught 2026-08-02 before it fired: HyperAgents.jsx held 231 uncommitted lines
# (97 insertions / 134 deletions) from a concurrent session, and the live FE image
# had been deployed 18 minutes earlier by that same session — quite possibly built
# FROM that dirty file. Running this would have destroyed the source AND shipped a
# build without it, silently reverting their feature.
#
# A dirty tree is a STOP, not a warning. Find whose work it is first.
DIRTY="$(git status --porcelain | wc -l | tr -d ' ')"
if [ "$DIRTY" != "0" ]; then
  echo "[deploy-fe] REFUSING: $DIRTY uncommitted path(s) in $FE" >&2
  git status --porcelain | head -20 >&2
  echo "[deploy-fe] 'git reset --hard' would DESTROY this work permanently." >&2
  echo "[deploy-fe] Options, in order:" >&2
  echo "[deploy-fe]   1. the owning session commits (then main is a true superset)" >&2
  echo "[deploy-fe]   2. build from a worktree instead of resetting this tree" >&2
  echo "[deploy-fe]   3. git stash push <paths>  — recoverable, but it is not your work" >&2
  echo "[deploy-fe] Override only if you own every path above: FE_ALLOW_DIRTY=1" >&2
  [ "${FE_ALLOW_DIRTY:-}" = "1" ] || exit 1
  echo "[deploy-fe] WARN: FE_ALLOW_DIRTY=1 — discarding the above. This is not reversible." >&2
fi

# Announce who currently serves the FE, so a deploy that supersedes another
# session's release is a visible act rather than a silent one.
LIVE_IMG="$(docker ps --format '{{.Names}} {{.Image}} {{.Status}}' 2>/dev/null \
  | grep -iE 'hm-fe|frontend' | grep -v frozen | head -2 || true)"
[ -n "$LIVE_IMG" ] && echo "[deploy-fe] currently live: $LIVE_IMG"

git fetch origin main -q
git reset --hard "$REF" -q
echo "[deploy-fe] Da-vinci @ $(git rev-parse --short HEAD): $(git log -1 --pretty=%s | cut -c1-60)"
# Tag by COMMIT SHA, not just :latest. A mutable tag hides which code it holds —
# "what is live?" becomes unanswerable and rollback becomes guesswork. This is the
# same rule core follows (sha-<9char>); :latest is still moved so nothing that
# references it breaks, but the SHA tag is the durable identity.
FE_SHA="$(git rev-parse --short=9 HEAD)"
echo "[deploy-fe] building hivemind/fe:sha-${FE_SHA} (+ :latest) …"
if ! docker build -t "hivemind/fe:sha-${FE_SHA}" -t hivemind/fe:latest . >/tmp/fe-build.log 2>&1; then
  echo "[deploy-fe] BUILD FAILED — tail:"; tail -25 /tmp/fe-build.log; exit 1
fi
# Record the outgoing image BEFORE removing the container — inspecting it after
# `docker rm` always yields nothing, which would leave every deploy with an empty
# rollback file exactly when it is needed.
docker inspect hm-fe --format '{{.Config.Image}}' > /root/hivemind/.last-fe-rollback 2>/dev/null || true
[ -s /root/hivemind/.last-fe-rollback ] && echo "[deploy-fe] rollback target: $(cat /root/hivemind/.last-fe-rollback)"
docker rm -f hm-fe >/dev/null 2>&1 || true
docker run -d --name hm-fe --restart unless-stopped -p 8088:80 "hivemind/fe:sha-${FE_SHA}" >/dev/null
sleep 3
code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8088/ || echo 000)"
echo "[deploy-fe] hm-fe up — localhost:8088 → HTTP $code"
[ "$code" = "200" ] || { echo "[deploy-fe] WARN: non-200 from hm-fe"; exit 1; }
REMOTE
echo "✅ FE deployed to ${HOST} (port 8088)."
