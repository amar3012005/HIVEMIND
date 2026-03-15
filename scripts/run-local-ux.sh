#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[1/3] Starting Docker local stack (API + Postgres + Qdrant + pgAdmin)..."
cd "$ROOT_DIR"
docker compose -f docker-compose.local-stack.yml up -d --build

echo "[2/3] Ensuring Qdrant collection setup..."
node "$ROOT_DIR/scripts/setup-qdrant.js" || true

echo "[3/3] Local stack ready."
echo "UX test page: http://localhost:3000/ux-test"
