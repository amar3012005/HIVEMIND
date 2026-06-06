#!/usr/bin/env bash
# Rollback-safe production deploy for HIVEMIND.
#
# Captures the current (last-known-good) SHA BEFORE deploying, pulls + restarts,
# waits for ready, runs the cold-test orchestrator inside the container, and
# AUTO-ROLLS-BACK to the last-known-good SHA if cold tests go RED.
#
# This is the "rewind" guarantee: a bad autopilot deploy can never leave prod
# broken overnight — it self-reverts to the last green code pointer.
#
# Usage (run from a machine with SSH alias `myserver`):
#   bash deploy-verified.sh                 # deploy current origin/main + verify
#   DRY_RUN=1 bash deploy-verified.sh        # verify-only, no pull/restart
#
# SAFETY: rollback moves the CODE pointer only (git reset --hard + restart).
# It never down-migrates the DB or deletes data. If a migration shipped with the
# bad deploy, this script FLAGS it and refuses silent schema rollback.
set -uo pipefail

SSH="${SSH_ALIAS:-myserver}"
REPO="/opt/HIVEMIND"
DRY_RUN="${DRY_RUN:-0}"

say() { printf '\n>>> %s\n' "$*"; }

LKG=$(ssh "$SSH" "cd $REPO && git rev-parse HEAD")
say "last-known-good SHA: $LKG"

if [ "$DRY_RUN" != "1" ]; then
  say "deploying: git pull + docker restart hm-core"
  ssh "$SSH" "cd $REPO && git pull origin main && docker restart hm-core" || { echo "DEPLOY STEP FAILED"; exit 3; }
fi

DEPLOYED=$(ssh "$SSH" "cd $REPO && git rev-parse HEAD")
say "deployed SHA: $DEPLOYED"

say "waiting for hm-core ready..."
for i in $(seq 1 60); do
  if ssh "$SSH" "docker exec hm-core node -e 'console.log(1)' 2>/dev/null | grep -q 1"; then break; fi
  sleep 2
done

say "running cold-test orchestrator (G0..G6)..."
OUT=$(ssh "$SSH" "docker exec hm-core node /app/scripts/cold-tests/run-all.mjs 2>&1")
echo "$OUT" | tail -50
VERDICT=$(echo "$OUT" | grep -o 'COLD_TEST_REPORT_JSON .*' | sed 's/COLD_TEST_REPORT_JSON //')

if echo "$VERDICT" | grep -q '"green":true'; then
  say "PROD VERIFIED ✅  deployed=$DEPLOYED  lkg=$LKG"
  exit 0
fi

say "COLD TESTS RED ❌ — rolling back to last-known-good $LKG"
# Refuse silent schema rollback if a migration shipped in this range.
MIGR=$(ssh "$SSH" "cd $REPO && git diff --name-only $LKG..$DEPLOYED -- 'core/prisma/migrations' '**/migrations' 2>/dev/null")
if [ -n "$MIGR" ]; then
  say "⚠️  MIGRATION shipped in bad deploy — NOT auto-down-migrating (human decision):"
  echo "$MIGR"
  say "rolling back CODE only; DB schema left as-is. FLAG for review."
fi
ssh "$SSH" "cd $REPO && git reset --hard $LKG && docker restart hm-core"

say "verifying rollback health..."
for i in $(seq 1 60); do
  if ssh "$SSH" "docker exec hm-core node -e 'console.log(1)' 2>/dev/null | grep -q 1"; then break; fi
  sleep 2
done
HEALTH=$(ssh "$SSH" "docker exec hm-core node /app/scripts/cold-tests/run-all.mjs 2>&1" | grep -o '=== RESULT:.*')
say "ROLLED BACK to $LKG — post-rollback: $HEALTH"
exit 1
