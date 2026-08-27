#!/usr/bin/env bash
# Bootstrap served at https://get.singulancelabs.com/memory-box.
set -euo pipefail
[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }
BASE="${HIVEMIND_MEMORY_BOX_CHANNEL_BASE:-https://get.singulancelabs.com/memory-box}"
CHANNEL="${HIVEMIND_MEMORY_BOX_CHANNEL:-stable}"; [[ "$CHANNEL" == stable || "$CHANNEL" == canary ]] || { echo 'invalid channel' >&2; exit 1; }
PINNED_PUBLIC_KEY_SHA256="${HIVEMIND_RELEASE_PUBLIC_KEY_SHA256:-__HIVEMIND_RELEASE_PUBLIC_KEY_SHA256__}"
INSTALL_DIR="${HIVEMIND_MEMORY_BOX_INSTALL_DIR:-/opt/hivemind-memory-box}"
CONFIG_DIR="${HIVEMIND_MEMORY_BOX_CONFIG_DIR:-/etc/hivemind-memory-box}"
STATE_DIR="${HIVEMIND_MEMORY_BOX_STATE_DIR:-/var/lib/hivemind-memory-box}"
WORK="$(mktemp -d /tmp/hivemind-memory-box.XXXXXX)"; trap 'rm -rf -- "$WORK"' EXIT
log(){ printf 'hivemind-memory-box: %s\n' "$*"; }; die(){ log "$*" >&2; exit 1; }
case "$BASE" in https://*) ;; *) die 'release channel must use HTTPS' ;; esac

[[ "$(uname -s)" == Linux ]] || die 'Memory Box requires Linux'
case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) die "unsupported architecture: $(uname -m)" ;; esac
command -v systemctl >/dev/null 2>&1 || die 'systemd is required for governed updates and backups'
[[ -d /run/systemd/system ]] || die 'systemd is not running'

command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl ca-certificates; }
fetch(){ curl -fsSLo "$2" --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 300 "$1"; }
if ! command -v docker >/dev/null; then
  log 'installing Docker'
  DOCKER_INSTALLER="$WORK/get-docker.sh"
  fetch 'https://get.docker.com' "$DOCKER_INSTALLER"
  sh "$DOCKER_INSTALLER" || die 'Docker installation failed'
fi
docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required'
command -v node >/dev/null || { apt-get update -qq && apt-get install -y -qq nodejs; }
node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)' || die 'Node.js 18 or newer is required'
command -v flock >/dev/null || { apt-get update -qq && apt-get install -y -qq util-linux; }
docker info >/dev/null 2>&1 || die 'Docker daemon is not reachable'

fetch "$BASE/releases/$CHANNEL/release.json" "$WORK/release.json"
fetch "$BASE/releases/$CHANNEL/release.sig" "$WORK/release.sig"
if [[ -n "${HIVEMIND_RELEASE_PUBLIC_KEY_PATH:-}" ]]; then cp "${HIVEMIND_RELEASE_PUBLIC_KEY_PATH}" "$WORK/release.pub"; else fetch "$BASE/release.pub" "$WORK/release.pub"; fi
node -e 'const c=require("node:crypto"),f=require("node:fs"),m=f.readFileSync(process.argv[1]),k=f.readFileSync(process.argv[3]);
const j=JSON.parse(m),pub=c.createPublicKey(k),fingerprint=c.createHash("sha256").update(pub.export({type:"spki",format:"der"})).digest("hex");
if(!/^[a-f0-9]{64}$/.test(process.argv[4])||pub.asymmetricKeyType!=="ed25519"||fingerprint!==process.argv[4]||j.public_key_sha256!==fingerprint||!c.verify(null,m,k,f.readFileSync(process.argv[2])))process.exit(1)' "$WORK/release.json" "$WORK/release.sig" "$WORK/release.pub" "$PINNED_PUBLIC_KEY_SHA256" || die 'release signature or pinned public-key verification failed'
readarray -t RELEASE_DATA < <(node -e '
const m=require(process.argv[1]); const u=m.bundle_url||m.bundle?.url,s=m.bundle_sha256||m.bundle?.sha256;
if(m.version!==2||m.channel!==process.argv[2]||!u?.startsWith("https://")||!/^[a-f0-9]{64}$/.test(s||""))process.exit(1);
console.log(u);console.log(s);' "$WORK/release.json" "$CHANNEL") || die 'invalid governed release manifest'
fetch "${RELEASE_DATA[0]}" "$WORK/bundle.tar.gz"
printf '%s  %s\n' "${RELEASE_DATA[1]}" "$WORK/bundle.tar.gz" | sha256sum --check --status || die 'release bundle digest mismatch'
if tar -tzf "$WORK/bundle.tar.gz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then die 'release bundle contains an unsafe path'; fi
if tar -tvzf "$WORK/bundle.tar.gz" | awk 'substr($1,1,1)=="l" || substr($1,1,1)=="h" {found=1} END{exit found?0:1}'; then die 'release bundle must not contain symbolic or hard links'; fi
mkdir "$WORK/unpacked"; tar -xzf "$WORK/bundle.tar.gz" -C "$WORK/unpacked"
SOURCE="$WORK/unpacked"; [[ -f "$SOURCE/setup.sh" ]] || SOURCE="$WORK/unpacked/byod"
[[ -f "$SOURCE/setup.sh" && -f "$SOURCE/hivemind-memory-box" && -f "$SOURCE/memory-box-common.sh" ]] || die 'release bundle is missing Memory Box host tools'
VERIFIED_RELEASE="$(BYOD_ALLOW_LEGACY_RELEASE_V1=false BYOD_RELEASE_CHANNEL="$CHANNEL" node "$SOURCE/verify-release.mjs" "$WORK/release.json" "$WORK/release.sig" "$WORK/release.pub")" \
  || die 'governed release manifest verification failed'
INITIAL_IMAGE="$(VERIFIED_RELEASE="$VERIFIED_RELEASE" node -e 'const x=JSON.parse(process.env.VERIFIED_RELEASE);process.stdout.write(x.image)')"
INITIAL_RELEASE="$(VERIFIED_RELEASE="$VERIFIED_RELEASE" node -e 'const x=JSON.parse(process.env.VERIFIED_RELEASE);process.stdout.write(x.release)')"

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$STATE_DIR"; chmod 755 "$INSTALL_DIR"; chmod 700 "$CONFIG_DIR" "$STATE_DIR"
LEGACY="${HIVEMIND_MEMORY_BOX_LEGACY_DIR:-}"
if [[ -z "$LEGACY" ]]; then
  for candidate in /opt/hivemind-byod /root/hivemind-byod "$PWD/hivemind-byod"; do [[ -f "$candidate/.env" ]] && { LEGACY="$candidate"; break; }; done
fi
if [[ -n "$LEGACY" && -f "$LEGACY/.env" && ! -f "$CONFIG_DIR/memory-box.env" ]]; then cp -p "$LEGACY/.env" "$CONFIG_DIR/memory-box.env"; chmod 600 "$CONFIG_DIR/memory-box.env"; fi
if [[ -n "$LEGACY" && -d "$LEGACY/data" && ! -e "$INSTALL_DIR/data" ]]; then ln -s "$LEGACY/data" "$INSTALL_DIR/data"; fi
if [[ -n "$LEGACY" && -d "$LEGACY/backups" && ! -e "$INSTALL_DIR/backups" ]]; then ln -s "$LEGACY/backups" "$INSTALL_DIR/backups"; fi
for host_script in "$SOURCE"/*.sh "$SOURCE"/hivemind-memory-box; do
  [[ ! -f "$host_script" ]] || bash -n "$host_script" || die "release bundle contains an invalid host tool: $(basename "$host_script")"
done
. "$SOURCE/memory-box-common.sh"
hm_promote_host_tree "$SOURCE" "$INSTALL_DIR"
install -m 0755 "$INSTALL_DIR/hivemind-memory-box" /usr/local/sbin/hivemind-memory-box
install -m 0644 "$WORK/release.pub" "$CONFIG_DIR/release.pub"
printf '%s\n' "$CHANNEL" > "$CONFIG_DIR/channel"; chmod 644 "$CONFIG_DIR/channel"
install -m 0644 "$INSTALL_DIR/systemd/hivemind-memory-box-update.service" /etc/systemd/system/hivemind-memory-box-update.service
install -m 0644 "$INSTALL_DIR/systemd/hivemind-memory-box-update.timer" /etc/systemd/system/hivemind-memory-box-update.timer
install -m 0644 "$INSTALL_DIR/systemd/hivemind-memory-box-backup.service" /etc/systemd/system/hivemind-memory-box-backup.service
install -m 0644 "$INSTALL_DIR/systemd/hivemind-memory-box-backup.timer" /etc/systemd/system/hivemind-memory-box-backup.timer
install -m 0644 "$INSTALL_DIR/systemd/hivemind-memory-box-reconcile.service" /etc/systemd/system/hivemind-memory-box-reconcile.service
install -m 0644 "$INSTALL_DIR/systemd/hivemind-memory-box-reconcile.timer" /etc/systemd/system/hivemind-memory-box-reconcile.timer
systemctl daemon-reload
log "installed governed host tools in $INSTALL_DIR"
if [[ -f "$CONFIG_DIR/memory-box.env" ]]; then
  ACTIVE_IMAGE="$INITIAL_IMAGE"; ACTIVE_RELEASE="$INITIAL_RELEASE"
  if [[ -f "$STATE_DIR/CURRENT_RELEASE.json" ]]; then
    RECEIPT_IMAGE="$(node -e 'const x=require(process.argv[1]);if(typeof x.image!=="string"||!x.image.includes("@sha256:"))process.exit(1);process.stdout.write(x.image)' "$STATE_DIR/CURRENT_RELEASE.json" 2>/dev/null || true)"
    RECEIPT_RELEASE="$(node -e 'const x=require(process.argv[1]);if(typeof x.release!=="string")process.exit(1);process.stdout.write(x.release)' "$STATE_DIR/CURRENT_RELEASE.json" 2>/dev/null || true)"
    if [[ -n "$RECEIPT_IMAGE" && -n "$RECEIPT_RELEASE" ]]; then ACTIVE_IMAGE="$RECEIPT_IMAGE"; ACTIVE_RELEASE="$RECEIPT_RELEASE"; fi
  fi
  HIVEMIND_MEMORY_BOX_INSTALL_DIR="$INSTALL_DIR" HIVEMIND_MEMORY_BOX_CONFIG_DIR="$CONFIG_DIR" \
    ACTIVE_IMAGE="$ACTIVE_IMAGE" ACTIVE_RELEASE="$ACTIVE_RELEASE" bash -c \
    '. "$HIVEMIND_MEMORY_BOX_INSTALL_DIR/memory-box-common.sh"; hm_set_env_value "$HIVEMIND_MEMORY_BOX_CONFIG_DIR/memory-box.env" HIVEMIND_AGENT_IMAGE "$ACTIVE_IMAGE"; hm_set_env_value "$HIVEMIND_MEMORY_BOX_CONFIG_DIR/memory-box.env" VERSION "$ACTIVE_RELEASE"'
fi
BYOD_INITIAL_AGENT_IMAGE="$INITIAL_IMAGE" BYOD_INITIAL_AGENT_RELEASE="$INITIAL_RELEASE" \
  HIVEMIND_MEMORY_BOX_LOCK_HELD=false /usr/local/sbin/hivemind-memory-box install
/usr/local/sbin/hivemind-memory-box update
systemctl enable --now hivemind-memory-box-update.timer hivemind-memory-box-backup.timer hivemind-memory-box-reconcile.timer
