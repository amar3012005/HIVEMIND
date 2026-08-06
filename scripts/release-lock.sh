#!/usr/bin/env bash
# release-lock.sh — serialise ALL deploys through one flock so two sessions cannot
# silently supersede each other's release.
#
# Why this exists: on 2026-08-02 two sessions independently built and deployed the
# same services from the same dirty tree. The second deploy replaced the live
# frontend container, the Compose image reference, and the mutable current/latest
# tags — while the first session believed its release was live. Verified fallout on
# core: CHAT_TOP_MEMORY_CHARS and the middle-elision clip (commit 9ae30eda1, pushed)
# were ABSENT from the running container because the other session's image predated
# them. Nothing was corrupted; correctness silently regressed.
#
# Concurrent docker builds also filled the disk until Redis could not complete an
# RDB save and began rejecting session writes.
#
# Usage — wrap the whole build+deploy, not just the deploy:
#   scripts/release-lock.sh scripts/deploy-image.sh
#   scripts/release-lock.sh bash -c 'docker build ... && docker compose up -d ...'
#
# Env:
#   RELEASE_LOCK_WAIT   seconds to wait for the lock (default 1800)
#   RELEASE_LOCK_FILE   lock path (default /var/lock/hivemind-release.lock)

set -euo pipefail

LOCK_FILE="${RELEASE_LOCK_FILE:-/var/lock/hivemind-release.lock}"
WAIT="${RELEASE_LOCK_WAIT:-1800}"
META="${LOCK_FILE}.holder"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args…]" >&2
  exit 2
fi

mkdir -p "$(dirname "$LOCK_FILE")"

# Report who holds it before blocking, so a waiting session knows what it is
# waiting on rather than appearing to hang.
if [ -f "$META" ] && ! flock -n "$LOCK_FILE" true 2>/dev/null; then
  echo "[release-lock] held by: $(cat "$META" 2>/dev/null || echo unknown)" >&2
  echo "[release-lock] waiting up to ${WAIT}s …" >&2
fi

# --- disk guard -------------------------------------------------------------
# A build that fills the disk takes Redis down with it. Refuse below the floor.
AVAIL_GB="$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')"
MIN_GB="${RELEASE_MIN_DISK_GB:-25}"
if [ -n "$AVAIL_GB" ] && [ "$AVAIL_GB" -lt "$MIN_GB" ]; then
  echo "[release-lock] REFUSING: only ${AVAIL_GB}GB free (< ${MIN_GB}GB)." >&2
  echo "[release-lock] reclaim first:  docker builder prune -f" >&2
  exit 1
fi

exec 9>"$LOCK_FILE"
if ! flock -w "$WAIT" 9; then
  echo "[release-lock] TIMEOUT after ${WAIT}s — another release is still running." >&2
  echo "[release-lock] holder: $(cat "$META" 2>/dev/null || echo unknown)" >&2
  exit 1
fi

printf 'pid=%s started=%s cmd=%s\n' "$$" "$(date -u +%FT%TZ)" "$*" > "$META"
trap 'rm -f "$META"' EXIT

echo "[release-lock] acquired (pid $$, ${AVAIL_GB}GB free) — running: $*" >&2
"$@"
