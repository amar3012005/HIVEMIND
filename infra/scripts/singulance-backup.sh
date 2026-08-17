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

# Qdrant's production image intentionally contains no wget/curl. Use the Core
# container's Node runtime on the same private network to request the snapshot,
# then copy the acknowledged file out of Qdrant. Credentials remain inside the
# container environment and are never printed.
SNAPSHOT="$(docker exec hm-core node -e '
const base=String(process.env.QDRANT_URL||"http://qdrant:6333").replace(/\/+$/,"");
const key=process.env.QDRANT_API_KEY||"";
fetch(`${base}/snapshots`,{method:"POST",headers:{"content-type":"application/json",...(key?{"api-key":key}:{})},body:"{}"})
 .then(async r=>{const j=await r.json();if(!r.ok)throw new Error(`qdrant ${r.status}`);const n=j?.result?.name||j?.name;if(!n)throw new Error("snapshot name missing");process.stdout.write(n)})
 .catch(e=>{console.error(e.message);process.exit(1)});
')"
test -n "$SNAPSHOT"
docker exec hm-qdrant sh -lc "cat /qdrant/snapshots/$SNAPSHOT" > "$DEST/qdrant.snapshot"
test -s "$DEST/qdrant.snapshot"

# The AMR/registry volume is the sole copy of personal AMR workspace records.
docker run --rm -v hivemind_hivemind-data:/data:ro -v "$DEST:/out" alpine:3.20 \
  tar czf /out/amr-data.tar.gz -C /data .
gzip -t "$DEST/amr-data.tar.gz"

QDRANT_IMAGE="$(docker inspect hm-qdrant --format '{{.Config.Image}}')"
POSTGRES_IMAGE="$(docker inspect hm-postgres --format '{{.Config.Image}}')"
QDRANT_IMAGE_ID="$(docker inspect hm-qdrant --format '{{.Image}}')"
POSTGRES_IMAGE_ID="$(docker inspect hm-postgres --format '{{.Image}}')"
export STORAGE_MANIFEST_METADATA_JSON="$(QDRANT_IMAGE="$QDRANT_IMAGE" POSTGRES_IMAGE="$POSTGRES_IMAGE" QDRANT_IMAGE_ID="$QDRANT_IMAGE_ID" POSTGRES_IMAGE_ID="$POSTGRES_IMAGE_ID" node -e \
  'process.stdout.write(JSON.stringify({qdrant_image:process.env.QDRANT_IMAGE,postgres_image:process.env.POSTGRES_IMAGE,qdrant_image_id:process.env.QDRANT_IMAGE_ID,postgres_image_id:process.env.POSTGRES_IMAGE_ID}))')"
node "$REPO_ROOT/scripts/storage-manifest.mjs" create "$DEST" managed platform >/dev/null
node "$REPO_ROOT/scripts/storage-manifest.mjs" verify "$DEST" >/dev/null
rm -rf "$FINAL_DEST"
mv "$DEST" "$FINAL_DEST"

# Encrypt the verified recovery unit with a host-operator key that is never
# loaded into Core or any application container. The upload command receives
# only authenticated ciphertext plus its checksum.
BACKUP_KEY_FILE="${MANAGED_BACKUP_KEY_FILE:-/root/.config/hivemind-backup.env}"
[[ -f "$BACKUP_KEY_FILE" ]] || { echo "Managed backup key file missing: $BACKUP_KEY_FILE" >&2; exit 2; }
# shellcheck disable=SC1090
source "$BACKUP_KEY_FILE"
[[ -n "${STORAGE_BACKUP_ENCRYPTION_KEY:-}" ]] || { echo "STORAGE_BACKUP_ENCRYPTION_KEY missing" >&2; exit 2; }
ENCRYPTED_BUNDLE="$BACKUP_DIR/$STAMP.hmstorage"
node "$REPO_ROOT/scripts/storage-bundle-crypto.mjs" encrypt "$FINAL_DEST" "$ENCRYPTED_BUNDLE" >/dev/null
unset STORAGE_BACKUP_ENCRYPTION_KEY
BACKUP_SHA256="$(sha256sum "$ENCRYPTED_BUNDLE" | awk '{print $1}')"

if [[ -z "${BACKUP_UPLOAD_COMMAND:-}" ]]; then
  echo "Backup created and verified at $FINAL_DEST but NOT off-host. Set BACKUP_UPLOAD_COMMAND to activate DR." >&2
  exit 2
fi

export BACKUP_PATH="$ENCRYPTED_BUNDLE" BACKUP_SHA256
eval "$BACKUP_UPLOAD_COMMAND"
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} +
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.hmstorage' -mtime +"$RETENTION_DAYS" -delete
echo "Backup uploaded and retained: $FINAL_DEST"
