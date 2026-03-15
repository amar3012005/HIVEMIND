#!/bin/bash
# ==========================================
# Install Apache AGE Extension
# Runs after PostgreSQL is ready
# ==========================================

set -e

echo "⏳ Waiting for PostgreSQL to be ready..."
until pg_isready -U "${POSTGRES_USER:-hivemind}" -d "${POSTGRES_DB:-hivemind}"; do
    sleep 1
done

echo "✅ PostgreSQL is ready"

# Install Apache AGE extension
psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-hivemind}" --dbname "${POSTGRES_DB:-hivemind}" <<EOF
CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';
SET search_path = ag_catalog, "\$user", public;
SELECT create_graph('hivemind_memory_graph');
EOF

echo "✅ Apache AGE extension installed and graph created"
