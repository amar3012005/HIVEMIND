#!/usr/bin/env bash
# path-lock.sh — an advisory "session X is touching this file, don't" flag for the
# handful of genuinely high-conflict paths: docker-compose.hetzner.yml, the Prisma
# schema, release-lock.sh itself.
#
# This is deliberately NOT a lease system with heartbeats, expiry, or enforcement.
# It is one file per locked path saying who holds it and since when. A session
# checks before editing; nothing stops them if they skip the check — the discipline
# is the point, not a mechanism that would need its own correctness guarantees.
# (A lease system that itself has a bug is a worse failure than no lease system —
# see the session notes on why the bigger proposal was rejected.)
#
# Usage:
#   scripts/path-lock.sh acquire infra/docker-compose.hetzner.yml "fixing FE service"
#   scripts/path-lock.sh status
#   scripts/path-lock.sh status infra/docker-compose.hetzner.yml
#   scripts/path-lock.sh release infra/docker-compose.hetzner.yml
#
# Locks live in LOCK_DIR, one file per path, named by a filesystem-safe encoding of
# the path. Each lock file holds: holder, timestamp, and the free-text reason.
set -euo pipefail

LOCK_DIR="${PATH_LOCK_DIR:-/root/hivemind/.locks}"
mkdir -p "$LOCK_DIR"

_slug() { echo "$1" | tr '/' '_'; }

cmd="${1:-}"
case "$cmd" in
  acquire)
    path="${2:?usage: path-lock.sh acquire <path> [reason]}"
    reason="${3:-}"
    lockfile="$LOCK_DIR/$(_slug "$path").lock"
    if [ -f "$lockfile" ]; then
      echo "[path-lock] ALREADY LOCKED: $path" >&2
      cat "$lockfile" >&2
      echo "[path-lock] if that holder is gone, release it yourself before overriding — do not silently steal the lock." >&2
      exit 1
    fi
    holder="${SUDO_USER:-${USER:-unknown}}@$(hostname -s 2>/dev/null || echo unknown) (pid $$)"
    printf 'path=%s\nholder=%s\nsince=%s\nreason=%s\n' "$path" "$holder" "$(date -u +%FT%TZ)" "$reason" > "$lockfile"
    echo "[path-lock] acquired: $path (holder=$holder)" >&2
    ;;
  release)
    path="${2:?usage: path-lock.sh release <path>}"
    lockfile="$LOCK_DIR/$(_slug "$path").lock"
    rm -f "$lockfile"
    echo "[path-lock] released: $path" >&2
    ;;
  status)
    path="${2:-}"
    if [ -n "$path" ]; then
      lockfile="$LOCK_DIR/$(_slug "$path").lock"
      if [ -f "$lockfile" ]; then cat "$lockfile"; else echo "[path-lock] not locked: $path"; fi
    else
      shopt -s nullglob
      files=("$LOCK_DIR"/*.lock)
      shopt -u nullglob
      if [ "${#files[@]}" -eq 0 ]; then
        echo "[path-lock] no active locks"
      else
        for f in "${files[@]}"; do echo "---"; cat "$f"; done
      fi
    fi
    ;;
  *)
    echo "usage: $0 {acquire|release|status} [path] [reason]" >&2
    echo "recommended paths to lock before editing:" >&2
    echo "  infra/docker-compose.hetzner.yml" >&2
    echo "  core/prisma/schema.prisma" >&2
    echo "  scripts/release-lock.sh" >&2
    exit 2
    ;;
esac
