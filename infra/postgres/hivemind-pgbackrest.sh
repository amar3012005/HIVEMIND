#!/bin/sh
set -eu

key_file="${PGBACKREST_CIPHER_FILE:-/run/secrets/hivemind-pitr/repo-pass}"
if [ ! -s "$key_file" ]; then
  echo "pgBackRest repository key is missing" >&2
  exit 2
fi

export PGBACKREST_REPO1_CIPHER_PASS="$(cat "$key_file")"
# The official image permits a non-default POSTGRES_USER. pgBackRest's local
# libpq probe otherwise assumes a database role named after the OS user
# (`postgres`), which does not exist when the cluster was initialized with a
# custom owner such as `hivemind_user`.
export PGUSER="${PGUSER:-${POSTGRES_USER:-postgres}}"
export PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-postgres}}"
exec pgbackrest "$@"
