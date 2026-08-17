#!/usr/bin/env bash
# Non-destructive restore drill for a verified HIVE-MIND storage backup.
# All state is restored into disposable containers and a mktemp directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP=""
MODE=""
ORG_ID="${RESTORE_DRILL_ORG_ID:-}"
AGENT_IMAGE="${RESTORE_DRILL_AGENT_IMAGE:-}"
CORE_IMAGE="${RESTORE_DRILL_CORE_IMAGE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --org-id) ORG_ID="$2"; shift 2 ;;
    --agent-image) AGENT_IMAGE="$2"; shift 2 ;;
    --core-image) CORE_IMAGE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -d "$BACKUP" ]] || { echo "--backup must name a completed backup directory" >&2; exit 2; }
MANIFEST_TOOL="$HERE/storage-manifest.mjs"
[[ -f "$MANIFEST_TOOL" ]] || { echo "storage-manifest.mjs is missing" >&2; exit 2; }
node "$MANIFEST_TOOL" verify "$BACKUP" >/dev/null

MANIFEST="$BACKUP/STORAGE_MANIFEST.json"
MANIFEST_MODE="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.storage_mode||"")' "$MANIFEST")"
MODE="${MODE:-$MANIFEST_MODE}"
[[ "$MODE" == managed || "$MODE" == byod ]] || { echo "restore drill supports managed or byod backups" >&2; exit 2; }
[[ "$MODE" == "$MANIFEST_MODE" ]] || { echo "requested mode does not match manifest" >&2; exit 2; }

PG_IMAGE="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.metadata?.postgres_image_id||"")' "$MANIFEST")"
QD_IMAGE="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.metadata?.qdrant_image_id||"")' "$MANIFEST")"
[[ "$PG_IMAGE" == sha256:* && "$QD_IMAGE" == sha256:* ]] || {
  echo "manifest lacks immutable PostgreSQL/Qdrant image IDs" >&2; exit 1;
}
docker image inspect "$PG_IMAGE" >/dev/null
docker image inspect "$QD_IMAGE" >/dev/null

DRILL="hm-storage-drill-${MODE}-$$"
NET="${DRILL}-net"
PG="${DRILL}-pg"
QD="${DRILL}-qdrant"
AG="${DRILL}-agent"
TMP="$(mktemp -d "${TMPDIR:-/var/tmp}/hm-storage-drill.XXXXXX")"
cleanup() {
  docker rm -f "$AG" "$PG" "$QD" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM
mkdir -p "$TMP/pg" "$TMP/qdrant"
chmod 700 "$TMP/pg" "$TMP/qdrant"
docker network create "$NET" >/dev/null

docker run -d --name "$PG" --network "$NET" --network-alias postgres \
  -e POSTGRES_USER=hivemind -e POSTGRES_PASSWORD=restore-drill-only -e POSTGRES_DB=hivemind \
  -v "$TMP/pg:/var/lib/postgresql/data" "$PG_IMAGE" >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$PG" pg_isready -U hivemind -d hivemind >/dev/null 2>&1; then
    ready=$((ready + 1))
  else
    ready=0
  fi
  [[ "$ready" -ge 3 ]] && break
  [[ "$(docker inspect "$PG" --format '{{.State.Running}}' 2>/dev/null || true)" == true ]] || break
  sleep 1
done
[[ "$ready" -ge 3 ]] || { docker logs "$PG" --tail 80 >&2; exit 1; }
docker exec "$PG" createdb -U hivemind restore_drill
docker exec -i "$PG" pg_restore -U hivemind -d restore_drill \
  --exit-on-error --no-owner --no-privileges < "$BACKUP/postgres.dump"
PG_TABLES="$(docker exec "$PG" psql -U hivemind -d restore_drill -Atc \
  "select count(*) from pg_catalog.pg_tables where schemaname not in ('pg_catalog','information_schema')")"
[[ "$PG_TABLES" -gt 0 ]] || { echo "PostgreSQL restore contains no application tables" >&2; exit 1; }

docker run -d --name "$QD" --network "$NET" --network-alias qdrant \
  --ulimit nofile=65535:65535 \
  -v "$TMP/qdrant:/qdrant/storage" \
  -v "$BACKUP/qdrant.snapshot:/snapshots/restore.snapshot:ro" \
  "$QD_IMAGE" ./qdrant --storage-snapshot /snapshots/restore.snapshot >/dev/null

if [[ -z "$AGENT_IMAGE" ]] && docker inspect hm-byod-agent >/dev/null 2>&1; then
  AGENT_IMAGE="$(docker inspect hm-byod-agent --format '{{.Config.Image}}')"
fi
if [[ -z "$CORE_IMAGE" ]] && docker inspect hm-core >/dev/null 2>&1; then
  CORE_IMAGE="$(docker inspect hm-core --format '{{.Config.Image}}')"
fi
PROBE_IMAGE="${AGENT_IMAGE:-$CORE_IMAGE}"
[[ -n "$PROBE_IMAGE" ]] || { echo "set --agent-image or --core-image for the Node health probe" >&2; exit 2; }

QDRANT_RESULT=""
for _ in $(seq 1 120); do
  [[ "$(docker inspect "$QD" --format '{{.State.Running}}' 2>/dev/null || true)" == true ]] \
    || { docker logs "$QD" --tail 100 >&2; exit 1; }
  QDRANT_RESULT="$(docker run --rm --network "$NET" "$PROBE_IMAGE" node -e '
fetch("http://qdrant:6333/collections").then(async r=>{if(!r.ok)process.exit(1);const j=await r.json();const names=j?.result?.collections?.map(x=>x.name)||[];process.stdout.write(JSON.stringify(names))}).catch(()=>process.exit(1))
' 2>/dev/null || true)"
  [[ "$QDRANT_RESULT" == \[* ]] && break
  sleep 1
done
QD_COLLECTIONS="$(QDRANT_RESULT="$QDRANT_RESULT" node -e 'const a=JSON.parse(process.env.QDRANT_RESULT||"[]");process.stdout.write(String(a.length))')"
[[ "$QD_COLLECTIONS" -gt 0 ]] || { echo "Qdrant restore contains no collections" >&2; exit 1; }

AMR_COUNT="not_applicable"
if [[ -f "$BACKUP/amr-data.tar.gz" ]]; then
  mkdir -p "$TMP/amr"
  tar xzf "$BACKUP/amr-data.tar.gz" -C "$TMP/amr"
  AMR_ORG="$(find "$TMP/amr/mneme" -mindepth 1 -maxdepth 1 -type d -exec du -sk {} + \
    | sort -nr | head -1 | awk '{n=$2; sub(".*/", "", n); print n}')"
  [[ -n "$CORE_IMAGE" && -n "$AMR_ORG" ]] || { echo "AMR restore requires a Core image and shard" >&2; exit 1; }
  AMR_COUNT="$(docker run --rm -e DRILL_ORG="$AMR_ORG" -v "$TMP/amr:/restore:rw" "$CORE_IMAGE" \
    node --input-type=module -e '
import {AmrMemoryStore} from "/app/src/vector/mneme/amr-store.mjs";
const s=new AmrMemoryStore({dataRoot:"/restore/mneme",org:process.env.DRILL_ORG,dim:1024});
process.stdout.write(String(s.liveCount()));
')"
  [[ "$AMR_COUNT" -gt 0 ]] || { echo "restored AMR shard is empty" >&2; exit 1; }
fi

MEMORY_HITS="not_run"
EVIDENCE_HITS="not_run"
if [[ "$MODE" == byod && -n "$ORG_ID" && -n "$AGENT_IMAGE" ]]; then
  docker run -d --name "$AG" --network "$NET" \
    -e ORG_ID="$ORG_ID" -e AGENT_TOKEN=restore-drill-token \
    -e DATABASE_URL='postgresql://hivemind:restore-drill-only@postgres:5432/restore_drill?schema=hm' \
    -e QDRANT_URL=http://qdrant:6333 -e MNEME_DIM=1024 -e AGENT_PORT=8787 \
    "$AGENT_IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    [[ "$(docker inspect "$AG" --format '{{.State.Running}}' 2>/dev/null || true)" == true ]] \
      || { docker logs "$AG" --tail 80 >&2; exit 1; }
    docker logs "$AG" 2>&1 | grep -q 'listening :8787' && break
    sleep 1
  done
  HITS="$(docker exec "$AG" node -e '
const org=process.env.ORG_ID;const collection=`org_${org}`.replace(/[^a-zA-Z0-9]/g,"_");
const h={"content-type":"application/json",authorization:"Bearer restore-drill-token","x-org-id":org};
const post=(url,body,auth=false)=>fetch(url,{method:"POST",headers:auth?h:{"content-type":"application/json"},body:JSON.stringify(body)}).then(r=>r.json());
(async()=>{const s=await post(`http://qdrant:6333/collections/${collection}/points/scroll`,{limit:500,with_payload:true,with_vector:true});const p=s?.result?.points||[];const m=p.find(x=>x.payload?.layer!=="segment");const e=p.find(x=>x.payload?.layer==="segment");if(!m||!e)throw Error("memory/evidence vectors missing");const mr=await post("http://127.0.0.1:8787/v1/recall",{vector:m.vector,limit:5,filter:{}},true);const er=await post("http://127.0.0.1:8787/v1/kb-recall",{vector:e.vector,limit:5,access:{userId:e.payload?.user_id,orgId:org,scope:"all"}},true);const out={memory:(mr.memories||mr.results||[]).length,evidence:(er.results||[]).length};if(!out.memory||!out.evidence)throw Error("restored recall empty");process.stdout.write(JSON.stringify(out))})().catch(e=>{console.error(e.message);process.exit(1)});
')"
  MEMORY_HITS="$(HITS="$HITS" node -e 'process.stdout.write(String(JSON.parse(process.env.HITS).memory))')"
  EVIDENCE_HITS="$(HITS="$HITS" node -e 'process.stdout.write(String(JSON.parse(process.env.HITS).evidence))')"
fi

printf '{"ok":true,"mode":"%s","postgres_tables":%s,"qdrant_collections":%s,"amr_live_count":"%s","memory_hits":"%s","evidence_hits":"%s"}\n' \
  "$MODE" "$PG_TABLES" "$QD_COLLECTIONS" "$AMR_COUNT" "$MEMORY_HITS" "$EVIDENCE_HITS"

