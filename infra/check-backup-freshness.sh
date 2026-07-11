#!/usr/bin/env bash
set -euo pipefail

MAX_AGE_MINUTES="${BACKUP_MAX_AGE_MINUTES:-1560}"
POSTGRES_DIR="${POSTGRES_BACKUP_DIR:-/root/backups}"
QDRANT_MARKER="${QDRANT_BACKUP_MARKER:-/root/backups/qdrant/latest.ok}"
failed=0

latest_pg="$(find "$POSTGRES_DIR" -maxdepth 1 -type f -name 'hivemind-*.sql.gz.enc' -mmin "-$MAX_AGE_MINUTES" -print -quit 2>/dev/null || true)"
if [[ -z "$latest_pg" ]]; then echo "CRITICAL: PostgreSQL backup is missing or stale"; failed=1; fi
if [[ ! -f "$QDRANT_MARKER" ]] || ! find "$QDRANT_MARKER" -mmin "-$MAX_AGE_MINUTES" -print -quit | grep -q .; then
  echo "CRITICAL: Qdrant backup is missing or stale"; failed=1
fi

used_percent="$(df -P / | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
if (( used_percent >= 90 )); then echo "CRITICAL: root disk is ${used_percent}% used"; failed=1
elif (( used_percent >= 80 )); then echo "WARNING: root disk is ${used_percent}% used"; fi

if (( failed )); then exit 1; fi
echo "backup freshness: ok; disk=${used_percent}%"
