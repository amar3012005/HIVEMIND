#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
token_file=/etc/hivemind-playwright-mcp/tunnel.token
unit_source="$repo_root/infra/systemd/hivemind-playwright-mcp-tunnel.service"

if [[ ! -s "$token_file" ]]; then
  echo "Missing $token_file; provision the dedicated Cloudflare Tunnel first." >&2
  exit 1
fi

chmod 700 /etc/hivemind-playwright-mcp
# cloudflared runs as a non-root user inside its pinned container. The parent
# directory remains root-only, while the bind-mounted token itself must be
# readable by that isolated process.
chmod 644 "$token_file"
install -o root -g root -m 0644 "$unit_source" /etc/systemd/system/hivemind-playwright-mcp-tunnel.service
systemctl daemon-reload
systemctl enable --now hivemind-playwright-mcp-tunnel.service
systemctl is-active --quiet hivemind-playwright-mcp-tunnel.service
