#!/usr/bin/env bash
# Run on Singulance as root. Creates a PostgreSQL dump, Qdrant snapshot, and
# AMR volume archive; upload is mandatory when BACKUP_UPLOAD_COMMAND is configured.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/hivemind}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
REPO_ROOT="${REPO_ROOT:-/root/hivemind}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/.${STAMP}.partial"
FINAL_DEST="$BACKUP_DIR/$STAMP"
COMPOSE_DIR="${COMPOSE_DIR:-/root/hivemind/infra}"
ENV_FILE="${ENV_FILE:-/root/hivemind/.env}"

rm -rf "$DEST"
mkdir -p "$DEST"
cd "$COMPOSE_DIR"

# Database dump is portable and avoids copying a live PostgreSQL data directory.
docker exec hm-postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' > "$DEST/postgres.dump"
test -s "$DEST/postgres.dump"
docker exec -i hm-postgres sh -lc 'pg_restore --list >/dev/null' < "$DEST/postgres.dump"

# Qdrant snapshot API is consistent; copy it out through the running container.
SNAPSHOT="$(docker exec hm-qdrant sh -lc 'wget -qO- --post-data="{}" --header="Content-Type: application/json" http://localhost:6333/snapshots' | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' | head -1)"
test -n "$SNAPSHOT"
docker exec hm-qdrant sh -lc "cat /qdrant/snapshots/$SNAPSHOT" > "$DEST/qdrant.snapshot"
test -s "$DEST/qdrant.snapshot"

# The AMR/registry volume is the sole copy of personal AMR workspace records.
docker run --rm -v hivemind_hivemind-data:/data:ro -v "$DEST:/out" alpine:3.20 \
  tar czf /out/amr-data.tar.gz -C /data .
gzip -t "$DEST/amr-data.tar.gz"

QDRANT_IMAGE="$(docker inspect hm-qdrant --format '{{.Config.Image}}')"
POSTGRES_IMAGE="$(docker inspect hm-postgres --format '{{.Config.Image}}')"
export STORAGE_MANIFEST_METADATA_JSON="$(QDRANT_IMAGE="$QDRANT_IMAGE" POSTGRES_IMAGE="$POSTGRES_IMAGE" node -e \
  'process.stdout.write(JSON.stringify({qdrant_image:process.env.QDRANT_IMAGE,postgres_image:process.env.POSTGRES_IMAGE}))')"
node "$REPO_ROOT/scripts/storage-manifest.mjs" create "$DEST" managed platform >/dev/null
node "$REPO_ROOT/scripts/storage-manifest.mjs" verify "$DEST" >/dev/null
rm -rf "$FINAL_DEST"
mv "$DEST" "$FINAL_DEST"

if [[ -z "${BACKUP_UPLOAD_COMMAND:-}" ]]; then
  echo "Backup created and verified at $FINAL_DEST but NOT off-host. Set BACKUP_UPLOAD_COMMAND to activate DR." >&2
  exit 2
fi

export BACKUP_PATH="$FINAL_DEST"
eval "$BACKUP_UPLOAD_COMMAND"
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} +
echo "Backup uploaded and retained: $FINAL_DEST"
