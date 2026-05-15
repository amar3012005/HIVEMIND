#!/usr/bin/env bash
set -euo pipefail

HIVEMIND_ENDPOINT="__DIRECT_MCP_ENDPOINT__"
HIVEMIND_API_KEY="${HIVEMIND_API_KEY:-__API_KEY__}"
HIVEMIND_PLATFORM="__PLATFORM__"

if [[ "__HAS_API_KEY__" != "1" ]]; then
  HIVEMIND_API_KEY=""
fi

cyan='\033[36m'
blue='\033[34m'
green='\033[32m'
yellow='\033[33m'
red='\033[31m'
bold='\033[1m'
reset='\033[0m'

print_banner() {
  clear 2>/dev/null || true
  printf "%b\n" "${blue}${bold}"
  printf "  _   _ _____ _____ ______ __  __ ___ _   _ ____  \n"
  printf " | | | |_   _|_   _|  ____|  \/  |_ _| \ | |  _ \\ \n"
  printf " | |_| | | |   | | | |__  | |\/| || ||  \| | | | |\n"
  printf " |  _  | | |   | | |  __| | |  | || || |\\  | |_| |\n"
  printf " |_| |_| |_|   |_| |_|    |_|  |_|___|_| \_|____/ \n"
  printf "%b\n" "${reset}"
  printf "%b\n" "${cyan}${bold}HIVEMIND Claude MCP Installer${reset}"
  printf "%b\n\n" "${cyan}This script installs Claude if needed, configures the HIVEMIND MCP server, and helps you restart Claude cleanly.${reset}"
}

note() { printf "%b\n" "${cyan}• $*${reset}"; }
success() { printf "%b\n" "${green}• $*${reset}"; }
warn() { printf "%b\n" "${yellow}• $*${reset}"; }
fail() { printf "%b\n" "${red}• $*${reset}"; exit 1; }

prompt_yes_no() {
  local prompt="$1"
  local answer
  while true; do
    printf "%b" "${bold}${prompt} [y/n]: ${reset}"
    read -r answer || true
    case "${answer,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) warn "Please enter y or n." ;;
    esac
  done
}

ensure_api_key() {
  if [[ -n "$HIVEMIND_API_KEY" ]]; then
    return
  fi

  printf "%b" "${bold}Paste your HIVEMIND API key: ${reset}"
  read -r HIVEMIND_API_KEY
  [[ -n "$HIVEMIND_API_KEY" ]] || fail "API key is required."
}

shell_rc_file() {
  if [[ -n "${ZDOTDIR:-}" && -f "$ZDOTDIR/.zshrc" ]]; then
    printf "%s" "$ZDOTDIR/.zshrc"
    return
  fi
  if [[ -f "$HOME/.zshrc" ]]; then
    printf "%s" "$HOME/.zshrc"
    return
  fi
  if [[ -f "$HOME/.bashrc" ]]; then
    printf "%s" "$HOME/.bashrc"
    return
  fi
  printf "%s" "$HOME/.profile"
}

ensure_local_bin_path() {
  export PATH="$HOME/.local/bin:$PATH"
  local rc_file
  rc_file="$(shell_rc_file)"
  mkdir -p "$HOME/.local/bin"
  touch "$rc_file"
  if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$rc_file"; then
    printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc_file"
    success "Added ~/.local/bin to PATH in $rc_file"
  fi
}

resolve_claude_bin() {
  if command -v claude >/dev/null 2>&1; then
    command -v claude
    return 0
  fi
  if [[ -x "$HOME/.local/bin/claude" ]]; then
    printf "%s" "$HOME/.local/bin/claude"
    return 0
  fi
  return 1
}

install_claude() {
  local claude_bin
  if claude_bin="$(resolve_claude_bin)"; then
    success "Claude already installed at $claude_bin"
    "$claude_bin" --version || true
    return
  fi

  note "Installing Claude..."
  curl -fsSL https://claude.ai/install.sh | bash
  ensure_local_bin_path

  if ! claude_bin="$(resolve_claude_bin)"; then
    fail "Claude installed, but the binary is still not on PATH. Open a new terminal and run this installer again."
  fi

  success "Claude installed at $claude_bin"
  "$claude_bin" --version || true
}

configure_mcp() {
  local claude_bin
  claude_bin="$(resolve_claude_bin)"
  note "Configuring HIVEMIND MCP server..."
  # Claude CLI stores MCP entries per-scope. A bare `mcp remove` errors out
  # when an entry exists in multiple scopes — and the next `mcp add` then
  # fails as "already exists". Remove from user + local + project explicitly
  # so the reinstall is always clean across all scopes.
  "$claude_bin" mcp remove hivemind -s user    >/dev/null 2>&1 || true
  "$claude_bin" mcp remove hivemind -s local   >/dev/null 2>&1 || true
  "$claude_bin" mcp remove hivemind -s project >/dev/null 2>&1 || true
  "$claude_bin" mcp add --scope user --transport http hivemind "$HIVEMIND_ENDPOINT" --header "Authorization: Bearer $HIVEMIND_API_KEY"
  success "HIVEMIND MCP server configured."

  if "$claude_bin" mcp list 2>/dev/null | grep -qi 'hivemind'; then
    success "Confirmed hivemind exists in your Claude MCP list."
  else
    warn "Claude did not print the MCP list as expected. You can still continue and verify in HIVEMIND."
  fi
}

restart_claude_prompt() {
  if ! prompt_yes_no "Do you want me to help restart Claude now?"; then
    warn "Before Step 2, fully quit Claude and open it again."
    return
  fi

  case "$HIVEMIND_PLATFORM" in
    macos)
      osascript -e 'tell application "Claude" to quit' >/dev/null 2>&1 || true
      osascript -e 'tell application "Claude Desktop" to quit' >/dev/null 2>&1 || true
      sleep 1
      open -a Claude >/dev/null 2>&1 || open -a "Claude Desktop" >/dev/null 2>&1 || warn "Could not auto-open Claude. Please reopen it manually."
      success "Restart attempt finished. If Claude is not visible, open it manually now."
      ;;
    linux)
      warn "Automatic Claude restart is not reliable on Linux. Please fully quit Claude, then open it again now."
      ;;
    *)
      warn "Automatic restart is not configured for this platform. Please reopen Claude manually."
      ;;
  esac
}

print_next_steps() {
  printf "\n%b\n" "${green}${bold}Setup complete.${reset}"
  printf "%b\n" "${cyan}Next:${reset}"
  printf "%b\n" "${cyan}1. Return to the HIVEMIND Connectors popup.${reset}"
  printf "%b\n" "${cyan}2. Click Verify Connection.${reset}"
  printf "%b\n" "${cyan}3. If Verify fails, fully reopen Claude once more and retry before Step 2.${reset}"
  printf "%b\n" "${cyan}4. Continue to the MCP Server prompt page.${reset}"
}

main() {
  print_banner
  ensure_api_key
  ensure_local_bin_path
  install_claude
  configure_mcp
  restart_claude_prompt
  print_next_steps
}

main "$@"
