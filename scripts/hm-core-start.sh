#!/usr/bin/env bash
# HIVEMIND core launcher — BOTH replicas from ONE canonical env + a per-replica overlay.
#
# Why this exists: the two cores were previously started by ad-hoc `docker run`s with
# independent env sets, which silently drifted (one pointed QDRANT_URL at Cloud/384, the
# other at hm-qdrant/1024; RERANK was on one only). This script is the SINGLE source of
# truth for how the cores launch, wired to hm-core.service (systemd) so a reboot / restart
# reproduces the exact verified config. Idempotent: `docker rm -f` then recreate.
#
#   ExecStart=/opt/HIVEMIND/scripts/hm-core-start.sh        (all replicas — default)
#   /opt/HIVEMIND/scripts/hm-core-start.sh hm-core-2        (one replica — rolling restart)
#
# Env precedence: canonical .env first, per-replica overlay second (overlay wins).
set -euo pipefail

CANON=/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/.env
SA=/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/google-workspace-sa.json
CODE=/opt/HIVEMIND/core
NET=hmtest
IMG=node:20
START_CMD='npx prisma generate 2>/dev/null && npx prisma migrate deploy && node src/server.js'

die() { echo "[hm-core-start] FATAL: $*" >&2; exit 1; }

[ -f "$CANON" ] || die "canonical env missing: $CANON"
grep -q '^QDRANT_URL=http://hm-qdrant:6333' "$CANON" \
  || die "canonical env QDRANT_URL is not hm-qdrant — refusing to launch (would re-introduce the Cloud/384 split-brain)"

run_replica() {
  local name="$1" hostport="$2" overlay="$3"
  [ -f "$overlay" ] || die "overlay missing for $name: $overlay"
  echo "[hm-core-start] (re)creating $name on :$hostport (overlay $(basename "$overlay"))"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" \
    --network "$NET" \
    --restart unless-stopped \
    -p "${hostport}:3000" \
    --env-file "$CANON" \
    --env-file "$overlay" \
    -v "$CODE:/app" \
    -v "$SA:/app/google-workspace-sa.json:ro" \
    -v /etc/localtime:/etc/localtime:ro \
    -w /app \
    "$IMG" \
    sh -c "$START_CMD"
}

target="${1:-all}"
case "$target" in
  hm-core)   run_replica hm-core   3001 /opt/HIVEMIND/sing-hm-core.env ;;
  hm-core-2) run_replica hm-core-2 3011 /opt/HIVEMIND/sing-hm-core-2.env ;;
  all)
    run_replica hm-core   3001 /opt/HIVEMIND/sing-hm-core.env
    run_replica hm-core-2 3011 /opt/HIVEMIND/sing-hm-core-2.env
    ;;
  *) die "unknown target '$target' (use: hm-core | hm-core-2 | all)" ;;
esac

echo "[hm-core-start] done ($target)"
