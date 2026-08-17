#!/usr/bin/env bash
# Destructive-to-a-disposable-volume PITR acceptance drill. Production receives
# only a uniquely named canary table which is removed by the EXIT trap.
set -euo pipefail

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-hm-postgres}"
REPO_VOLUME="${PITR_REPO_VOLUME:-hivemind_postgres-pitr-repo}"
SECRET_VOLUME="${PITR_SECRET_VOLUME:-hivemind_postgres-pitr-secrets}"
STANZA="${PITR_STANZA:-hivemind}"
RECEIPT_DIR="${PITR_RECEIPT_DIR:-/var/lib/hivemind/pitr-drills}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TOKEN="$(printf '%s' "$STAMP-$$" | sha256sum | cut -c1-12)"
RESTORE_POINT="hivemind_pitr_${TOKEN}"
DRILL_CONTAINER="hm-postgres-pitr-drill-${TOKEN}"
DRILL_VOLUME="hivemind_pitr_drill_${TOKEN}"
IMAGE="$(docker inspect "$POSTGRES_CONTAINER" --format '{{.Config.Image}}')"
PG_USER="$(docker exec "$POSTGRES_CONTAINER" sh -lc 'printf %s "$POSTGRES_USER"')"
PG_DB="$(docker exec "$POSTGRES_CONTAINER" sh -lc 'printf %s "$POSTGRES_DB"')"

primary_sql() {
  docker exec "$POSTGRES_CONTAINER" sh -lc 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"' sh "$1"
}

cleanup() {
  docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$DRILL_VOLUME" >/dev/null 2>&1 || true
  primary_sql 'DROP TABLE IF EXISTS public.hivemind_pitr_canary' >/dev/null 2>&1 || true
}
trap cleanup EXIT

[[ "$(primary_sql 'show archive_mode')" == on ]] || { echo "archive_mode is not on" >&2; exit 2; }
docker exec -u postgres "$POSTGRES_CONTAINER" hivemind-pgbackrest --stanza="$STANZA" check >/dev/null

primary_sql "DROP TABLE IF EXISTS public.hivemind_pitr_canary; CREATE TABLE public.hivemind_pitr_canary (marker text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now()); INSERT INTO public.hivemind_pitr_canary(marker) VALUES ('baseline');" >/dev/null
docker exec -u postgres "$POSTGRES_CONTAINER" hivemind-pgbackrest --stanza="$STANZA" backup --type=full >/dev/null
primary_sql "SELECT pg_create_restore_point('$RESTORE_POINT')" >/dev/null
primary_sql "INSERT INTO public.hivemind_pitr_canary(marker) VALUES ('after_target')" >/dev/null
target_wal="$(primary_sql 'SELECT pg_walfile_name(pg_switch_wal())')"
archived=0
for _ in $(seq 1 60); do
  if [[ "$(primary_sql "SELECT (last_archived_wal = '$target_wal')::int FROM pg_stat_archiver")" == 1 ]]; then
    archived=1
    break
  fi
  sleep 1
done
[[ "$archived" == 1 ]] || { echo "target WAL was not archived within 60 seconds" >&2; exit 1; }
docker exec -u postgres "$POSTGRES_CONTAINER" hivemind-pgbackrest --stanza="$STANZA" check >/dev/null

uid="$(docker exec "$POSTGRES_CONTAINER" id -u postgres)"
gid="$(docker exec "$POSTGRES_CONTAINER" id -g postgres)"
docker volume create "$DRILL_VOLUME" >/dev/null
docker run --rm -e PG_UID="$uid" -e PG_GID="$gid" -v "$DRILL_VOLUME:/restore" alpine:3.20 \
  sh -eu -c 'chown -R "$PG_UID:$PG_GID" /restore; chmod 700 /restore'
docker run --rm -u postgres \
  -v "$REPO_VOLUME:/var/lib/pgbackrest:ro" \
  -v "$SECRET_VOLUME:/run/secrets/hivemind-pitr:ro" \
  -v "$DRILL_VOLUME:/var/lib/postgresql/data" \
  --entrypoint /usr/local/bin/hivemind-pgbackrest "$IMAGE" \
  --stanza="$STANZA" restore \
  --type=name --target="$RESTORE_POINT" --target-action=promote >/dev/null

docker run -d --name "$DRILL_CONTAINER" \
  -e POSTGRES_USER="$PG_USER" -e POSTGRES_DB="$PG_DB" \
  -v "$DRILL_VOLUME:/var/lib/postgresql/data" \
  -v "$REPO_VOLUME:/var/lib/pgbackrest:ro" \
  -v "$SECRET_VOLUME:/run/secrets/hivemind-pitr:ro" \
  --entrypoint sh "$IMAGE" -eu -c '
    export PGBACKREST_REPO1_CIPHER_PASS="$(cat /run/secrets/hivemind-pitr/repo-pass)"
    export PGUSER="$POSTGRES_USER" PGDATABASE="$POSTGRES_DB"
    exec docker-entrypoint.sh postgres -c listen_addresses="" -c archive_mode=off -c shared_preload_libraries=age
  ' >/dev/null
for _ in $(seq 1 60); do
  docker exec "$DRILL_CONTAINER" sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1 && break
  sleep 1
done
if ! docker exec "$DRILL_CONTAINER" sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null; then
  docker logs "$DRILL_CONTAINER" >&2 || true
  exit 1
fi
baseline="$(docker exec "$DRILL_CONTAINER" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM public.hivemind_pitr_canary WHERE marker='"'"'baseline'"'"'"')"
after="$(docker exec "$DRILL_CONTAINER" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM public.hivemind_pitr_canary WHERE marker='"'"'after_target'"'"'"')"
[[ "$baseline" == 1 && "$after" == 0 ]] || { echo "PITR assertion failed baseline=$baseline after_target=$after" >&2; exit 1; }

mkdir -p "$RECEIPT_DIR"
chmod 700 "$RECEIPT_DIR"
tmp="$RECEIPT_DIR/.${STAMP}.json.tmp"
printf '{"schema_version":1,"status":"pass","completed_at":"%s","restore_target":"name","baseline_rows":1,"post_target_rows":0,"image":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$IMAGE" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$RECEIPT_DIR/$STAMP.json"
echo "PITR restore drill passed: $RECEIPT_DIR/$STAMP.json"
