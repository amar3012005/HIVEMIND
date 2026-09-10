#!/usr/bin/env bash
# Start the local preview stack with Cloudflare Email Sending credentials fetched
# at runtime from the approved HIVE control-plane host.  Credentials are never
# written to this checkout, an image layer, or a Compose file.
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_host="${HIVEMIND_EMAIL_SOURCE_HOST:-singulance}"
local_control="${HIVEMIND_LOCAL_CONTROL_CONTAINER:-hivemind-control-plane-local}"

remote_env() {
  local name="$1"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$source_host" \
    "docker inspect hm-control --format '{{range .Config.Env}}{{println .}}{{end}}' | awk -v wanted='$name' 'index(\$0, wanted \"=\") == 1 {sub(\"^[^=]*=\", \"\"); print; exit}'"
}

existing_local_env() {
  local name="$1"
  docker inspect "$local_control" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | awk -v wanted="$name" 'index($0, wanted "=") == 1 {sub("^[^=]*=", ""); print; exit}'
}

# Email sending always uses the same Cloudflare account and verified sender as
# the approved control plane.  Fetch only missing values so an explicitly
# supplied development credential remains possible.
for name in CLOUDFLARE_EMAIL_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_EMAIL_FROM; do
  if [[ -z "${!name:-}" ]]; then
    export "$name=$(remote_env "$name")"
  fi
  [[ -n "${!name}" ]] || { echo "Missing $name from $source_host" >&2; exit 1; }
done

# A local control-plane recreation must not invalidate an already-running
# local Harness runner.  Carry its local-only bridge secrets forward when the
# caller did not provide them explicitly.
for name in HIVE_HARNESS_TICKET_SECRET HIVE_HARNESS_RUNNER_SERVICE_SECRET HIVEMIND_ADMIN_SECRET; do
  if [[ -z "${!name:-}" ]]; then
    export "$name=$(existing_local_env "$name")"
  fi
  [[ -n "${!name}" ]] || { echo "Missing local runtime value: $name" >&2; exit 1; }
done

cd "$root_dir"
exec docker compose -p hm-hyper-contract \
  -f docker-compose.local-stack.yml \
  -f docker-compose.local-services.yml \
  up -d --build "$@"
