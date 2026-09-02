#!/usr/bin/env bash
# Minimal bootstrap only. The downloaded supervisor verifies every signed release
# artifact and owns upgrade/rollback; this script never clones source code.
set -euo pipefail

readonly INSTALL_ROOT="${ENGINE_BOX_ROOT:-/opt/hivemind-engine-box}"
# Artifact delivery and management are separate. The bootstrap script can be
# delivered from the public release host, but one-time enrolment is redeemed at
# the versioned Engine Box control-plane API.
readonly MANAGEMENT_BASE="${ENGINE_BOX_MANAGEMENT_BASE:-https://api.singulancelabs.com/v1/engine-box}"
readonly MIN_DISK_GB="${ENGINE_BOX_MIN_DISK_GB:-80}"
readonly MIN_MEMORY_MB="${ENGINE_BOX_MIN_MEMORY_MB:-16384}"
ENROLL_CODE=""
REPAIR=false

log(){ printf '[engine-box] %s\n' "$*"; }
die(){ printf '[engine-box] error: %s\n' "$*" >&2; exit 1; }

require_root(){ [ "${EUID:-$(id -u)}" -eq 0 ] || die 'run this command with sudo'; }

supported_host(){
  [ -r /etc/os-release ] || die 'cannot identify the Linux distribution'
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:22.04|ubuntu:24.04|debian:12) ;;
    *) die "unsupported host: ${PRETTY_NAME:-unknown}; supported: Ubuntu 22.04/24.04 and Debian 12" ;;
  esac
}

ensure_docker(){
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then return; fi
  command -v apt-get >/dev/null 2>&1 || die 'Docker is missing and this host has no supported apt package manager'
  : "${ENGINE_BOX_DOCKER_VERSION:?signed bootstrap must provide ENGINE_BOX_DOCKER_VERSION when Docker is missing}"
  log "installing pinned Docker Engine ${ENGINE_BOX_DOCKER_VERSION}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  if [ ! -s /etc/apt/keyrings/docker.gpg ]; then
    curl --fail --silent --show-error https://download.docker.com/linux/"$(. /etc/os-release; printf '%s' "$ID")"/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi
  . /etc/os-release
  printf '%s\n' "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    "docker-ce=${ENGINE_BOX_DOCKER_VERSION}" \
    "docker-ce-cli=${ENGINE_BOX_DOCKER_VERSION}" \
    containerd.io docker-buildx-plugin docker-compose-plugin
  docker compose version >/dev/null 2>&1 || die 'Docker Compose installation verification failed'
}

json_field(){ python3 - "$1" "$2" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding='utf-8'))
for part in sys.argv[2].split('.'):
    value = value[part]
print(value)
PY
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --enroll) ENROLL_CODE="${2:-}"; shift 2 ;;
    --repair) REPAIR=true; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_root
[ "$(uname -s)" = Linux ] || die 'Engine Box supports Linux only'
supported_host
case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) die "unsupported architecture: $(uname -m)" ;; esac
command -v openssl >/dev/null 2>&1 || die 'openssl is required to verify releases'
command -v curl >/dev/null 2>&1 || die 'curl is required'
command -v python3 >/dev/null 2>&1 || die 'python3 is required'

available_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
[ "$available_kb" -ge $((MIN_DISK_GB * 1024 * 1024)) ] || die "at least ${MIN_DISK_GB}GB free disk is required"
memory_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
[ "$memory_kb" -ge $((MIN_MEMORY_MB * 1024)) ] || die "at least ${MIN_MEMORY_MB}MB RAM is required"

if [ "$REPAIR" = true ]; then
  [ -x "$INSTALL_ROOT/hm-supervisor" ] || die 'no existing Engine Box supervisor exists to repair'
  [ -f "$INSTALL_ROOT/release.json" ] || die 'no verified local release exists to repair'
  [ -f "$INSTALL_ROOT/license.json" ] || die 'no signed local licence lease exists to repair'
  if [ -f "$INSTALL_ROOT/host-requirements.json" ]; then
    ENGINE_BOX_DOCKER_VERSION="$(json_field "$INSTALL_ROOT/host-requirements.json" docker_version)" || die 'local host requirements are invalid'
    export ENGINE_BOX_DOCKER_VERSION
  fi
  ensure_docker
  log 'repairing from the verified local release; customer volumes and credentials are preserved'
  exec "$INSTALL_ROOT/hm-supervisor" install --root "$INSTALL_ROOT"
fi

[ -n "$ENROLL_CODE" ] || die '--enroll requires an organization-bound, one-time code'

umask 077
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
log 'redeeming enrollment and downloading signed bootstrap manifest'
bootstrap_payload="$(python3 - "$ENROLL_CODE" <<'PY'
import json, sys
print(json.dumps({'enrollment_code': sys.argv[1]}))
PY
)"
curl --fail --silent --show-error --retry 2 \
  -H 'content-type: application/json' \
  --data "$bootstrap_payload" \
  "$MANAGEMENT_BASE/bootstrap" -o "$tmp_dir/bootstrap.json"

manifest_url="$(json_field "$tmp_dir/bootstrap.json" manifest_url)" || die 'bootstrap response is invalid'
signature_url="$(json_field "$tmp_dir/bootstrap.json" signature_url)" || die 'bootstrap response is invalid'
public_key_url="$(json_field "$tmp_dir/bootstrap.json" public_key_url)" || die 'bootstrap response is invalid'
license_url="$(json_field "$tmp_dir/bootstrap.json" license_url)" || die 'bootstrap response is invalid'
license_signature_url="$(json_field "$tmp_dir/bootstrap.json" license_signature_url)" || die 'bootstrap response is invalid'
curl --fail --silent --show-error "$manifest_url" -o "$tmp_dir/release.json"
curl --fail --silent --show-error "$signature_url" -o "$tmp_dir/release.sig"
curl --fail --silent --show-error "$public_key_url" -o "$tmp_dir/release.pub"
openssl pkeyutl -verify -pubin -inkey "$tmp_dir/release.pub" -rawin -in "$tmp_dir/release.json" -sigfile "$tmp_dir/release.sig" >/dev/null \
  || die 'release manifest signature verification failed'
docker_version="$(json_field "$tmp_dir/release.json" host_requirements.docker_version)" || die 'signed release manifest lacks pinned Docker version'
case "$docker_version" in *$'\n'*|*$'\r'*|'') die 'signed Docker version is invalid' ;; esac
export ENGINE_BOX_DOCKER_VERSION="$docker_version"
ensure_docker
curl --fail --silent --show-error "$license_url" -o "$tmp_dir/license.json"
curl --fail --silent --show-error "$license_signature_url" -o "$tmp_dir/license.sig"
openssl pkeyutl -verify -pubin -inkey "$tmp_dir/release.pub" -rawin -in "$tmp_dir/license.json" -sigfile "$tmp_dir/license.sig" >/dev/null \
  || die 'license signature verification failed'
license_installation_id="$(json_field "$tmp_dir/license.json" installation_id)" || die 'license is invalid'
bootstrap_installation_id="$(json_field "$tmp_dir/bootstrap.json" installation_id)" || die 'bootstrap response is invalid'
[ "$license_installation_id" = "$bootstrap_installation_id" ] || die 'license does not belong to this installation'

supervisor_url="$(json_field "$tmp_dir/release.json" supervisor.url)" || die 'release manifest lacks supervisor artifact'
supervisor_sha="$(json_field "$tmp_dir/release.json" supervisor.sha256)" || die 'release manifest lacks supervisor checksum'
curl --fail --silent --show-error "$supervisor_url" -o "$tmp_dir/hm-supervisor"
printf '%s  %s\n' "$supervisor_sha" "$tmp_dir/hm-supervisor" | sha256sum -c - >/dev/null || die 'supervisor checksum verification failed'

install -d -m 0700 "$INSTALL_ROOT/secrets" "$INSTALL_ROOT/releases"
install -m 0700 "$tmp_dir/hm-supervisor" "$INSTALL_ROOT/hm-supervisor"
install -m 0600 "$tmp_dir/release.json" "$INSTALL_ROOT/release.json"
install -m 0600 "$tmp_dir/release.sig" "$INSTALL_ROOT/release.sig"
install -m 0644 "$tmp_dir/release.pub" "$INSTALL_ROOT/release.pub"
install -m 0600 "$tmp_dir/license.json" "$INSTALL_ROOT/license.json"
install -m 0600 "$tmp_dir/license.sig" "$INSTALL_ROOT/license.sig"
python3 - "$INSTALL_ROOT/host-requirements.json" "$docker_version" <<'PY'
import json, os, sys, tempfile
target, version = sys.argv[1:]
fd, temporary = tempfile.mkstemp(dir=os.path.dirname(target), prefix='.host-requirements-', text=True)
with os.fdopen(fd, 'w', encoding='utf-8') as handle:
    json.dump({'docker_version': version}, handle, sort_keys=True)
    handle.write('\n')
os.chmod(temporary, 0o600)
os.replace(temporary, target)
PY
bundle_url="$(json_field "$tmp_dir/release.json" bundle.url)" || die 'release manifest lacks appliance bundle'
bundle_sha="$(json_field "$tmp_dir/release.json" bundle.sha256)" || die 'release manifest lacks appliance bundle checksum'
curl --fail --silent --show-error "$bundle_url" -o "$tmp_dir/engine-box.tar.gz"
printf '%s  %s\n' "$bundle_sha" "$tmp_dir/engine-box.tar.gz" | sha256sum -c - >/dev/null || die 'appliance bundle checksum verification failed'
mkdir -p "$tmp_dir/bundle"
tar -tzf "$tmp_dir/engine-box.tar.gz" | python3 - <<'PY'
import sys
for member in sys.stdin:
    member = member.strip()
    if not member or member.startswith('/') or '/../' in f'/{member}':
        raise SystemExit(f'unsafe bundle member: {member!r}')
PY
tar -xzf "$tmp_dir/engine-box.tar.gz" -C "$tmp_dir/bundle"
[ -f "$tmp_dir/bundle/compose.yaml" ] || die 'verified appliance bundle lacks compose.yaml'
cp "$tmp_dir/bundle/compose.yaml" "$INSTALL_ROOT/compose.yaml"
cp "$tmp_dir/bundle/model-catalog.json" "$INSTALL_ROOT/model-catalog.json"
cp "$tmp_dir/bundle/model-catalog.sig" "$INSTALL_ROOT/model-catalog.sig"
# Hex deliberately avoids newline and URL-encoding edge cases in postgres,
# while still providing 256 bits of entropy. Existing installations preserve
# their secret and are handled safely by hm-engine-entrypoint's URL encoding.
if [ ! -f "$INSTALL_ROOT/secrets/postgres_password" ]; then openssl rand -hex 32 > "$INSTALL_ROOT/secrets/postgres_password"; fi
if [ ! -f "$INSTALL_ROOT/secrets/oidc_cookie_secret" ]; then openssl rand -base64 32 > "$INSTALL_ROOT/secrets/oidc_cookie_secret"; fi
if [ ! -f "$INSTALL_ROOT/secrets/cloudflare_tunnel_token" ]; then : > "$INSTALL_ROOT/secrets/cloudflare_tunnel_token"; fi
if [ ! -f "$INSTALL_ROOT/secrets/oidc_client_secret" ]; then : > "$INSTALL_ROOT/secrets/oidc_client_secret"; fi
chmod 0600 "$INSTALL_ROOT/secrets/postgres_password" "$INSTALL_ROOT/secrets/oidc_cookie_secret" "$INSTALL_ROOT/secrets/cloudflare_tunnel_token" "$INSTALL_ROOT/secrets/oidc_client_secret"
log 'verified bootstrap installed; supervisor now owns image pulls and local service liveness'
"$INSTALL_ROOT/hm-supervisor" install --root "$INSTALL_ROOT"
setup_url="https://127.0.0.1:${ENGINE_BOX_CORE_PORT:-8787}/setup"
log "local services are running; finish secure configuration at ${setup_url}"
log 'Engine Box is not READY until the local setup wizard completes its authenticated canary'
