#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
container=${NEXT_POSTGRES_CONTAINER:-hivemind-next-postgres-next-1}
db_user=$(docker exec "$container" printenv POSTGRES_USER)
db_name=$(docker exec "$container" printenv POSTGRES_DB)

migrations=(
  20260709211000_add_memory_storage_mode
  20260710120000_referral_entitlements_cumulative_usage
  20260710153000_agent_usage_quotas
  20260710154000_provider_neutral_checkout
)

docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" <<'SQL'
CREATE TABLE IF NOT EXISTS hivemind.vnext_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

for migration in "${migrations[@]}"; do
  applied=$(docker exec "$container" psql -U "$db_user" -d "$db_name" -Atc \
    "SELECT 1 FROM hivemind.vnext_migrations WHERE name = '$migration'")
  if [[ "$applied" == "1" ]]; then
    printf 'skip %s\n' "$migration"
    continue
  fi

  {
    printf 'BEGIN;\n'
    cat "$repo_root/core/prisma/migrations/$migration/migration.sql"
    printf "\nINSERT INTO hivemind.vnext_migrations (name) VALUES ('%s');\nCOMMIT;\n" "$migration"
  } | docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name"
  printf 'applied %s\n' "$migration"
done
