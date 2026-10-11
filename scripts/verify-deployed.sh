#!/usr/bin/env bash
# Verify that named running services contain the exact canonical source release.
set -euo pipefail

SHA=""; SERVICES=""; SOURCE_ROOT=""; OPEN_DOT_IMAGE=""; OPEN_DOT_SOURCE_SHA=""; OPEN_DOT_DEPLOY_IMAGE=""; OPEN_DOT_IMAGE_EXPECTED_ID=""
while [ "$#" -gt 0 ]; do case "$1" in
  --sha) SHA="$2"; shift 2 ;;
  --services) SERVICES="$2"; shift 2 ;;
  --source-root) SOURCE_ROOT="$2"; shift 2 ;;
  --open-dot-image) OPEN_DOT_IMAGE="$2"; shift 2 ;;
  --open-dot-source-sha) OPEN_DOT_SOURCE_SHA="$2"; shift 2 ;;
  --open-dot-deploy-image) OPEN_DOT_DEPLOY_IMAGE="$2"; shift 2 ;;
  --open-dot-image-expected-id) OPEN_DOT_IMAGE_EXPECTED_ID="$2"; shift 2 ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac; done
[ -n "$SHA" ] && [ -n "$SERVICES" ] && [ -d "$SOURCE_ROOT" ] \
  || { echo "usage: $0 --sha FULL_SHA --services core,control-plane,employees --source-root PATH" >&2; exit 2; }

declare -A CONTAINER=( [core]=hm-core [control-plane]=hm-control [employees]=hm-employees [byod-broker]=hm-byod-broker [playwright]=hm-playwright [tara-grok]=tara-grok [tara-deepgram]=tara-deepgram [hm-extract]=hm-extract [open-dot]=hm-open-dot )
declare -A LOCAL_FILE=(
  [core]="core/src/runtime-playbooks/stage-executor.js"
  [control-plane]="core/src/runtime-playbooks/stage-executor.js"
  [employees]="employees-service/src/hivemind_employees/api_hyper_rooms.py"
  [byod-broker]="byod/broker/server.mjs"
  [playwright]="services/hm-playwright/server.mjs"
  [tara-grok]="services/tara-grok/tara_grok/app.py"
  [tara-deepgram]="services/tara-deepgram/tara_deepgram/app.py"
  [hm-extract]="hm-extract/src/server.js"
)
declare -A IMAGE_FILE=(
  [core]="/app/src/runtime-playbooks/stage-executor.js"
  [control-plane]="/app/src/runtime-playbooks/stage-executor.js"
  [employees]="/app/src/hivemind_employees/api_hyper_rooms.py"
  [byod-broker]="/app/server.mjs"
  [playwright]="/app/server.mjs"
  [tara-grok]="/app/tara_grok/app.py"
  [tara-deepgram]="/app/tara_deepgram/app.py"
  [hm-extract]="/app/src/server.js"
)

hash_stream() { sha256sum | awk '{print $1}'; }
# LC_ALL=C pins byte-order sort collation. Without it, `sort -z` orders
# filenames by the shell's locale, which differs between this host and the
# container's shell — same 40 files, same content, different aggregate list
# order, different final hash. Hit exactly this on 2026-08-16 (see
# ENGINEERING_JOURNAL.md) and again on 2026-08-19 during the hm-extract
# deploy: verified live both times that every individual file hash matched
# byte-for-byte, only the list order (thus the final combined hash)
# differed. Documented as a known bug both times but never actually fixed —
# fixing it here so it stops producing a FATAL false-positive on every
# deploy going forward.
fixture_hash_local() {
  (
    cd "$SOURCE_ROOT/core/src/runtime-playbooks/fixtures"
    find . -maxdepth 1 -type f -name '*.json' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
  ) | hash_stream
}
fixture_hash_container() {
  docker exec "$1" sh -lc \
    "cd /app/src/runtime-playbooks/fixtures && find . -maxdepth 1 -type f -name '*.json' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum" \
    | hash_stream
}

IFS=',' read -ra requested <<< "$SERVICES"
for service in "${requested[@]}"; do
  if [ "$service" = open-dot ]; then
    [[ "$OPEN_DOT_IMAGE" =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] \
      || { echo "FATAL: Open Dot verification requires an immutable image digest" >&2; exit 2; }
    [[ "$OPEN_DOT_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] \
      || { echo "FATAL: Open Dot verification requires its 40-character source revision" >&2; exit 2; }
    OPEN_DOT_DEPLOY_IMAGE="${OPEN_DOT_DEPLOY_IMAGE:-$OPEN_DOT_IMAGE}"
    if [ -n "$OPEN_DOT_IMAGE_EXPECTED_ID" ]; then
      [[ "$OPEN_DOT_IMAGE_EXPECTED_ID" =~ ^sha256:[0-9a-f]{64}$ ]] \
        || { echo "FATAL: invalid preloaded Open Dot image ID" >&2; exit 2; }
    fi
  fi
  container="${CONTAINER[$service]:-}"
  [ -n "$container" ] || { echo "FATAL: unsupported verification service $service" >&2; exit 2; }
  state=$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo missing)
  { [ "$state" = healthy ] || [ "$state" = running ]; } || { echo "FATAL: $service state=$state" >&2; exit 1; }
  revision=$(docker inspect "$container" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true)
  [ "$revision" = "$SHA" ] || { echo "FATAL: $service revision=${revision:-missing}, expected=$SHA" >&2; exit 1; }

  if [ "$service" = open-dot ]; then
    live_image=$(docker inspect "$container" --format '{{.Config.Image}}' 2>/dev/null || true)
    [ "$live_image" = "$OPEN_DOT_DEPLOY_IMAGE" ] || { echo "FATAL: Open Dot image=${live_image:-missing}, expected deployment image" >&2; exit 1; }
    image_source_sha=$(docker image inspect "$live_image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true)
    [ "$image_source_sha" = "$OPEN_DOT_SOURCE_SHA" ] || { echo "FATAL: Open Dot image source revision=${image_source_sha:-missing}, expected=$OPEN_DOT_SOURCE_SHA" >&2; exit 1; }
    if [ -n "$OPEN_DOT_IMAGE_EXPECTED_ID" ]; then
      container_image_id=$(docker inspect "$container" --format '{{.Image}}' 2>/dev/null || true)
      [ "$container_image_id" = "$OPEN_DOT_IMAGE_EXPECTED_ID" ] \
        || { echo "FATAL: Open Dot container image ID=${container_image_id:-missing}, expected preloaded receipt ID" >&2; exit 1; }
    fi
    parent_label=$(docker inspect "$container" --format '{{ index .Config.Labels "com.singulance.open-dot.source-revision" }}' 2>/dev/null || true)
    [ "$parent_label" = "$OPEN_DOT_SOURCE_SHA" ] || { echo "FATAL: Open Dot container source revision=${parent_label:-missing}, expected=$OPEN_DOT_SOURCE_SHA" >&2; exit 1; }
    digest_label=$(docker inspect "$container" --format '{{ index .Config.Labels "com.singulance.open-dot.image-digest" }}' 2>/dev/null || true)
    [ "$digest_label" = "${OPEN_DOT_IMAGE##*@}" ] || { echo "FATAL: Open Dot container image digest label differs from requested immutable image" >&2; exit 1; }
    echo "[deployed] open-dot state=$state hivemind=${SHA:0:12} open-dot=${OPEN_DOT_SOURCE_SHA:0:12} image=${OPEN_DOT_IMAGE##*@}"
    continue
  fi

  if [ -n "${LOCAL_FILE[$service]:-}" ]; then
    local_hash=$(sha256sum "$SOURCE_ROOT/${LOCAL_FILE[$service]}" | awk '{print $1}')
    image_hash=$(docker exec "$container" sh -lc "cat '${IMAGE_FILE[$service]}'" | hash_stream)
    [ "$local_hash" = "$image_hash" ] || { echo "FATAL: $service runtime source hash mismatch" >&2; exit 1; }
  fi
  if [ "$service" = core ] || [ "$service" = control-plane ]; then
    local_fixture_hash=$(fixture_hash_local)
    image_fixture_hash=$(fixture_hash_container "$container")
    [ "$local_fixture_hash" = "$image_fixture_hash" ] || { echo "FATAL: $service playbook fixture catalog mismatch" >&2; exit 1; }
  fi
  echo "[deployed] $service state=$state revision=${SHA:0:12} source=verified"
done
