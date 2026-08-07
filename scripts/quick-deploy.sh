#!/usr/bin/env bash
# Compatibility entry point. Production has one release implementation so a
# second session cannot bypass clean-SHA, shared-lock, and health gates.
set -euo pipefail

if [ "${1:-}" = "--rollback" ]; then
  echo "FATAL: mutable quick rollback is retired; deploy the recorded stable SHA through release-singulance.sh"
  exit 2
fi

BRANCH="${1:-singulance-main}"
shift || true

# Resolve the branch from GITHUB, not from `origin`. On the box, /root/hivemind-main's
# origin is the local clone /root/hivemind, whose LOCAL branch lags GitHub — so
# `fetch origin` happily resolved a stale commit and the release built old code while
# printing a confident green RID. Observed 2026-08-07: canon was 31fa6b73, this line
# resolved d14822b3, and control-plane shipped without the fix it was deploying.
# Nothing downstream can catch it: a stale commit is still a valid ancestor of canon,
# so every gate in release-singulance.sh passes.
CANON_REMOTE="${SINGULANCE_CANON_REMOTE:-https://github.com/amar3012005/HIVEMIND.git}"
SHA=$(git ls-remote "$CANON_REMOTE" "refs/heads/$BRANCH" | awk '{print $1}')
[ -n "$SHA" ] || { echo "FATAL: $BRANCH does not exist on $CANON_REMOTE"; exit 1; }

# Fetch that exact object so the build worktree can be created from it.
git -C /root/hivemind-main fetch "$CANON_REMOTE" "$BRANCH" --quiet
git -C /root/hivemind-main cat-file -e "$SHA^{commit}" 2>/dev/null \
  || { echo "FATAL: $SHA fetched from $CANON_REMOTE but is not present locally"; exit 1; }

echo "== deploying $BRANCH @ $SHA (resolved from $CANON_REMOTE)"
exec /root/hivemind-main/scripts/release-singulance.sh "$SHA" "$@"
