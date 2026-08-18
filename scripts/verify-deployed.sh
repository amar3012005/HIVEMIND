#!/usr/bin/env bash
# Verify that named running services contain the exact canonical source release.
set -euo pipefail

SHA=""; SERVICES=""; SOURCE_ROOT=""
while [ "$#" -gt 0 ]; do case "$1" in
  --sha) SHA="$2"; shift 2 ;;
  --services) SERVICES="$2"; shift 2 ;;
  --source-root) SOURCE_ROOT="$2"; shift 2 ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac; done
[ -n "$SHA" ] && [ -n "$SERVICES" ] && [ -d "$SOURCE_ROOT" ] \
  || { echo "usage: $0 --sha FULL_SHA --services core,control-plane,employees,frontend --source-root PATH" >&2; exit 2; }

declare -A CONTAINER=( [core]=hm-core [control-plane]=hm-control [employees]=hm-employees [tara-grok]=tara-grok [tara-deepgram]=tara-deepgram [frontend]=hivemind-next-frontend-1 [hm-extract]=hm-extract )
declare -A LOCAL_FILE=(
  [core]="core/src/runtime-playbooks/stage-executor.js"
  [control-plane]="core/src/runtime-playbooks/stage-executor.js"
  [employees]="employees-service/src/hivemind_employees/api_hyper_rooms.py"
  [tara-grok]="services/tara-grok/tara_grok/app.py"
  [tara-deepgram]="services/tara-deepgram/tara_deepgram/app.py"
  [hm-extract]="hm-extract/src/server.js"
)
declare -A IMAGE_FILE=(
  [core]="/app/src/runtime-playbooks/stage-executor.js"
  [control-plane]="/app/src/runtime-playbooks/stage-executor.js"
  [employees]="/app/src/hivemind_employees/api_hyper_rooms.py"
  [tara-grok]="/app/tara_grok/app.py"
  [tara-deepgram]="/app/tara_deepgram/app.py"
  [hm-extract]="/app/src/server.js"
)

hash_stream() { sha256sum | awk '{print $1}'; }
fixture_hash_local() {
  (
    cd "$SOURCE_ROOT/core/src/runtime-playbooks/fixtures"
    find . -maxdepth 1 -type f -name '*.json' -print0 | sort -z | xargs -0 sha256sum
  ) | hash_stream
}
fixture_hash_container() {
  docker exec "$1" sh -lc \
    "cd /app/src/runtime-playbooks/fixtures && find . -maxdepth 1 -type f -name '*.json' -print0 | sort -z | xargs -0 sha256sum" \
    | hash_stream
}

IFS=',' read -ra requested <<< "$SERVICES"
for service in "${requested[@]}"; do
  container="${CONTAINER[$service]:-}"
  [ -n "$container" ] || { echo "FATAL: unsupported verification service $service" >&2; exit 2; }
  state=$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo missing)
  { [ "$state" = healthy ] || [ "$state" = running ]; } || { echo "FATAL: $service state=$state" >&2; exit 1; }
  revision=$(docker inspect "$container" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true)
  [ "$revision" = "$SHA" ] || { echo "FATAL: $service revision=${revision:-missing}, expected=$SHA" >&2; exit 1; }

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
