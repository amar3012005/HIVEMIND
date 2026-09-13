#!/usr/bin/env bash
# Install aggregate-only ingestion monitoring from an immutable release tree.
set -euo pipefail

SOURCE_ROOT="${1:-}"
[[ -n "$SOURCE_ROOT" && -f "$SOURCE_ROOT/infra/scripts/enigma-ingestion-ops-check.sh" ]] || {
  echo "usage: install-enigma-ingestion-ops.sh CANONICAL_RELEASE_WORKTREE" >&2
  exit 2
}

DEST=/usr/local/libexec/enigma
install -d -m 755 "$DEST" /etc/enigma
install -m 755 "$SOURCE_ROOT/infra/scripts/enigma-ingestion-ops-check.sh" "$DEST/enigma-ingestion-ops-check.sh"
install -m 644 "$SOURCE_ROOT/infra/scripts/enigma-ingestion-ops-check.service" /etc/systemd/system/enigma-ingestion-ops-check.service
install -m 644 "$SOURCE_ROOT/infra/scripts/enigma-ingestion-ops-check.timer" /etc/systemd/system/enigma-ingestion-ops-check.timer
if [[ ! -f /etc/enigma/ingestion-ops.env ]]; then
  install -m 600 /dev/null /etc/enigma/ingestion-ops.env
fi
systemctl daemon-reload
systemctl enable --now enigma-ingestion-ops-check.timer >/dev/null
echo "Installed Enigma ingestion durability monitor from $(git -C "$SOURCE_ROOT" rev-parse HEAD)"
