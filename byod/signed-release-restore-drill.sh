#!/usr/bin/env bash
# Prove signed agent upgrade and rollback against a disposable restored Memory Box.
# Customer data is never changed: PostgreSQL and Qdrant are restored into mktemp storage.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP="${1:-}"
ORG_ID="${2:-}"
BASE_IMAGE="${3:-}"
MANIFEST="${4:-}"
SIGNATURE="${5:-}"
PUBLIC_KEY="${BYOD_RELEASE_PUBLIC_KEY:-}"
RECEIPT_DIR="${BYOD_RELEASE_DRILL_RECEIPT_DIR:-$HERE/.releases/drills}"

[[ -d "$BACKUP" && -f "$MANIFEST" && -f "$SIGNATURE" && -f "$PUBLIC_KEY" ]] || {
  echo "usage: BYOD_RELEASE_PUBLIC_KEY=... $0 BACKUP ORG_ID BASE_IMAGE RELEASE.json RELEASE.sig" >&2
  exit 2
}
[[ "$ORG_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "invalid org id" >&2; exit 2; }
docker image inspect "$BASE_IMAGE" >/dev/null
BASE_IMAGE_ID="$(docker image inspect "$BASE_IMAGE" --format '{{.Id}}')"
node "$HERE/verify-release.mjs" "$MANIFEST" "$SIGNATURE" "$PUBLIC_KEY" >/dev/null
RELEASE_IMAGE="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.image)' "$MANIFEST")"

MANIFEST_TOOL="$HERE/storage-manifest.mjs"
[[ -f "$MANIFEST_TOOL" ]] || MANIFEST_TOOL="$HERE/../scripts/storage-manifest.mjs"
node "$MANIFEST_TOOL" verify "$BACKUP" >/dev/null
BACKUP_MANIFEST="$BACKUP/STORAGE_MANIFEST.json"
[[ "$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.storage_mode||"")' "$BACKUP_MANIFEST")" == byod ]] \
  || { echo "backup is not BYOD" >&2; exit 2; }
PG_IMAGE="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.metadata?.postgres_image_id||"")' "$BACKUP_MANIFEST")"
QD_IMAGE="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.metadata?.qdrant_image_id||"")' "$BACKUP_MANIFEST")"
docker image inspect "$PG_IMAGE" >/dev/null
docker image inspect "$QD_IMAGE" >/dev/null

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DRILL="hm-byod-release-drill-$$"
NET="$DRILL-net"
PG="$DRILL-pg"
QD="$DRILL-qdrant"
AG="$DRILL-agent"
TMP="$(mktemp -d "${TMPDIR:-/var/tmp}/hm-byod-release-drill.XXXXXX")"
STATE="$TMP/releases"
COMPOSE_FILE="$TMP/compose.yml"
TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
cleanup() {
  docker rm -f "$AG" "$PG" "$QD" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM
mkdir -p "$TMP/pg" "$TMP/qdrant" "$STATE"
chmod 700 "$TMP" "$TMP/pg" "$TMP/qdrant" "$STATE"
docker network create "$NET" >/dev/null

docker run -d --name "$PG" --network "$NET" --network-alias postgres \
  -e POSTGRES_USER=hivemind -e POSTGRES_PASSWORD=restore-drill-only -e POSTGRES_DB=hivemind \
  -v "$TMP/pg:/var/lib/postgresql/data" "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -U hivemind -d hivemind >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG" pg_isready -U hivemind -d hivemind >/dev/null
docker exec -i "$PG" pg_restore -U hivemind -d hivemind \
  --exit-on-error --no-owner --no-privileges < "$BACKUP/postgres.dump"

docker run -d --name "$QD" --network "$NET" --network-alias qdrant \
  --ulimit nofile=65535:65535 \
  -v "$TMP/qdrant:/qdrant/storage" \
  -v "$BACKUP/qdrant.snapshot:/snapshots/restore.snapshot:ro" \
  "$QD_IMAGE" ./qdrant --storage-snapshot /snapshots/restore.snapshot >/dev/null
for _ in $(seq 1 120); do
  docker run --rm --network "$NET" "$BASE_IMAGE" node -e \
    'fetch("http://qdrant:6333/collections").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' \
    >/dev/null 2>&1 && break
  sleep 1
done
docker run --rm --network "$NET" "$BASE_IMAGE" node -e \
  'fetch("http://qdrant:6333/collections").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' \
  >/dev/null 2>&1

cat > "$COMPOSE_FILE" <<EOF
services:
  agent:
    image: $BASE_IMAGE
    container_name: $AG
    environment:
      ORG_ID: $ORG_ID
      AGENT_TOKEN: $TOKEN
      AGENT_RELEASE: restore-base
      DATABASE_URL: postgresql://hivemind:restore-drill-only@postgres:5432/hivemind?schema=hm
      QDRANT_URL: http://qdrant:6333
      MNEME_DIM: "1024"
      AGENT_PORT: "8787"
    networks: [drill]
networks:
  drill:
    external: true
    name: $NET
EOF
chmod 600 "$COMPOSE_FILE"
docker compose -p "$DRILL" -f "$COMPOSE_FILE" up -d agent >/dev/null

probe() {
  docker exec "$AG" node -e '
const org=process.env.ORG_ID;const collection=`org_${org}`.replace(/[^a-zA-Z0-9]/g,"_");
const h={"content-type":"application/json",authorization:`Bearer ${process.env.AGENT_TOKEN}`,"x-org-id":org};
const post=(url,body,auth=false)=>fetch(url,{method:"POST",headers:auth?h:{"content-type":"application/json"},body:JSON.stringify(body)}).then(async r=>{if(!r.ok)throw Error(`${url} ${r.status}`);return r.json()});
(async()=>{const scroll=filter=>post(`http://qdrant:6333/collections/${collection}/points/scroll`,{limit:1,filter,with_payload:true,with_vector:true});const ms=await scroll({must_not:[{key:"layer",match:{value:"segment"}}]});const es=await scroll({must:[{key:"layer",match:{value:"segment"}}]});const m=ms?.result?.points?.[0];const e=es?.result?.points?.[0];if(!m||!e)throw Error("memory/evidence vectors missing");const mr=await post("http://127.0.0.1:8787/v1/recall",{vector:m.vector,limit:5,filter:{}},true);const er=await post("http://127.0.0.1:8787/v1/kb-recall",{vector:e.vector,limit:5,access:{userId:e.payload?.user_id,orgId:org,scope:"all"}},true);const out={memory:(mr.memories||mr.results||[]).length,evidence:(er.results||[]).length};if(!out.memory||!out.evidence)throw Error("restored recall empty");process.stdout.write(JSON.stringify(out))})().catch(e=>{console.error(e.message);process.exit(1)});'
}

for _ in $(seq 1 60); do
  BASE_HITS="$(probe 2>/dev/null || true)"
  [[ "$BASE_HITS" == \{* ]] && break
  sleep 1
done
[[ "$BASE_HITS" == \{* ]] || { docker logs "$AG" --tail 100 >&2; exit 1; }

export BYOD_COMPOSE_FILE="$COMPOSE_FILE"
export BYOD_COMPOSE_PROJECT_NAME="$DRILL"
export BYOD_AGENT_CONTAINER="$AG"
export BYOD_RELEASE_STATE_DIR="$STATE"
bash "$HERE/upgrade.sh" "$MANIFEST" "$SIGNATURE"
UPGRADE_IMAGE_ID="$(docker inspect "$AG" --format '{{.Image}}')"
EXPECTED_UPGRADE_IMAGE_ID="$(docker image inspect "$RELEASE_IMAGE" --format '{{.Id}}')"
[[ "$UPGRADE_IMAGE_ID" == "$EXPECTED_UPGRADE_IMAGE_ID" ]] || { echo "upgraded agent is not the signed image" >&2; exit 1; }
UPGRADE_HITS="$(probe)"
bash "$HERE/rollback.sh"
ROLLBACK_IMAGE_ID="$(docker inspect "$AG" --format '{{.Image}}')"
[[ "$ROLLBACK_IMAGE_ID" == "$BASE_IMAGE_ID" ]] || { echo "rollback did not restore the original image" >&2; exit 1; }
ROLLBACK_HITS="$(probe)"
[[ "$BASE_HITS" == "$UPGRADE_HITS" && "$BASE_HITS" == "$ROLLBACK_HITS" ]] \
  || { echo "recall parity changed across upgrade/rollback" >&2; exit 1; }

RELEASE="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.release)' "$MANIFEST")"
IMAGE="$RELEASE_IMAGE"
BACKUP_SHA="$(sha256sum "$BACKUP_MANIFEST" | awk '{print $1}')"
MANIFEST_SHA="$(sha256sum "$MANIFEST" | awk '{print $1}')"
mkdir -p "$RECEIPT_DIR"
chmod 700 "$RECEIPT_DIR"
RECEIPT_TMP="$RECEIPT_DIR/.${STAMP}.json.partial"
STAMP="$STAMP" RELEASE="$RELEASE" IMAGE="$IMAGE" BASE_IMAGE_ID="$BASE_IMAGE_ID" UPGRADE_IMAGE_ID="$UPGRADE_IMAGE_ID" ROLLBACK_IMAGE_ID="$ROLLBACK_IMAGE_ID" BACKUP_SHA="$BACKUP_SHA" MANIFEST_SHA="$MANIFEST_SHA" \
BASE_HITS="$BASE_HITS" UPGRADE_HITS="$UPGRADE_HITS" ROLLBACK_HITS="$ROLLBACK_HITS" \
node -e 'process.stdout.write(JSON.stringify({version:1,ok:true,completed_at:new Date().toISOString(),release:process.env.RELEASE,image:process.env.IMAGE,base_image_id:process.env.BASE_IMAGE_ID,upgraded_image_id:process.env.UPGRADE_IMAGE_ID,rolled_back_image_id:process.env.ROLLBACK_IMAGE_ID,backup_manifest_sha256:process.env.BACKUP_SHA,release_manifest_sha256:process.env.MANIFEST_SHA,base:JSON.parse(process.env.BASE_HITS),upgraded:JSON.parse(process.env.UPGRADE_HITS),rolled_back:JSON.parse(process.env.ROLLBACK_HITS)},null,2)+"\n")' \
  > "$RECEIPT_TMP"
chmod 600 "$RECEIPT_TMP"
mv "$RECEIPT_TMP" "$RECEIPT_DIR/$STAMP.json"
echo "Signed BYOD release restore drill passed: $RECEIPT_DIR/$STAMP.json"
