#!/usr/bin/env bash
# Bootstrap served at https://get.singulancelabs.com/memory-box.
set -euo pipefail
[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }
BASE="${HIVEMIND_MEMORY_BOX_CHANNEL_BASE:-https://get.singulancelabs.com/memory-box}"
CHANNEL="${HIVEMIND_MEMORY_BOX_CHANNEL:-stable}"; [[ "$CHANNEL" == stable || "$CHANNEL" == canary ]] || { echo 'invalid channel' >&2; exit 1; }
INSTALL_DIR="${HIVEMIND_MEMORY_BOX_INSTALL_DIR:-/opt/hivemind-memory-box}"
CONFIG_DIR="${HIVEMIND_MEMORY_BOX_CONFIG_DIR:-/etc/hivemind-memory-box}"
STATE_DIR="${HIVEMIND_MEMORY_BOX_STATE_DIR:-/var/lib/hivemind-memory-box}"
WORK="$(mktemp -d /tmp/hivemind-memory-box.XXXXXX)"; trap 'rm -rf -- "$WORK"' EXIT
log(){ printf 'hivemind-memory-box: %s\n' "$*"; }; die(){ log "$*" >&2; exit 1; }
case "$BASE" in https://*) ;; *) die 'release channel must use HTTPS' ;; esac

command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl ca-certificates; }
command -v docker >/dev/null || { log 'installing Docker'; curl -fsSL --proto '=https' https://get.docker.com | sh; }
docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required'
command -v node >/dev/null || { apt-get update -qq && apt-get install -y -qq nodejs; }
command -v flock >/dev/null || { apt-get update -qq && apt-get install -y -qq util-linux; }

fetch(){ curl -fsSLo "$2" --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 300 "$1"; }
fetch "$BASE/releases/$CHANNEL/release.json" "$WORK/release.json"
fetch "$BASE/releases/$CHANNEL/release.sig" "$WORK/release.sig"
if [[ -n "${HIVEMIND_RELEASE_PUBLIC_KEY_PATH:-}" ]]; then cp "${HIVEMIND_RELEASE_PUBLIC_KEY_PATH}" "$WORK/release.pub"; else fetch "$BASE/release.pub" "$WORK/release.pub"; fi
if [[ -n "${HIVEMIND_RELEASE_PUBLIC_KEY_SHA256:-}" ]]; then
  printf '%s  %s\n' "$HIVEMIND_RELEASE_PUBLIC_KEY_SHA256" "$WORK/release.pub" | sha256sum --check --status || die 'release public key pin mismatch'
fi
node -e 'const c=require("node:crypto"),f=require("node:fs"),m=f.readFileSync(process.argv[1]),k=f.readFileSync(process.argv[3]);
const j=JSON.parse(m),pub=c.createPublicKey(k),fingerprint=c.createHash("sha256").update(pub.export({type:"spki",format:"der"})).digest("hex");
if(pub.asymmetricKeyType!=="ed25519"||j.public_key_sha256!==fingerprint||!c.verify(null,m,k,f.readFileSync(process.argv[2])))process.exit(1)' "$WORK/release.json" "$WORK/release.sig" "$WORK/release.pub" || die 'release signature or public-key fingerprint verification failed'
readarray -t RELEASE_DATA < <(node -e '
const m=require(process.argv[1]); const u=m.bundle_url||m.bundle?.url,s=m.bundle_sha256||m.bundle?.sha256;
if(m.version!==2||m.channel!==process.argv[2]||!u?.startsWith("https://")||!/^[a-f0-9]{64}$/.test(s||""))process.exit(1);
console.log(u);console.log(s);' "$WORK/release.json" "$CHANNEL") || die 'invalid governed release manifest'
fetch "${RELEASE_DATA[0]}" "$WORK/bundle.tar.gz"
printf '%s  %s\n' "${RELEASE_DATA[1]}" "$WORK/bundle.tar.gz" | sha256sum --check --status || die 'release bundle digest mismatch'
if tar -tzf "$WORK/bundle.tar.gz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then die 'release bundle contains an unsafe path'; fi
mkdir "$WORK/unpacked"; tar -xzf "$WORK/bundle.tar.gz" -C "$WORK/unpacked"
SOURCE="$WORK/unpacked"; [[ -f "$SOURCE/setup.sh" ]] || SOURCE="$WORK/unpacked/byod"
[[ -f "$SOURCE/setup.sh" && -f "$SOURCE/hivemind-memory-box" ]] || die 'release bundle is missing Memory Box host tools'

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$STATE_DIR"; chmod 755 "$INSTALL_DIR" "$CONFIG_DIR"; chmod 700 "$STATE_DIR"
LEGACY="${HIVEMIND_MEMORY_BOX_LEGACY_DIR:-}"
if [[ -z "$LEGACY" ]]; then
  for candidate in /opt/hivemind-byod /root/hivemind-byod "$PWD/hivemind-byod"; do [[ -f "$candidate/.env" ]] && { LEGACY="$candidate"; break; }; done
fi
if [[ -n "$LEGACY" && -f "$LEGACY/.env" && ! -f "$CONFIG_DIR/memory-box.env" ]]; then cp -p "$LEGACY/.env" "$CONFIG_DIR/memory-box.env"; chmod 600 "$CONFIG_DIR/memory-box.env"; fi
if [[ -n "$LEGACY" && -d "$LEGACY/data" && ! -e "$INSTALL_DIR/data" ]]; then ln -s "$LEGACY/data" "$INSTALL_DIR/data"; fi
if [[ -n "$LEGACY" && -d "$LEGACY/backups" && ! -e "$INSTALL_DIR/backups" ]]; then ln -s "$LEGACY/backups" "$INSTALL_DIR/backups"; fi
cp -a "$SOURCE/." "$INSTALL_DIR/"
install -m 0755 "$INSTALL_DIR/hivemind-memory-box" /usr/local/sbin/hivemind-memory-box
install -m 0644 "$WORK/release.pub" "$CONFIG_DIR/release.pub"
printf '%s\n' "$CHANNEL" > "$CONFIG_DIR/channel"; chmod 644 "$CONFIG_DIR/channel"
install -m 0644 "$INSTALL_DIR/systemd/hivemind-memory-box-update.service" /etc/systemd/system/hivemind-memory-box-update.service
install -m 0644 "$INSTALL_DIR/systemd/hivemind-memory-box-update.timer" /etc/systemd/system/hivemind-memory-box-update.timer
systemctl daemon-reload; systemctl enable --now hivemind-memory-box-update.timer
log "installed governed host tools in $INSTALL_DIR"
HIVEMIND_MEMORY_BOX_LOCK_HELD=false /usr/local/sbin/hivemind-memory-box install
/usr/local/sbin/hivemind-memory-box update
