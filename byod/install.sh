#!/usr/bin/env bash
# HIVEMIND BYOD — one-command installer. Detects OS/arch, installs Docker if needed, fetches the data
# bundle, and runs setup (prompts for your API key, brings up Postgres+Qdrant+tunnel, connects to
# HIVEMIND). Your memory data lives on THIS box.
#
#   curl -fsSL https://get.hivemind.<domain>/install | bash
#   (or)  bash <(curl -fsSL https://get.hivemind.<domain>/install)
set -euo pipefail
REPO="${HIVEMIND_REPO:-https://github.com/your-org/hivemind.git}"   # TODO: set to your public repo
DIR="${HIVEMIND_DIR:-hivemind-byod}"
log(){ printf '\033[1;36m[hivemind]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[hivemind] %s\033[0m\n' "$*" >&2; exit 1; }

# ── detect machine ──
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$ARCH" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported arch: $ARCH" ;; esac
log "detected: $OS/$ARCH"
[ "$OS" = "Linux" ] || die "the data bundle runs on a Linux server (found $OS)."

# ── install prerequisites ──
need(){ command -v "$1" >/dev/null 2>&1; }
if ! need docker; then
  log "installing Docker…"; curl -fsSL https://get.docker.com | sh; systemctl enable --now docker 2>/dev/null || true
fi
docker compose version >/dev/null 2>&1 || die "install the docker compose v2 plugin first"
need git || { command -v apt-get >/dev/null && apt-get install -y -qq git || die "install git"; }

# ── fetch the bundle (only the byod branch — your engine source is never downloaded) ──
if [ ! -d "$DIR/.git" ]; then
  log "fetching the data bundle…"
  git clone --branch byod --single-branch --depth 1 "$REPO" "$DIR"
else
  log "bundle exists — updating…"; git -C "$DIR" pull --ff-only || true
fi

# ── run setup (prompts for API key → enroll → up → register) ──
log "starting setup…"
cd "$DIR"
exec ./setup.sh
