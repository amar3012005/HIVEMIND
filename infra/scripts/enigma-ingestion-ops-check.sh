#!/usr/bin/env bash
# Content-free Enigma ingestion health gate. This intentionally emits aggregate
# counts only: no tenant IDs, filenames, document text, prompts, or raw errors.
set -euo pipefail

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-hm-postgres}"
STALE_MINUTES="${INGEST_STALE_MINUTES:-20}"
DISK_WARN_PERCENT="${DISK_WARN_PERCENT:-80}"
FAILED_WINDOW_MINUTES="${INGEST_FAILED_WINDOW_MINUTES:-30}"

case "$STALE_MINUTES:$DISK_WARN_PERCENT:$FAILED_WINDOW_MINUTES" in
  *[!0-9:]*|'') echo '{"ok":false,"reason":"invalid_configuration"}' >&2; exit 2 ;;
esac

read -r STALE_JOBS VECTOR_GAPS RECENT_FAILURES <<EOF
$(docker exec "$POSTGRES_CONTAINER" sh -lc "psql -At -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"
SELECT
  count(*) FILTER (WHERE status IN ('queued','processing') AND updated_at < now() - interval '$STALE_MINUTES minutes'),
  (SELECT count(*) FROM hivemind.knowledge_segments WHERE vector_stored = false),
  count(*) FILTER (WHERE status IN ('failed','dead') AND updated_at >= now() - interval '$FAILED_WINDOW_MINUTES minutes')
FROM hivemind.knowledge_ingest_jobs;
\"" | tr '|' ' ')
EOF

DISK_PERCENT="$(df -P /var/lib/docker | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
STALE_JOBS="${STALE_JOBS:-0}"
VECTOR_GAPS="${VECTOR_GAPS:-0}"
RECENT_FAILURES="${RECENT_FAILURES:-0}"
DISK_PERCENT="${DISK_PERCENT:-100}"

OK=true
REASONS=()
(( STALE_JOBS == 0 )) || { OK=false; REASONS+=(stale_jobs); }
(( VECTOR_GAPS == 0 )) || { OK=false; REASONS+=(vector_coverage_gap); }
(( RECENT_FAILURES == 0 )) || { OK=false; REASONS+=(retry_exhaustion); }
(( DISK_PERCENT < DISK_WARN_PERCENT )) || { OK=false; REASONS+=(disk_pressure); }

REASON_CSV="$(IFS=,; echo "${REASONS[*]:-}")"
printf '{"ok":%s,"stale_jobs":%d,"vector_gaps":%d,"recent_failures":%d,"disk_percent":%d,"reasons":"%s"}\n' \
  "$OK" "$STALE_JOBS" "$VECTOR_GAPS" "$RECENT_FAILURES" "$DISK_PERCENT" "$REASON_CSV"

if [[ "$OK" != true && -n "${INGEST_ALERT_WEBHOOK_URL:-}" ]]; then
  # The payload remains aggregate-only. Never attach command output or error text.
  curl --fail --silent --show-error --max-time 10 \
    -H 'content-type: application/json' \
    --data "{\"service\":\"enigma_ingestion\",\"healthy\":false,\"stale_jobs\":$STALE_JOBS,\"vector_gaps\":$VECTOR_GAPS,\"recent_failures\":$RECENT_FAILURES,\"disk_percent\":$DISK_PERCENT}" \
    "$INGEST_ALERT_WEBHOOK_URL" >/dev/null
fi

[[ "$OK" == true ]]
