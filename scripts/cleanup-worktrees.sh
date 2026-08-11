#!/usr/bin/env bash
# cleanup-worktrees.sh — remove stale detached worktrees used by build/release/experiment sessions.
#
# Safe by default:
# - only checks candidate paths
# - skips active mounts/process references
# - skips dirty git trees
# - logs every skip with reason
# - prunes git worktree metadata from canonical parents

set -euo pipefail

ROOT_DIR="/root"
AGE_HOURS="${WORKTREE_CLEANUP_AGE_HOURS:-168}"   # 7 days
INCLUDE_FROZEN="${WORKTREE_CLEANUP_INCLUDE_FROZEN:-0}"
CANDIDATE_PREFIXES=(
  "${ROOT_DIR}/hivemind-build-"
  "${ROOT_DIR}/hivemind-release-"
  "${ROOT_DIR}/hivemind-recall-"
  "${ROOT_DIR}/hivemind-security-build"
  "${ROOT_DIR}/hivemind-fe-reconcile"
  "${ROOT_DIR}/builds/prod-"
  "${ROOT_DIR}/builds/core-"
  "${ROOT_DIR}/builds/ingest-"
  "${ROOT_DIR}/builds/test-"
  "${ROOT_DIR}/builds/hyper-deploy-"
  "${ROOT_DIR}/hivemind-recall-candidate"
  "${ROOT_DIR}/releases/"
)

if [ "$INCLUDE_FROZEN" = "1" ]; then
  CANDIDATE_PREFIXES+=("${ROOT_DIR}/hivemind-frozen")
fi

echo "=== cleanup-worktrees $(date -u +%FT%TZ) ==="

targets=()
for pref in "${CANDIDATE_PREFIXES[@]}"; do
  if [[ "$pref" == */ ]]; then
    shopt -s nullglob
    for d in ${pref}*; do
      [ -d "$d" ] && targets+=("$d")
    done
    shopt -u nullglob
  else
    [ -d "$pref" ] && targets+=("$pref")
  fi
done

# Active mounted paths from running containers
ACTIVE_MOUNTS="$(docker ps -q | xargs -r docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null | tr ' ' '\n' | sort -u)"

is_active() {
  local path="$1"
  if echo "$ACTIVE_MOUNTS" | grep -Fxq "$path"; then
    return 0
  fi
  if ps -eo args | grep -F "$path" | grep -Ev 'rg|bash|grep' >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

removed=0
kept=0

for d in "${targets[@]}"; do
  # Keep only directories older than threshold
  if ! [[ $(stat -c %Y "$d") -lt $(( $(date +%s) - (AGE_HOURS*3600) )) ]]; then
    echo "keep (too recent): $d"
    kept=$((kept+1))
    continue
  fi

  if is_active "$d"; then
    echo "keep (active ref): $d"
    kept=$((kept+1))
    continue
  fi

  if git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ -n "$(git -C "$d" status --short)" ]; then
      echo "keep (dirty): $d"
      kept=$((kept+1))
      continue
    fi
  fi

  echo "remove: $d"
  rm -rf "$d"
  removed=$((removed+1))
  
  # clean stale git worktree metadata from known parents
  if [ -d /root/hivemind-main/.git ]; then
    git -C /root/hivemind-main worktree prune >/dev/null 2>&1 || true
  fi
  if [ -d /root/hivemind-next/.git ]; then
    git -C /root/hivemind-next worktree prune >/dev/null 2>&1 || true
  fi
  if [ -d /root/hivemind/.git ]; then
    git -C /root/hivemind worktree prune >/dev/null 2>&1 || true
  fi
done

echo "kept=$kept removed=$removed"
echo "=== end $(date -u +%FT%TZ) ==="
