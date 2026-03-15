#!/bin/bash
# HIVE-MIND - Start Complete Local Stack
# PostgreSQL + Apache AGE + Qdrant + Embedding Model
#
# Usage: ./scripts/start-local-stack.sh

set -e

echo "🚀 HIVE-MIND - Starting Complete Local Stack"
echo "============================================="
echo ""

cd /Users/amar/HIVE-MIND

# Step 1: Start all containers
echo "📦 Starting containers..."
docker-compose -f docker-compose.local-stack.yml up -d

# Step 2: Wait for services
echo ""
echo "⏳ Waiting for services to be ready..."
echo "   This may take 2-3 minutes for first run (model download)"
echo ""

# Wait for PostgreSQL
echo -n "   PostgreSQL: "
until docker exec hivemind-postgres pg_isready -U hivemind > /dev/null 2>&1; do
  echo -n "."
  sleep 2
done
echo "✅ Ready"

# Wait for Qdrant
echo -n "   Qdrant: "
until curl -s http://localhost:6333/ > /dev/null 2>&1; do
  echo -n "."
  sleep 2
done
echo "✅ Ready"

# Wait for Embedding model
echo -n "   Embedding Model: "
until curl -s http://localhost:3000/health > /dev/null 2>&1; do
  echo -n "."
  sleep 5
done
echo "✅ Ready"

echo ""
echo "✅ All services are running!"
echo ""

# Step 3: Show service status
echo "📊 Service Status:"
docker ps --filter "name=hivemind" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""

# Step 4: Setup Qdrant collection
echo "🔧 Setting up Qdrant collection..."
node scripts/setup-qdrant.js

echo ""
echo "✅ Local stack is ready!"
echo ""
echo "Access URLs:"
echo "  PostgreSQL:   localhost:5432 (hivemind/hivemind_dev_password)"
echo "  Qdrant:       http://localhost:6333"
echo "  Qdrant Dashboard: http://localhost:6333/dashboard"
echo "  Embedding API:  http://localhost:3000"
echo "  pgAdmin:      http://localhost:5050 (admin@hivemind.local / admin_password)"
echo ""
echo "Next steps:"
echo "  1. Test embedding: curl http://localhost:3000/embed -d '{\"inputs\":[\"test\"]}' -H 'Content-Type: application/json'"
echo "  2. Test Qdrant: curl http://localhost:6333/collections"
echo "  3. Run HIVE-MIND server: cd core && node src/server.js"
echo ""
echo "To stop:"
echo "  docker-compose -f docker-compose.local-stack.yml down"
echo ""
