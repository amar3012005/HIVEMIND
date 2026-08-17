#!/usr/bin/env bash
# runtime-probe.sh — terminal-driven HQ Runtime harness for the real
# production tenant (support@singulancelabs.com / org "Singulance"), so a
# session can start/stop/refresh/watch Runtime and see everything the FE
# terminal shows (narration, tasks, popups) without a browser and without
# rebuilding or redeploying any container.
#
# Standing rule from the account owner (2026-08-17): stop writing dead
# one-off scratch probe scripts per session. This is the ONE reusable,
# checked-in harness for HQ Runtime activity going forward — extend it,
# do not fork it.
#
# Auth: does not run the OIDC login flow. It mints a real session the exact
# same way control-plane's own login handlers do — sessionStore.createSession
# ({userId, email, orgId}) — by writing directly to the same Redis key
# (`cp:session:<uuid>`) the app reads via its Bearer-token path
# (control-plane-server.js getCurrentSession: Authorization: Bearer <sessionId>
# is checked with no HMAC, only the browser cookie path is signed). This is
# the app's own session mechanism, not a bypass — every request this script
# makes is a normal authenticated API call as that real user.
#
# Usage:
#   scripts/runtime-probe.sh --start            # wake the runtime (idempotent if already running)
#   scripts/runtime-probe.sh --stop             # pause the runtime
#   scripts/runtime-probe.sh --refresh          # re-fetch full state (read-only snapshot)
#   scripts/runtime-probe.sh --restart          # DESTRUCTIVE full reset — requires --yes
#   scripts/runtime-probe.sh --status           # one-shot status dump (runtime + tasks + brief)
#   scripts/runtime-probe.sh --watch            # stream live events until Ctrl-C, one line per event
#   scripts/runtime-probe.sh --e2e [minutes]    # autonomous run: start, auto-approve every popup
#                                                # it can (approval_required / decision_required),
#                                                # SKIP capability_required (needs real OAuth, never
#                                                # faked), until idle or the time budget (default 20m)
#                                                # runs out. See runtime-probe-e2e.py for the loop.
#   scripts/runtime-probe.sh --instruct "text"  # send a new operating instruction
#   scripts/runtime-probe.sh --session          # print the minted Bearer token and exit (for manual curl)
#
# Env overrides:
#   RUNTIME_PROBE_HOST   ssh alias for the box (default: singulance)
#   RUNTIME_PROBE_BASE   control-plane base URL (default: https://api.singulancelabs.com)
#   RUNTIME_PROBE_EMAIL  tenant user to act as (default: support@singulancelabs.com)
#
# Every mutating command re-mints a fresh session (cheap: one Redis SET over
# an existing ssh connection) rather than caching one, so a stale/expired
# token is never a source of a confusing failure.

set -euo pipefail

HOST="${RUNTIME_PROBE_HOST:-singulance}"
BASE="${RUNTIME_PROBE_BASE:-https://api.singulancelabs.com}"
EMAIL="${RUNTIME_PROBE_EMAIL:-support@singulancelabs.com}"

# ── popup mapping (best-effort, cross-referenced against
# frontend/Da-vinci/src/components/hivemind/app/hyperagents/HqRuntimeConsole.jsx
# as of 2026-08-17 — re-verify against the live browser if the FE's own
# decision-surfacing logic changes) ────────────────────────────────────────
# These are the hq_runtime_event eventTypes that the Runtime terminal renders
# as something requiring a human decision (a "popup" in the user's terms) —
# not routine narration.
POPUP_EVENT_TYPES="approval_required capability_required"

_mint_session() {
  # Prints ONLY the session UUID on stdout. All diagnostics go to stderr so
  # `--session` and command substitution stay clean.
  ssh "$HOST" bash -s -- "$EMAIL" <<'REMOTE_SCRIPT'
set -euo pipefail
EMAIL="$1"
REDIS_PASSWORD="$(grep -m1 '^REDIS_PASSWORD=' /root/hivemind/.env | cut -d= -f2-)"
ROW="$(docker exec hm-postgres psql -U hivemind_user -d hivemind -t -A -c \
  "SELECT u.id || '|' || uo.org_id FROM hivemind.users u JOIN hivemind.user_organizations uo ON uo.user_id = u.id WHERE u.email = '${EMAIL}' LIMIT 1;")"
if [ -z "$ROW" ]; then echo "FATAL: no user_organizations row for ${EMAIL}" >&2; exit 1; fi
USER_ID="${ROW%%|*}"
ORG_ID="${ROW##*|}"
SESSION_ID="$(cat /proc/sys/kernel/random/uuid)"
PAYLOAD="{\"userId\":\"${USER_ID}\",\"email\":\"${EMAIL}\",\"orgId\":\"${ORG_ID}\",\"createdAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}"
docker exec hm-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning \
  SET "cp:session:${SESSION_ID}" "$PAYLOAD" EX 3600 > /dev/null
echo "$SESSION_ID"
REMOTE_SCRIPT
}

_curl() {
  local method="$1" path="$2" data="${3:-}"
  local session; session="$(_mint_session)"
  if [ -n "$data" ]; then
    curl -sS -X "$method" "${BASE}${path}" \
      -H "Authorization: Bearer ${session}" -H "Content-Type: application/json" \
      -d "$data"
  else
    curl -sS -X "$method" "${BASE}${path}" \
      -H "Authorization: Bearer ${session}"
  fi
}

_jq_or_cat() {
  if command -v jq >/dev/null 2>&1; then jq .; else cat; fi
}

_utc_now() { date -u +"%H:%M:%S.%3N"; }

cmd_session() {
  local session; session="$(_mint_session)"
  echo "$session"
}

cmd_status() {
  echo "=== runtime ($(_utc_now) UTC) ==="
  _curl GET /v1/hq/runtime | _jq_or_cat
  echo
  echo "=== tasks / work orders ==="
  _curl GET /v1/hq/work | _jq_or_cat
  echo
  echo "=== first-life / activation sprint ==="
  _curl GET /v1/hq/first-life/current | _jq_or_cat
}

cmd_start() {
  # /v1/hq/wake correctly refuses (409 hq_runtime_paused) when the runtime is
  # paused — that's /v1/hq/resume's job. Check state first so --start always
  # does the right thing regardless of current state, instead of surfacing a
  # confusing 409 to whoever's testing.
  local state; state="$(_curl GET /v1/hq/runtime | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("runtime") or {}).get("state",""))' 2>/dev/null || echo "")"
  if [ "$state" = "PAUSED" ]; then
    echo "=== POST /v1/hq/resume ($(_utc_now) UTC) — was PAUSED ==="
    _curl POST /v1/hq/resume '{}' | _jq_or_cat
  else
    echo "=== POST /v1/hq/wake ($(_utc_now) UTC) — was ${state:-unknown} ==="
    _curl POST /v1/hq/wake '{}' | _jq_or_cat
  fi
}

cmd_stop() {
  echo "=== POST /v1/hq/pause ($(_utc_now) UTC) ==="
  _curl POST /v1/hq/pause '{}' | _jq_or_cat
}

cmd_refresh() {
  # Read-only by design — "refresh my view of the truth" never mutates.
  # Use --start to actually force a new cycle.
  cmd_status
}

cmd_restart() {
  if [ "${1:-}" != "--yes" ]; then
    echo "FATAL: --restart deletes every RuntimePlaybookRun for this org and resets the runtime." >&2
    echo "Re-run as: scripts/runtime-probe.sh --restart --yes" >&2
    exit 2
  fi
  echo "=== POST /v1/hq/restart ($(_utc_now) UTC) — DESTRUCTIVE ==="
  _curl POST /v1/hq/restart '{}' | _jq_or_cat
}

cmd_instruct() {
  local text="${1:-}"
  if [ -z "$text" ]; then echo "FATAL: --instruct requires a text argument" >&2; exit 2; fi
  local payload; payload="$(printf '{"instruction":%s}' "$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"
  echo "=== POST /v1/hq/instructions ($(_utc_now) UTC) ==="
  _curl POST /v1/hq/instructions "$payload" | _jq_or_cat
}

_write_event_formatter() {
  RUNTIME_PROBE_PY_HELPER="$(mktemp)"
  cat > "$RUNTIME_PROBE_PY_HELPER" <<'PYEOF'
import json, os, sys
raw = os.environ.get("RUNTIME_PROBE_EVENT_JSON", "")
try:
    e = json.loads(raw)
except Exception:
    sys.exit(0)
event_type = e.get("eventType", "?")
popup = "true" if event_type in ("approval_required", "capability_required") else "false"
title = e.get("title", "")
summary = (e.get("summary") or "")[:160]
seq = e.get("sequence", "?")
created = e.get("createdAt", "")
print("[" + str(created) + "] seq=" + str(seq) + " type=" + str(event_type) + " POPUP=" + popup + " :: " + str(title))
if summary:
    print("    " + summary)
PYEOF
  trap 'rm -f "$RUNTIME_PROBE_PY_HELPER"' EXIT
}

cmd_watch() {
  local session; session="$(_mint_session)"
  _write_event_formatter
  echo "=== streaming /v1/hq/events/stream as ${EMAIL} — Ctrl-C to stop ===" >&2
  echo "POPUP=true means this event is one the Runtime terminal surfaces as a decision (approval_required / capability_required)." >&2
  echo "--------------------------------------------------------------------" >&2
  curl -sS -N "${BASE}/v1/hq/events/stream" -H "Authorization: Bearer ${session}" 2>&1 \
    | while IFS= read -r line; do
        case "$line" in
          data:*)
            payload="${line#data: }"
            if command -v python3 >/dev/null 2>&1; then
              RUNTIME_PROBE_EVENT_JSON="$payload" python3 "$RUNTIME_PROBE_PY_HELPER"
            fi
            ;;
        esac
      done
}

cmd_e2e() {
  local minutes="${1:-20}"
  local session; session="$(_mint_session)"
  local script_dir; script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "=== e2e run as ${EMAIL} — auto-approving every approvable popup, max ${minutes}m ($(_utc_now) UTC) ===" >&2
  # Capture the cursor BEFORE starting — otherwise the wake/resume's own
  # first events (activation_received, wake_received, ...) would already be
  # past the cursor python captures on its own first read and get silently
  # skipped.
  local start_seq; start_seq="$(_curl GET /v1/hq/runtime | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("runtime") or {}).get("eventSequence","0"))' 2>/dev/null || echo "0")"
  # Ensure the runtime is actually running — an e2e pass against a PAUSED
  # runtime would just idle out immediately with nothing to observe.
  cmd_start >&2
  RUNTIME_PROBE_BASE="$BASE" RUNTIME_PROBE_SESSION="$session" RUNTIME_PROBE_E2E_MINUTES="$minutes" \
    RUNTIME_PROBE_E2E_START_SEQ="$start_seq" \
    python3 "${script_dir}/runtime-probe-e2e.py"
}

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  case "${1:-}" in
    --start) shift; cmd_start "$@" ;;
    --stop) shift; cmd_stop "$@" ;;
    --refresh) shift; cmd_refresh "$@" ;;
    --restart) shift; cmd_restart "$@" ;;
    --status) shift; cmd_status "$@" ;;
    --watch) shift; cmd_watch "$@" ;;
    --e2e) shift; cmd_e2e "${1:-}" ;;
    --instruct) shift; cmd_instruct "${1:-}" ;;
    --session) shift; cmd_session "$@" ;;
    -h|--help|"") usage ;;
    *) echo "Unknown command: $1" >&2; usage; exit 2 ;;
  esac
}

main "$@"
