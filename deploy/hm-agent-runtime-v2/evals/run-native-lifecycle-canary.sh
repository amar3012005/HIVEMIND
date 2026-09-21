#!/usr/bin/env sh
# Run against a locally built immutable runtime image.  The temporary Redis,
# network, sessions, inboxes, and wakeups are removed on exit.
set -eu

image="${HM_RUNTIME_IMAGE:-hm-agent-runtime-v2:agentscope-workspace-docker-driver}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
suffix="$$"
network="hm-lifecycle-canary-net-${suffix}"
redis="hm-lifecycle-canary-redis-${suffix}"

cleanup() {
  docker rm -f "$redis" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker network create "$network" >/dev/null
docker run -d --rm --network "$network" --name "$redis" redis:7-alpine >/dev/null
until docker exec "$redis" redis-cli ping | grep -q PONG; do sleep 1; done

docker run --rm \
  --network "$network" \
  -e CANARY_REDIS_HOST="$redis" \
  -v "$script_dir/native_lifecycle_canary.py:/app/evals/native_lifecycle_canary.py:ro" \
  --entrypoint python \
  "$image" /app/evals/native_lifecycle_canary.py
