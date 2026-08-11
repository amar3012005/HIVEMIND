#!/usr/bin/env bash
# release-presence.sh - shared, local release coordination for parallel agents.
#
# This is deliberately a host-local durable mailbox rather than a WebSocket
# daemon. Every Codex session already has shell access, no long-lived process is
# required, and flock makes a claim atomic with the release lock's host scope.
#
# Commands:
#   claim --session NAME --services core,frontend --sha SHA --summary TEXT
#   heartbeat --session NAME [--phase building]
#   complete --session NAME [--result ok|failed] [--summary TEXT]
#   status [--watch]
#
# A claim expires unless heartbeated. `claim` exits 75 when another non-stale
# session owns an overlapping service, allowing callers to wait instead of
# building an image that would supersede somebody else's release.
set -euo pipefail

ROOT="${RELEASE_PRESENCE_DIR:-/var/lib/hivemind/release-presence}"
TTL="${RELEASE_PRESENCE_TTL_SECONDS:-1800}"
mkdir -p "$ROOT/claims"
LOCK="$ROOT/.lock"
EVENTS="$ROOT/events.jsonl"

command_name="${1:-}"
shift || true
SESSION=""; SERVICES=""; SHA=""; SUMMARY=""; PHASE=""; RESULT="ok"; WATCH=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session) SESSION="$2"; shift 2 ;;
    --services) SERVICES="$2"; shift 2 ;;
    --sha) SHA="$2"; shift 2 ;;
    --summary) SUMMARY="$2"; shift 2 ;;
    --phase) PHASE="$2"; shift 2 ;;
    --result) RESULT="$2"; shift 2 ;;
    --watch) WATCH=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

valid_session() { [[ "$1" =~ ^[A-Za-z0-9._:-]{1,128}$ ]]; }
valid_services() { [[ "$1" =~ ^[A-Za-z0-9,_-]+$ ]]; }
now() { date -u +%s; }
stamp() { date -u +%FT%TZ; }
event() {
  local safe_summary
  safe_summary="$(printf '%s' "$SUMMARY" | tr '\n\r\"' '   ')"
  printf '{"at":"%s","session":"%s","event":"%s","services":"%s","sha":"%s","phase":"%s","result":"%s","summary":"%s"}\n' "$(stamp)" "$SESSION" "$1" "$SERVICES" "$SHA" "$PHASE" "$RESULT" "$safe_summary" >> "$EVENTS"
}
claim_file() { printf '%s/claims/%s' "$ROOT" "$1"; }
overlaps() {
  local a=",$1," b=",$2," item
  IFS=',' read -ra items <<< "$1"
  for item in "${items[@]}"; do [[ "$b" == *",$item,"* ]] && return 0; done
  return 1
}
cleanup_stale() {
  local f updated age
  for f in "$ROOT"/claims/*; do
    [ -f "$f" ] || continue
    updated="$(sed -n 's/^updated=//p' "$f" | head -1)"
    age=$(( $(now) - ${updated:-0} ))
    if [ "$age" -gt "$TTL" ]; then
      SESSION="$(sed -n 's/^session=//p' "$f" | head -1)"; SERVICES="$(sed -n 's/^services=//p' "$f" | head -1)"; SHA="$(sed -n 's/^sha=//p' "$f" | head -1)"; PHASE="stale"; SUMMARY="claim expired after ${age}s"; RESULT="expired"
      event expired; rm -f "$f"
    fi
  done
}
with_lock() { exec 9>"$LOCK"; flock -x 9; cleanup_stale; "$@"; }

claim_impl() {
  local f other other_services
  for f in "$ROOT"/claims/*; do
    [ -f "$f" ] || continue
    other="$(sed -n 's/^session=//p' "$f" | head -1)"; other_services="$(sed -n 's/^services=//p' "$f" | head -1)"
    [ "$other" = "$SESSION" ] && continue
    if overlaps "$SERVICES" "$other_services"; then
      echo "[release-presence] BUSY session=$other services=$other_services $(tr '\n' ' ' < "$f")" >&2
      exit 75
    fi
  done
  PHASE="${PHASE:-claimed}"
  printf 'session=%s\nservices=%s\nsha=%s\nphase=%s\nsummary=%s\nstarted=%s\nupdated=%s\n' "$SESSION" "$SERVICES" "$SHA" "$PHASE" "$SUMMARY" "$(now)" "$(now)" > "$(claim_file "$SESSION")"
  event claimed
  echo "[release-presence] claimed session=$SESSION services=$SERVICES sha=$SHA"
}
heartbeat_impl() {
  local f; f="$(claim_file "$SESSION")"; [ -f "$f" ] || { echo "no active claim for $SESSION" >&2; exit 1; }
  SERVICES="$(sed -n 's/^services=//p' "$f" | head -1)"; SHA="$(sed -n 's/^sha=//p' "$f" | head -1)"
  sed -i "s/^updated=.*/updated=$(now)/; s/^phase=.*/phase=${PHASE:-working}/" "$f"
  event heartbeat
}
complete_impl() {
  local f; f="$(claim_file "$SESSION")"; [ -f "$f" ] || exit 0
  SERVICES="$(sed -n 's/^services=//p' "$f" | head -1)"; SHA="$(sed -n 's/^sha=//p' "$f" | head -1)"; PHASE="complete"
  event completed; rm -f "$f"
}
status_impl() {
  local f; for f in "$ROOT"/claims/*; do [ -f "$f" ] && { echo "---"; cat "$f"; }; done
}

case "$command_name" in
  claim) valid_session "$SESSION" && valid_services "$SERVICES" && [ -n "$SHA" ] || { echo "claim requires safe --session, --services, and --sha" >&2; exit 2; }; with_lock claim_impl ;;
  heartbeat) valid_session "$SESSION" || { echo "heartbeat requires --session" >&2; exit 2; }; with_lock heartbeat_impl ;;
  complete) valid_session "$SESSION" || { echo "complete requires --session" >&2; exit 2; }; with_lock complete_impl ;;
  status) with_lock status_impl; [ "$WATCH" = 1 ] && tail -n 0 -F "$EVENTS" ;;
  *) echo "usage: $0 {claim|heartbeat|complete|status} ..." >&2; exit 2 ;;
esac
