#!/usr/bin/env bash
# Minimal bootstrap only. The downloaded supervisor verifies every signed release
# artifact and owns upgrade/rollback; this script never clones source code.
set -euo pipefail

readonly INSTALL_ROOT="${ENGINE_BOX_ROOT:-/opt/hivemind-engine-box}"
readonly RELEASE_BASE="${ENGINE_BOX_RELEASE_BASE:-https://get.singulancelabs.com/engine-box}"
readonly MIN_DISK_GB="${ENGINE_BOX_MIN_DISK_GB:-80}"
readonly MIN_MEMORY_MB="${ENGINE_BOX_MIN_MEMORY_MB:-16384}"
ENROLL_CODE=""
REPAIR=false

log(){ printf '[engine-box] %s\n' "$*"; }
die(){ printf '[engine-box] error: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --enroll) ENROLL_CODE="${2:-}"; shift 2 ;;
    --repair) REPAIR=true; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(uname -s)" = Linux ] || die 'Engine Box supports Linux only'
case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) die "unsupported architecture: $(uname -m)" ;; esac
command -v docker >/dev/null 2>&1 || die 'Docker Engine is required'
docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required'
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
  "$RELEASE_BASE/bootstrap" -o "$tmp_dir/bootstrap.json"

json_field(){ python3 - "$1" "$2" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding='utf-8'))
for part in sys.argv[2].split('.'):
    value = value[part]
print(value)
PY
}

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
if [ ! -f "$INSTALL_ROOT/secrets/postgres_password" ]; then openssl rand -base64 36 > "$INSTALL_ROOT/secrets/postgres_password"; fi
if [ ! -f "$INSTALL_ROOT/secrets/oidc_cookie_secret" ]; then openssl rand -base64 32 > "$INSTALL_ROOT/secrets/oidc_cookie_secret"; fi
if [ ! -f "$INSTALL_ROOT/secrets/cloudflare_tunnel_token" ]; then : > "$INSTALL_ROOT/secrets/cloudflare_tunnel_token"; fi
if [ ! -f "$INSTALL_ROOT/secrets/oidc_client_secret" ]; then : > "$INSTALL_ROOT/secrets/oidc_client_secret"; fi
chmod 0600 "$INSTALL_ROOT/secrets/postgres_password" "$INSTALL_ROOT/secrets/oidc_cookie_secret" "$INSTALL_ROOT/secrets/cloudflare_tunnel_token" "$INSTALL_ROOT/secrets/oidc_client_secret"
log 'verified bootstrap installed; supervisor now owns configuration, image pulls, health checks and rollback'
exec "$INSTALL_ROOT/hm-supervisor" install --root "$INSTALL_ROOT"
