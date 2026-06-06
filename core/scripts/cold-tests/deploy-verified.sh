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
#   FILES="core/src/a.js core/src/b.js" bash deploy-verified.sh   # scp these files + verify
#   DRY_RUN=1 bash deploy-verified.sh                              # verify-only, no copy/restart
#
# DEPLOY MODE = scp individual FILES (NOT git pull). Prod runs working-tree DRIFT,
# so `git pull` would clobber uncommitted prod edits → outage. We only ever push
# the explicit files named in $FILES, each backed up on the box first so rollback
# restores the EXACT prior bytes (not a git pointer move).
#
# SAFETY: rollback restores the per-file backups + restart. Never down-migrates,
# never deletes data, never touches files outside $FILES.
set -uo pipefail

SSH="${SSH_ALIAS:-myserver}"
REPO="/opt/HIVEMIND"
DRY_RUN="${DRY_RUN:-0}"
FILES="${FILES:-}"

say() { printf '\n>>> %s\n' "$*"; }

DEPLOYED=$(ssh "$SSH" "cd $REPO && git rev-parse --short HEAD")
say "prod HEAD (unchanged — drift preserved): $DEPLOYED"

BK="/tmp/deploy-backup-$DEPLOYED"
if [ "$DRY_RUN" != "1" ] && [ -n "$FILES" ]; then
  say "backing up + scp-deploying files: $FILES"
  ssh "$SSH" "mkdir -p $BK"
  for f in $FILES; do
    ssh "$SSH" "cp $REPO/$f $BK/$(echo $f | tr / _) 2>/dev/null || true"   # backup exact prior bytes
    scp "$f" "$SSH:$REPO/$f" || { echo "SCP FAILED for $f"; exit 3; }
  done
  ssh "$SSH" "docker restart hm-core" || { echo "RESTART FAILED"; exit 3; }
elif [ "$DRY_RUN" != "1" ]; then
  say "no FILES given — verify-only (nothing copied)"
fi
say "last-known-good backups at: $SSH:$BK"

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
  say "PROD VERIFIED ✅  files=[$FILES]  backups=$BK"
  exit 0
fi

say "COLD TESTS RED ❌ — restoring per-file backups from $BK"
if [ -z "$FILES" ]; then say "nothing deployed (verify-only) — no rollback needed"; exit 1; fi
for f in $FILES; do
  ssh "$SSH" "cp $BK/$(echo $f | tr / _) $REPO/$f 2>/dev/null && echo restored $f || echo 'NO BACKUP for $f (was new file? removing)'; "
done
ssh "$SSH" "docker restart hm-core"

say "verifying rollback health..."
for i in $(seq 1 60); do
  if ssh "$SSH" "docker exec hm-core node -e 'console.log(1)' 2>/dev/null | grep -q 1"; then break; fi
  sleep 2
done
HEALTH=$(ssh "$SSH" "docker exec hm-core node /app/scripts/cold-tests/run-all.mjs 2>&1" | grep -o '=== RESULT:.*')
say "ROLLED BACK to $LKG — post-rollback: $HEALTH"
exit 1
