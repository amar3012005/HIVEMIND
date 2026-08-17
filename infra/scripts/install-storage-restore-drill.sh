#!/usr/bin/env bash
# Install the restore-drill runtime from one immutable canonical worktree.
set -euo pipefail
SOURCE_ROOT="${1:-}"
[[ -n "$SOURCE_ROOT" && -f "$SOURCE_ROOT/scripts/storage-restore-drill.sh" ]] || {
  echo "usage: install-storage-restore-drill.sh CANONICAL_RELEASE_WORKTREE" >&2
  exit 2
}
DEST="/usr/local/libexec/hivemind-storage"
install -d -m 755 "$DEST/scripts" "$DEST/infra/scripts"
install -m 755 "$SOURCE_ROOT/scripts/storage-restore-drill.sh" "$DEST/scripts/storage-restore-drill.sh"
install -m 755 "$SOURCE_ROOT/scripts/storage-bundle-crypto.mjs" "$DEST/scripts/storage-bundle-crypto.mjs"
install -m 755 "$SOURCE_ROOT/scripts/storage-manifest.mjs" "$DEST/scripts/storage-manifest.mjs"
install -m 755 "$SOURCE_ROOT/infra/scripts/singulance-restore-drill.sh" "$DEST/infra/scripts/singulance-restore-drill.sh"
install -m 644 "$SOURCE_ROOT/infra/scripts/singulance-restore-drill.service" /etc/systemd/system/singulance-restore-drill.service
install -m 644 "$SOURCE_ROOT/infra/scripts/singulance-restore-drill.timer" /etc/systemd/system/singulance-restore-drill.timer
systemctl daemon-reload
systemctl enable singulance-restore-drill.timer >/dev/null
echo "Installed encrypted storage restore drill from $(git -C "$SOURCE_ROOT" rev-parse HEAD)"
