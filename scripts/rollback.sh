#!/usr/bin/env bash
# Instant rollback: redeploy the PREVIOUS image tag recorded by deploy-image.sh.
# Because every deploy is an immutable tag, rollback is deterministic — no git
# bisect, no "what was running before". Run ON the prod host.
#
# Usage:   ./scripts/rollback.sh            # roll back to the previous tag
#          ./scripts/rollback.sh <git-sha>  # roll back to a specific tag
set -euo pipefail

STATE_DIR="${STATE_DIR:-/opt/HIVEMIND/.deploy}"
TARGET="${1:-$(cat "$STATE_DIR/previous-tag" 2>/dev/null || echo '')}"

if [ -z "$TARGET" ]; then
  echo "[rollback] no previous tag recorded and none given. Usage: ./scripts/rollback.sh <git-sha>" >&2
  echo "[rollback] available local image tags:" >&2
  docker images "${IMAGE:-ghcr.io/amar3012005/hivemind-core}" --format '  {{.Tag}}' | head -20 >&2
  exit 1
fi

echo "[rollback] redeploying previous tag: $TARGET"
IMAGE_TAG="$TARGET" exec "$(dirname "$0")/deploy-image.sh"
