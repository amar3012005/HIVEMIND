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
git -C /root/hivemind-main fetch origin "$BRANCH" --quiet
SHA=$(git -C /root/hivemind-main rev-parse FETCH_HEAD)
exec /root/hivemind-main/scripts/release-singulance.sh "$SHA" "$@"
