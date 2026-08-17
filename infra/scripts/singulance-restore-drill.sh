#!/usr/bin/env bash
# Weekly non-destructive proof that the latest encrypted managed recovery unit
# authenticates, decrypts, restores, and opens in disposable containers.
set -euo pipefail

LOCK_FILE="${RESTORE_DRILL_LOCK_FILE:-/run/lock/hivemind-storage-restore-drill.lock}"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another storage restore drill is active" >&2; exit 1; }

REPO_ROOT="${REPO_ROOT:-/root/hivemind}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/hivemind}"
RECEIPT_DIR="${RESTORE_DRILL_RECEIPT_DIR:-/var/lib/hivemind/restore-drills}"
KEY_FILE="${MANAGED_BACKUP_KEY_FILE:-/root/.config/hivemind-backup.env}"
BUNDLE="${RESTORE_DRILL_BUNDLE:-$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.hmstorage' -print | sort | tail -1)}"
[[ -f "$BUNDLE" ]] || { echo "no encrypted managed backup found" >&2; exit 2; }
[[ -f "$KEY_FILE" ]] || { echo "managed backup key file is missing" >&2; exit 2; }
# shellcheck disable=SC1090
source "$KEY_FILE"
[[ -n "${STORAGE_BACKUP_ENCRYPTION_KEY:-}" ]] || { echo "managed backup key is missing" >&2; exit 2; }
export STORAGE_BACKUP_ENCRYPTION_KEY

TMP="$(mktemp -d "${TMPDIR:-/var/tmp}/hm-managed-restore.XXXXXX")"
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT INT TERM
RESTORED="$TMP/backup"
node "$REPO_ROOT/scripts/storage-bundle-crypto.mjs" decrypt "$BUNDLE" "$RESTORED" >/dev/null
unset STORAGE_BACKUP_ENCRYPTION_KEY
RESULT="$(bash "$REPO_ROOT/scripts/storage-restore-drill.sh" --mode managed --backup "$RESTORED")"
RESULT="$RESULT" node -e 'const r=JSON.parse(process.env.RESULT);if(r.ok!==true||r.mode!=="managed")process.exit(1)'

mkdir -p -m 700 "$RECEIPT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PARTIAL="$RECEIPT_DIR/.${STAMP}.partial-$$"
BUNDLE_SHA256="$(sha256sum "$BUNDLE" | awk '{print $1}')"
RESULT="$RESULT" BUNDLE_SHA256="$BUNDLE_SHA256" node -e '
const result=JSON.parse(process.env.RESULT);
process.stdout.write(JSON.stringify({version:1,complete:true,verified_at:new Date().toISOString(),bundle_sha256:process.env.BUNDLE_SHA256,result},null,2)+"\n");
' > "$PARTIAL"
chmod 600 "$PARTIAL"
mv "$PARTIAL" "$RECEIPT_DIR/$STAMP.json"
find "$RECEIPT_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.json' -mtime +90 -delete
echo "$RESULT"
