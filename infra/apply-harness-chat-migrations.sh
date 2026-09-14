#!/usr/bin/env bash
# Apply explicitly approved post-baseline Harness migrations.
#
# This database is schema-baselined; historical Prisma migrations intentionally
# cannot be replayed. Keep each migration transactional and record it in a
# separate Harness ledger so a retry is safe and observable.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container=${HIVE_POSTGRES_CONTAINER:-hivemind-postgres}
db_user=$(docker exec "$container" printenv POSTGRES_USER)
db_name=$(docker exec "$container" printenv POSTGRES_DB)

migrations=(
  20260914110000_connected_app_receipts
)

docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" <<'SQL'
CREATE SCHEMA IF NOT EXISTS hivemind;
CREATE TABLE IF NOT EXISTS hivemind.harness_chat_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

for migration in "${migrations[@]}"; do
  sql="$repo_root/core/prisma/migrations/$migration/migration.sql"
  [[ -f "$sql" ]] || { printf 'missing migration: %s\n' "$migration" >&2; exit 1; }
  applied=$(docker exec "$container" psql -U "$db_user" -d "$db_name" -Atc \
    "SELECT 1 FROM hivemind.harness_chat_migrations WHERE name = '$migration'")
  if [[ "$applied" == "1" ]]; then
    printf 'skip %s\n' "$migration"
    continue
  fi
  {
    printf 'BEGIN;\n'
    cat "$sql"
    printf "\nINSERT INTO hivemind.harness_chat_migrations (name) VALUES ('%s');\nCOMMIT;\n" "$migration"
  } | docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name"
  printf 'applied %s\n' "$migration"
done
