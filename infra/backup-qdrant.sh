#!/usr/bin/env bash
set -euo pipefail
umask 077

DEST="${QDRANT_BACKUP_DIR:-/root/backups/qdrant}"
KEY="${BACKUP_KEY_FILE:-/root/.hm-backup-key}"
KEEP="${QDRANT_BACKUP_KEEP:-7}"
ITERATIONS="${BACKUP_PBKDF2_ITERATIONS:-200000}"
CORE="${CORE_CONTAINER:-hm-core}"
QDRANT="${QDRANT_CONTAINER:-hm-qdrant}"
mkdir -p "$DEST"
exec 9>"$DEST/.backup.lock"
flock -n 9 || { echo "qdrant backup already running"; exit 1; }
test -s "$KEY" || { echo "backup key missing" >&2; exit 1; }

read -r name expected_checksum < <(docker exec "$CORE" node --input-type=module -e '
  const headers = process.env.QDRANT_API_KEY ? { "api-key": process.env.QDRANT_API_KEY } : {};
  const response = await fetch(`${process.env.QDRANT_URL}/snapshots`, { method: "POST", headers });
  if (!response.ok) throw new Error(`snapshot failed: ${response.status}`);
  const body = await response.json();
  console.log(`${body.result.name} ${body.result.checksum}`);
')

plain="$DEST/$name.partial"
encrypted="$DEST/$name.enc"
trap 'rm -f "$plain" "${encrypted:-}.partial"; test -n "${name:-}" && docker exec "$QDRANT" rm -f "/qdrant/snapshots/$name" >/dev/null 2>&1 || true' EXIT
docker cp "$QDRANT:/qdrant/snapshots/$name" "$plain" >/dev/null
actual_checksum="$(sha256sum "$plain" | cut -d' ' -f1)"
test "$actual_checksum" = "$expected_checksum" || { echo "Qdrant snapshot checksum mismatch" >&2; exit 1; }

openssl enc -aes-256-cbc -pbkdf2 -iter "$ITERATIONS" -salt -in "$plain" -out "$encrypted.partial" -pass file:"$KEY"
mv "$encrypted.partial" "$encrypted"
sha256sum "$encrypted" > "$encrypted.sha256"
test "$(openssl enc -aes-256-cbc -d -pbkdf2 -iter "$ITERATIONS" -in "$encrypted" -pass file:"$KEY" | sha256sum | cut -d' ' -f1)" = "$expected_checksum"
touch "$DEST/latest.ok"
ls -1t "$DEST"/full-snapshot-*.snapshot.enc 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old" "$old.sha256"; done
echo "qdrant backup: $encrypted ($(du -h "$encrypted" | cut -f1))"
