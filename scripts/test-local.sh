#!/bin/bash
# HIVE-MIND - Local Testing Script
# 
# Usage: ./scripts/test-local.sh

set -e

echo "🧪 HIVE-MIND - Local Testing Script"
echo "===================================="
echo ""

# Load environment variables
if [ -f .env.test ]; then
    export $(cat .env.test | grep -v '^#' | xargs)
fi

# Step 1: Start PostgreSQL + AGE
echo "📦 Starting PostgreSQL with Apache AGE..."
docker-compose -f docker-compose.test.yml up -d

# Step 2: Wait for database to be ready
echo "⏳ Waiting for database to be ready..."
sleep 10

# Step 3: Check database health
echo "🏥 Checking database health..."
docker exec hivemind-postgres pg_isready -U hivemind || {
    echo "❌ Database is not ready"
    exit 1
}

# Step 4: Verify Apache AGE extension
echo "🔍 Verifying Apache AGE extension..."
docker exec hivemind-postgres psql -U hivemind -d hivemind -c "LOAD 'age';" || {
    echo "❌ Apache AGE extension not loaded"
    exit 1
}

# Step 5: Run memory engine tests
echo "🧪 Running memory engine tests..."
cd /Users/amar/HIVE-MIND
node tests/test-memory-engine.js

# Step 6: Print summary
echo ""
echo "✅ Local testing complete!"
echo ""
echo "Next steps:"
echo "  1. Check test results above"
echo "  2. Access server at http://localhost:3000"
echo "  3. Test API: curl http://localhost:3000/api/memories"
echo ""
echo "To stop database:"
echo "  docker-compose -f docker-compose.test.yml down"
echo ""
