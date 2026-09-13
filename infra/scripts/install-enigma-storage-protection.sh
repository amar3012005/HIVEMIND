#!/usr/bin/env bash
# Install Enigma's encrypted daily backup and weekly disposable restore drill
# from one immutable release worktree. Existing operator configuration and keys
# are preserved.
set -euo pipefail

SOURCE_ROOT="${1:-}"
[[ -n "$SOURCE_ROOT" && -f "$SOURCE_ROOT/infra/scripts/singulance-backup.sh" ]] || {
  echo "usage: install-enigma-storage-protection.sh CANONICAL_RELEASE_WORKTREE" >&2
  exit 2
}

DEST=/usr/local/libexec/enigma-storage
install -d -m 755 "$DEST/scripts" "$DEST/infra/scripts" /etc/enigma
install -m 755 "$SOURCE_ROOT/infra/scripts/singulance-backup.sh" "$DEST/infra/scripts/managed-backup.sh"
install -m 755 "$SOURCE_ROOT/infra/scripts/singulance-restore-drill.sh" "$DEST/infra/scripts/restore-drill.sh"
install -m 755 "$SOURCE_ROOT/scripts/storage-manifest.mjs" "$DEST/scripts/storage-manifest.mjs"
install -m 755 "$SOURCE_ROOT/scripts/storage-bundle-crypto.mjs" "$DEST/scripts/storage-bundle-crypto.mjs"
install -m 755 "$SOURCE_ROOT/scripts/storage-restore-drill.sh" "$DEST/scripts/storage-restore-drill.sh"
install -m 644 "$SOURCE_ROOT/infra/scripts/enigma-backup.service" /etc/systemd/system/enigma-backup.service
install -m 644 "$SOURCE_ROOT/infra/scripts/enigma-backup.timer" /etc/systemd/system/enigma-backup.timer
install -m 644 "$SOURCE_ROOT/infra/scripts/enigma-restore-drill.service" /etc/systemd/system/enigma-restore-drill.service
install -m 644 "$SOURCE_ROOT/infra/scripts/enigma-restore-drill.timer" /etc/systemd/system/enigma-restore-drill.timer

if [[ ! -f /etc/enigma/storage-protection.env ]]; then
  install -m 600 /dev/null /etc/enigma/storage-protection.env
  cat > /etc/enigma/storage-protection.env <<'EOF'
REPO_ROOT=/usr/local/libexec/enigma-storage
COMPOSE_DIR=/opt/enigma
ENV_FILE=/opt/enigma/.env
BACKUP_DIR=/opt/enigma/backups-managed
MANAGED_DATA_VOLUME=enigma_hivemind-data
MANAGED_BACKUP_KEY_FILE=/root/.config/hivemind-backup.env
RESTORE_DRILL_RECEIPT_DIR=/opt/enigma/restore-drills
EOF
  chmod 600 /etc/enigma/storage-protection.env
fi
# Migrate only the obsolete generated default; preserve any operator-selected
# Compose working directory.
if grep -qx 'COMPOSE_DIR=/root/hivemind/infra' /etc/enigma/storage-protection.env; then
  sed -i 's#^COMPOSE_DIR=/root/hivemind/infra$#COMPOSE_DIR=/opt/enigma#' /etc/enigma/storage-protection.env
fi

systemctl daemon-reload
systemctl enable --now enigma-backup.timer enigma-restore-drill.timer >/dev/null
echo "Installed Enigma storage protection from $(git -C "$SOURCE_ROOT" rev-parse HEAD)"
