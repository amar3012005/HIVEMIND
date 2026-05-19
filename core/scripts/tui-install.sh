#!/usr/bin/env bash
# HIVEMIND MCP TUI installer shim — downloads correct binary for host OS,
# drops to ~/.local/bin, then execs it. Usage:
#   curl -fsSL https://<endpoint>/install/tui.sh | bash
set -euo pipefail

HIVEMIND_BASE="__HIVEMIND_BASE__"
HIVEMIND_API_KEY="${HIVEMIND_API_KEY:-__API_KEY__}"
HAS_API_KEY="__HAS_API_KEY__"

[[ "$HAS_API_KEY" == "1" ]] || HIVEMIND_API_KEY=""

cyan='\033[36m'; green='\033[32m'; yellow='\033[33m'; red='\033[31m'; reset='\033[0m'
note()    { printf "%b\n" "${cyan}• $*${reset}"; }
success() { printf "%b\n" "${green}• $*${reset}"; }
warn()    { printf "%b\n" "${yellow}• $*${reset}"; }
fail()    { printf "%b\n" "${red}• $*${reset}"; exit 1; }

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) fail "unsupported arch: $arch" ;;
esac

case "$os" in
  darwin) asset="hivemind-mcp-darwin-${arch}" ;;
  linux)  asset="hivemind-mcp-linux-${arch}"  ;;
  *) fail "unsupported OS: $os (use the PowerShell installer on Windows)" ;;
esac

dest="$HOME/.local/bin/hivemind-mcp"
mkdir -p "$HOME/.local/bin"
note "Downloading $asset…"
curl -fsSL "${HIVEMIND_BASE}/install/tui/${asset}" -o "$dest"
chmod +x "$dest"
success "Installed to $dest"

# Ensure ~/.local/bin on PATH for current shell
export PATH="$HOME/.local/bin:$PATH"

if [[ -n "$HIVEMIND_API_KEY" ]]; then
  export HIVEMIND_API_KEY
fi

note "Launching HIVEMIND MCP installer…"
exec "$dest"
