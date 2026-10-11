#!/usr/bin/env bash
# Compatibility entry point for the one canonical production release path.
set -euo pipefail

if [ "${1:-}" = "--rollback" ]; then
  echo "FATAL: mutable quick rollback is retired; release an exact recorded canonical SHA"
  exit 2
fi

BRANCH="${1:-singulance-main}"
[ $# -gt 0 ] && shift || true
CANON_REMOTE="${SINGULANCE_CANON_REMOTE:-https://github.com/amar3012005/HIVEMIND.git}"
SHA=$(git ls-remote "$CANON_REMOTE" "refs/heads/$BRANCH" | awk '{print $1}')
[ -n "$SHA" ] || { echo "FATAL: $BRANCH does not exist on $CANON_REMOTE"; exit 1; }
if [ -n "${SINGULANCE_EXPECTED_SHA:-}" ]; then
  [[ "$SINGULANCE_EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] \
    || { echo "FATAL: SINGULANCE_EXPECTED_SHA must be a full 40-character commit SHA" >&2; exit 2; }
  [ "$SHA" = "$SINGULANCE_EXPECTED_SHA" ] \
    || { echo "FATAL: canonical branch moved from expected $SINGULANCE_EXPECTED_SHA to $SHA" >&2; exit 1; }
fi

git -C /root/hivemind-main \
  -c submodule.recurse=false \
  -c fetch.recurseSubmodules=false \
  fetch "$CANON_REMOTE" "$BRANCH" --quiet
git -C /root/hivemind-main cat-file -e "$SHA^{commit}" 2>/dev/null \
  || { echo "FATAL: fetched canonical commit $SHA is unavailable"; exit 1; }

# Runtime contracts span this complete group. An omitted explicit member is
# accepted only when release-canonical proves it already runs the target SHA.
if [ $# -eq 0 ]; then
  SERVICES="core,control-plane,employees"
  RELEASE_SCOPE_ARGS=()
else
  # Supplying services is an explicit operator request for a scoped release.
  # The canonical runner still validates, builds, deploys and verifies those
  # services; omitted services are neither rebuilt nor recreated.
  RELEASE_SCOPE_ARGS=(--service-scoped)
  normalized=()
  for service in "$@"; do
    case "$service" in
      fe|frontend)
        echo "FATAL: frontend is hosted on Cloudflare; deploy it from the Da-vinci repository with Wrangler"
        exit 2
        ;;
    esac
    [ "$service" = control ] && service=control-plane
    normalized+=("$service")
  done
  SERVICES=$(IFS=,; echo "${normalized[*]}")
fi

# Execute the release implementation from the exact commit being promoted,
# never from a mutable shared checkout that may be on another session's branch.
RUNNER=$(mktemp /tmp/release-canonical.XXXXXX.sh)
trap 'rm -f "$RUNNER"' EXIT
git -C /root/hivemind-main show "$SHA:scripts/release-canonical.sh" > "$RUNNER"
chmod 700 "$RUNNER"
echo "== canonical release $BRANCH @ $SHA services=$SERVICES"
OPEN_DOT_ARGS=()
if [ -n "${OPEN_DOT_IMAGE:-}" ] || [ -n "${OPEN_DOT_SOURCE_SHA:-}" ]; then
  OPEN_DOT_ARGS=(--open-dot-image "${OPEN_DOT_IMAGE:-}" --open-dot-source-sha "${OPEN_DOT_SOURCE_SHA:-}")
fi
if [ -n "${OPEN_DOT_MODE:-}" ]; then
  OPEN_DOT_ARGS+=(--open-dot-mode "$OPEN_DOT_MODE")
fi
"$RUNNER" --sha "$SHA" --services "$SERVICES" "${RELEASE_SCOPE_ARGS[@]}" "${OPEN_DOT_ARGS[@]}"
