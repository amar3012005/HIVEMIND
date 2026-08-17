#!/usr/bin/env bash
# Managed PostgreSQL PITR operator. The repository is encrypted by pgBackRest;
# its cipher pass lives in a Docker volume mounted only into PostgreSQL.
set -euo pipefail

ACTION="${1:-status}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-hm-postgres}"
REPO_VOLUME="${PITR_REPO_VOLUME:-hivemind_postgres-pitr-repo}"
SECRET_VOLUME="${PITR_SECRET_VOLUME:-hivemind_postgres-pitr-secrets}"
STANZA="${PITR_STANZA:-hivemind}"

container_running() {
  [[ "$(docker inspect "$POSTGRES_CONTAINER" --format '{{.State.Running}}' 2>/dev/null || true)" == true ]]
}

as_postgres() {
  docker exec -u postgres "$POSTGRES_CONTAINER" hivemind-pgbackrest --stanza="$STANZA" "$@"
}

init_repository() {
  container_running || { echo "PostgreSQL container is not running" >&2; exit 2; }
  local uid gid
  uid="$(docker exec "$POSTGRES_CONTAINER" id -u postgres)"
  gid="$(docker exec "$POSTGRES_CONTAINER" id -g postgres)"
  docker volume create "$REPO_VOLUME" >/dev/null
  docker volume create "$SECRET_VOLUME" >/dev/null
  docker run --rm -e PG_UID="$uid" -e PG_GID="$gid" \
    -v "$REPO_VOLUME:/repo" -v "$SECRET_VOLUME:/secret" alpine:3.20 sh -eu -c '
      mkdir -p /repo /secret
      if [ ! -s /secret/repo-pass ]; then
        umask 077
        head -c 48 /dev/urandom | base64 > /secret/repo-pass
      fi
      chown -R "$PG_UID:$PG_GID" /repo /secret
      chmod 700 /repo /secret
      chmod 600 /secret/repo-pass
    '
  as_postgres stanza-create
  as_postgres info --output=json >/dev/null
}

case "$ACTION" in
  init)
    init_repository
    ;;
  check)
    container_running || { echo "PostgreSQL container is not running" >&2; exit 2; }
    as_postgres check
    ;;
  full|diff|incr)
    container_running || { echo "PostgreSQL container is not running" >&2; exit 2; }
    as_postgres backup --type="$ACTION"
    ;;
  status)
    container_running || { echo "PostgreSQL container is not running" >&2; exit 2; }
    archive_mode="$(docker exec "$POSTGRES_CONTAINER" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "show archive_mode"')"
    archive_command="$(docker exec "$POSTGRES_CONTAINER" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "show archive_command"')"
    printf 'archive_mode=%s\n' "$archive_mode"
    [[ "$archive_command" == *hivemind-pgbackrest* ]] && printf 'archive_command=pgbackrest\n' || printf 'archive_command=unexpected\n'
    as_postgres info --output=json
    ;;
  *)
    echo "usage: $0 {init|check|full|diff|incr|status}" >&2
    exit 2
    ;;
esac
