#!/usr/bin/env bash
# record-deployment.sh — append one line to the deployments log after a deploy.
#
# This is the entire "release graph" this repo needs right now: not a scanner, not
# nodes/edges, not a coordinator service — one append-only file that answers the two
# questions that actually mattered every time this session went looking for them:
# "what is live?" and "what do I roll back to?" Those were answered today by grep-ing
# scattered .last-*-rollback files and re-deriving state by hand from `docker inspect`.
# This makes that answer a single `tail` instead of an investigation.
#
# Usage (call right after the health check that follows a deploy, success or failure):
#   scripts/record-deployment.sh \
#     --service core \
#     --sha 086a4927 \
#     --image hivemind/core-api:sha-086a4927 \
#     --rollback hivemind/core-api:prod-20260806-6a619764ef08 \
#     --health true
#
# Writes ONE line of tab-separated fields to LOG_FILE (append-only, never rewritten —
# the log is the audit trail; do not "clean it up" by editing past lines). Also updates
# .last-<service>-rollback for scripts that already read that convention, so nothing
# depends on migrating away from it.
set -euo pipefail

LOG_FILE="${DEPLOY_LOG_FILE:-/root/hivemind/logs/deployments.log}"
# Overridable for the SAME reason LOG_FILE is: a test run against DEPLOY_LOG_FILE=/tmp/x
# must not also write the real pointer file. This was hardcoded on first write and a
# functional test of this exact script clobbered the live .last-core-rollback with a
# fake test value — caught and fixed before the script was ever committed, but the class
# of mistake (a "test" run mutating real state because one path wasn't parameterized
# while a sibling path was) is exactly what this log is meant to make rarer, not add.
ROLLBACK_DIR="${DEPLOY_ROLLBACK_DIR:-/root/hivemind}"
SERVICE="" SHA="" IMAGE="" ROLLBACK="" HEALTH=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --service)  SERVICE="$2"; shift 2 ;;
    --sha)      SHA="$2"; shift 2 ;;
    --image)    IMAGE="$2"; shift 2 ;;
    --rollback) ROLLBACK="$2"; shift 2 ;;
    --health)   HEALTH="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

for req in SERVICE IMAGE; do
  if [ -z "${!req}" ]; then
    echo "record-deployment.sh: --service and --image are required (got service='$SERVICE' image='$IMAGE')" >&2
    exit 2
  fi
done

mkdir -p "$(dirname "$LOG_FILE")"

DEPLOYER="${SUDO_USER:-${USER:-unknown}}@$(hostname -s 2>/dev/null || echo unknown)"
TS="$(date -u +%FT%TZ)"

# Tab-separated, not JSON: `tail -f` and `column -t` read it without a parser, and a
# missing field is visually obvious (an empty column) rather than a JSON syntax error
# that breaks every line parsed after it. Fields, in order:
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$TS" "$SERVICE" "${SHA:--}" "$IMAGE" "${ROLLBACK:--}" "${HEALTH:-unknown}" "$DEPLOYER" \
  >> "$LOG_FILE"

# Backward-compatible pointer file, unchanged shape — do not deprecate, several
# deploy steps already read .last-<service>-rollback directly.
if [ -n "$ROLLBACK" ] && [ "$ROLLBACK" != "-" ]; then
  echo "$ROLLBACK" > "${ROLLBACK_DIR}/.last-${SERVICE}-rollback"
fi

echo "[record-deployment] logged: service=$SERVICE image=$IMAGE health=${HEALTH:-unknown}" >&2
