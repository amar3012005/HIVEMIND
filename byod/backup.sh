#!/usr/bin/env bash
# Customer-controlled, non-destructive Memory Box backup.
# Creates a portable PostgreSQL dump, Qdrant snapshot and verified manifest.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/memory-box-common.sh"
if [[ -f "$HM_CONFIG_DIR/memory-box.env" ]]; then set -a; . "$HM_CONFIG_DIR/memory-box.env"; set +a; fi
MANIFEST_TOOL="$HERE/storage-manifest.mjs"
[[ -f "$MANIFEST_TOOL" ]] || MANIFEST_TOOL="$HERE/../scripts/storage-manifest.mjs"
[[ -f "$MANIFEST_TOOL" ]] || { echo "storage-manifest.mjs is missing; reinstall the Memory Box bundle" >&2; exit 1; }
DEST_ROOT="${BYOD_BACKUP_DIR:-$HERE/backups}"
KEEP="${BYOD_BACKUP_KEEP:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING="$DEST_ROOT/.${STAMP}.partial"
FINAL="$DEST_ROOT/$STAMP"
hm_compose_prefix
COMPOSE=("${HM_COMPOSE[@]}")

mkdir -p "$DEST_ROOT"
rm -rf "$STAGING"
mkdir -m 700 "$STAGING"

"${COMPOSE[@]}" exec -T postgres sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' \
  > "$STAGING/postgres.dump"
test -s "$STAGING/postgres.dump"
"${COMPOSE[@]}" exec -T postgres sh -lc 'pg_restore --list >/dev/null' < "$STAGING/postgres.dump"

SNAPSHOT="$(docker exec hm-byod-agent node -e '
fetch("http://qdrant:6333/snapshots", {method:"POST"})
  .then(r => r.json()).then(j => {
    const name = j?.result?.name || j?.name;
    if (!name) throw new Error("snapshot name missing");
    process.stdout.write(name);
  }).catch(e => { console.error(e.message); process.exit(1); });
')"
test -n "$SNAPSHOT"
docker cp "hm-byod-qdrant:/qdrant/snapshots/$SNAPSHOT" "$STAGING/qdrant.snapshot" >/dev/null
test -s "$STAGING/qdrant.snapshot"

TENANT_REF="$(printf '%s' "${HIVEMIND_ORG_ID:-unknown}" | sha256sum | cut -c1-16)"
QDRANT_IMAGE="$(docker inspect hm-byod-qdrant --format '{{.Config.Image}}')"
POSTGRES_IMAGE="$(docker inspect hm-byod-postgres --format '{{.Config.Image}}')"
QDRANT_IMAGE_ID="$(docker inspect hm-byod-qdrant --format '{{.Image}}')"
POSTGRES_IMAGE_ID="$(docker inspect hm-byod-postgres --format '{{.Image}}')"
export STORAGE_MANIFEST_METADATA_JSON="$(QDRANT_IMAGE="$QDRANT_IMAGE" POSTGRES_IMAGE="$POSTGRES_IMAGE" QDRANT_IMAGE_ID="$QDRANT_IMAGE_ID" POSTGRES_IMAGE_ID="$POSTGRES_IMAGE_ID" node -e \
  'process.stdout.write(JSON.stringify({qdrant_image:process.env.QDRANT_IMAGE,postgres_image:process.env.POSTGRES_IMAGE,qdrant_image_id:process.env.QDRANT_IMAGE_ID,postgres_image_id:process.env.POSTGRES_IMAGE_ID}))')"
node "$MANIFEST_TOOL" create "$STAGING" byod "$TENANT_REF" >/dev/null
node "$MANIFEST_TOOL" verify "$STAGING" >/dev/null
rm -rf "$FINAL"
mv "$STAGING" "$FINAL"

# The customer-owned command must return zero only after the remote object is
# durable and its checksum/ETag has been verified. HIVE-MIND never receives the
# destination credential; it exposes only BACKUP_PATH to the local command.
if [[ -n "${BYOD_BACKUP_UPLOAD_COMMAND:-}" ]]; then
  export BACKUP_PATH="$FINAL"
  eval "$BYOD_BACKUP_UPLOAD_COMMAND"
  UPLOADED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    TARGET_LABEL="${BYOD_BACKUP_TARGET_LABEL:-customer_offsite}" \
    node -e 'process.stdout.write(JSON.stringify({uploaded_at:process.env.UPLOADED_AT,target:process.env.TARGET_LABEL})+"\n")' \
    > "$FINAL/OFFSITE_RECEIPT.json"
fi

find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name '.*.partial' -print0 \
  | xargs -0 ls -1dt 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -rf

echo "Memory Box backup verified: $FINAL"
if [[ -f "$FINAL/OFFSITE_RECEIPT.json" ]]; then
  echo "Memory Box backup uploaded off-host and acknowledged: $FINAL"
else
  echo "Keep a copy off this machine; local backup alone does not protect against box loss."
fi
