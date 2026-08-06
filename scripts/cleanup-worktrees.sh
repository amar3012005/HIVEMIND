#!/usr/bin/env bash
# cleanup-worktrees.sh
#
# Remove stale detached/temporary worktrees created by CI/release helpers and
# development sessions.
#
# Safety:
# - keeps active paths
# - skips dirty worktrees
# - supports dry-run
# - prunes git worktree metadata after removals
#
# Env vars:
#   WORKTREE_CLEANUP_AGE_HOURS (default: 12)
#   WORKTREE_CLEANUP_DRY_RUN (default: 0)
#   WORKTREE_CLEANUP_INCLUDE_TMP (default: 0)  # include /tmp/opencode/*

set -euo pipefail

PARENT_ROOTS=(/root/hivemind-main /root/hivemind /root/hivemind-next)
AGE_HOURS="${WORKTREE_CLEANUP_AGE_HOURS:-12}"
DRY_RUN="${WORKTREE_CLEANUP_DRY_RUN:-0}"
INCLUDE_TMP="${WORKTREE_CLEANUP_INCLUDE_TMP:-0}"
NOW="$(date +%s)"
AGE_SECONDS=$((AGE_HOURS*3600))

CANDIDATE_PREFIXES=(
  /root/builds/prod-
  /root/releases/
  /root/hivemind-build-
  /root/hivemind-release-
  /root/hivemind-recall-
  /root/hivemind-frozen
)
if [ "$INCLUDE_TMP" = "1" ]; then
  CANDIDATE_PREFIXES+=(/tmp/opencode/)
fi

# Active mount check (containers and live shell references)
ACTIVE_MOUNTS=$(docker ps -q | xargs -r docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null | tr ' ' '\n' | sort -u)

is_active() {
  local path="$1"
  if echo "$ACTIVE_MOUNTS" | grep -Fqx "$path"; then
    return 0
  fi
  if ps -eo args | grep -Fq "$path" | grep -Ev 'rg|bash|grep' >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

list_candidates() {
  local candidates=()
  local p
  for pref in "${CANDIDATE_PREFIXES[@]}"; do
    if [ -d "$pref" ] && [[ "$pref" == */ ]]; then
      shopt -s nullglob
      for d in ${pref}*; do
        [ -d "$d" ] || continue
        candidates+=("$d")
      done
      shopt -u nullglob
    elif [ -d "$pref" ]; then
      candidates+=("$pref")
    fi
  done

  for p in "${candidates[@]}"; do
    echo "$p"
  done
}

is_worktree_dirty() {
  local path="$1"
  if git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ -n "$(git -C "$path" status --short)" ]; then
      return 0
    fi
  fi
  return 1
}

path_is_registered() {
  local path="$1"
  local parent
  local wt
  for parent in "${PARENT_ROOTS[@]}"; do
    [ -d "$parent/.git" ] || continue
    while read -r wt; do
      if [ "$wt" = "worktree $path" ]; then
        return 0
      fi
    done < <(git -C "$parent" worktree list --porcelain | awk '/^worktree/{print $2}')
  done
  return 1
}

remove_path() {
  local path="$1"
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY-RUN remove: $path"
    return
  fi

  if path_is_registered "$path"; then
    for parent in "${PARENT_ROOTS[@]}"; do
      if git -C "$parent" worktree list --porcelain | grep -q "^worktree $path$"; then
        git -C "$parent" worktree remove --force "$path" >/dev/null 2>&1 || true
        return
      fi
    done
  fi

  python3 - "$path" <<'PY'
import shutil, sys
shutil.rmtree(sys.argv[1])
PY
}

removed=0
kept=0

echo "=== cleanup-worktrees ==="
echo "threshold=${AGE_HOURS}h dry-run=${DRY_RUN} include_tmp=${INCLUDE_TMP}"

while read -r d; do
  [ -z "$d" ] && continue

  if [ ! -d "$d" ]; then
    continue
  fi

  if is_active "$d"; then
    echo "keep (active): $d"
    kept=$((kept+1))
    continue
  fi

  age=$((NOW - $(stat -c %Y "$d")))
  if [ "$age" -lt "$AGE_SECONDS" ]; then
    echo "keep (too new): $d"
    kept=$((kept+1))
    continue
  fi

  if is_worktree_dirty "$d"; then
    echo "keep (dirty): $d"
    kept=$((kept+1))
    continue
  fi

  remove_path "$d"
  removed=$((removed+1))
  echo "remove: $d"

done < <(list_candidates | sort -u)

for parent in "${PARENT_ROOTS[@]}"; do
  [ -d "$parent/.git" ] && git -C "$parent" worktree prune >/dev/null 2>&1 || true
done

echo "kept=$kept"
echo "removed=$removed"
echo "=== done ==="
