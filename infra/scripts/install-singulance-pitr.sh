#!/usr/bin/env bash
# Install immutable PITR operator scripts and schedules from a canonical release.
set -euo pipefail
SOURCE_ROOT="${1:-}"
[[ -n "$SOURCE_ROOT" && -x "$SOURCE_ROOT/infra/scripts/singulance-pitr.sh" ]] || {
  echo "usage: install-singulance-pitr.sh CANONICAL_RELEASE_WORKTREE" >&2
  exit 2
}
DEST="/usr/local/libexec/hivemind-storage/infra/scripts"
install -d -m 755 "$DEST"
install -m 755 "$SOURCE_ROOT/infra/scripts/singulance-pitr.sh" "$DEST/singulance-pitr.sh"
install -m 755 "$SOURCE_ROOT/infra/scripts/singulance-pitr-restore-drill.sh" "$DEST/singulance-pitr-restore-drill.sh"
install -m 644 "$SOURCE_ROOT/infra/scripts/singulance-pitr-backup@.service" /etc/systemd/system/singulance-pitr-backup@.service
install -m 644 "$SOURCE_ROOT/infra/scripts/singulance-pitr-backup@full.timer" /etc/systemd/system/singulance-pitr-backup@full.timer
install -m 644 "$SOURCE_ROOT/infra/scripts/singulance-pitr-backup@diff.timer" /etc/systemd/system/singulance-pitr-backup@diff.timer
systemctl daemon-reload
systemctl enable singulance-pitr-backup@full.timer singulance-pitr-backup@diff.timer >/dev/null
echo "Installed managed PostgreSQL PITR runtime from $(git -C "$SOURCE_ROOT" rev-parse HEAD)"
