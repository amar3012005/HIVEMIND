#!/bin/bash
# HIVE-MIND - One-Command Local Start
# Usage: ./scripts/start-local.sh

set -e

echo "🚀 HIVE-MIND - Starting Local Stack"
echo "===================================="
echo ""

cd /Users/amar/HIVE-MIND

# ==========================================
# Step 1: Check Prerequisites
# ==========================================
echo "1️⃣  Checking prerequisites..."

if ! command -v docker &> /dev/null; then
    echo "   ❌ Docker not found. Please install Docker Desktop."
    exit 1
fi
echo "   ✅ Docker: $(docker --version)"

if ! command -v node &> /dev/null; then
    echo "   ❌ Node.js not found. Please install Node.js v20+."
    exit 1
fi
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "   ❌ Node.js v$NODE_VERSION found. Need v20+."
    exit 1
fi
echo "   ✅ Node.js: v$(node --version)"

# ==========================================
# Step 2: Check Environment File
# ==========================================
echo ""
echo "2️⃣  Checking environment..."

if [ ! -f .env ]; then
    echo "   ⚠️  .env file not found. Copy .env.example to .env and fill in API keys."
    echo "   Run: cp .env.example .env"
    exit 1
fi

# Check for placeholder values
if grep -q "your-groq-api-key-here" .env; then
    echo "   ⚠️  GROQ_API_KEY not configured in .env"
fi
if grep -q "your-mistral-api-key-here" .env; then
    echo "   ⚠️  MISTRAL_API_KEY not configured in .env"
fi
echo "   ✅ Environment file found"

# ==========================================
# Step 3: Start Docker Stack
# ==========================================
echo ""
echo "3️⃣  Starting Docker stack..."

docker compose -f docker-compose.local-stack.yml up -d

echo "   ⏳ Waiting for services to start (30 seconds)..."
sleep 30

# ==========================================
# Step 4: Verify Services
# ==========================================
echo ""
echo "4️⃣  Verifying services..."

# PostgreSQL
if docker exec hivemind-postgres pg_isready -U hivemind > /dev/null 2>&1; then
    echo "   ✅ PostgreSQL: healthy"
else
    echo "   ⚠️  PostgreSQL: starting..."
fi

# Qdrant
if curl -s http://localhost:9200/ > /dev/null 2>&1; then
    echo "   ✅ Qdrant: healthy"
else
    echo "   ⚠️  Qdrant: starting..."
fi

# ==========================================
# Step 5: Start API Server
# ==========================================
echo ""
echo "5️⃣  Starting API server..."

cd core

# Check if port 3000 is already in use
if lsof -i :3000 > /dev/null 2>&1; then
    echo "   ⚠️  Port 3000 already in use. Stopping existing process..."
    pkill -f "node src/server.js" || true
    sleep 2
fi

# Start server in background
echo "   🚀 Starting server..."
nohup npm run server > /tmp/hivemind-server.log 2>&1 &
SERVER_PID=$!
echo "   ✅ Server started (PID: $SERVER_PID)"

# Wait for server to be ready
echo "   ⏳ Waiting for server to start (10 seconds)..."
sleep 10

# ==========================================
# Step 6: Final Verification
# ==========================================
echo ""
echo "6️⃣  Final verification..."

if curl -s http://localhost:3000/api/stats > /dev/null 2>&1; then
    echo "   ✅ API server: responding"
else
    echo "   ⚠️  API server: starting... (check logs: /tmp/hivemind-server.log)"
fi

# ==========================================
# Summary
# ==========================================
echo ""
echo "===================================="
echo "🎉 HIVE-MIND is running!"
echo "===================================="
echo ""
echo "📊 Services:"
docker compose -f docker-compose.local-stack.yml ps --format "table {{.Name}}\t{{.Status}}"
echo ""
echo "🌐 Access Points:"
echo "   UI:          http://localhost:3000"
echo "   Qdrant:      http://localhost:9200"
echo "   pgAdmin:     http://localhost:5050"
echo "   PostgreSQL:  localhost:5432"
echo ""
echo "📝 Useful Commands:"
echo "   View logs:   docker compose logs -f"
echo "   Stop all:    docker compose down"
echo "   Server logs: tail -f /tmp/hivemind-server.log"
echo ""
echo "🧪 Run Tests:"
echo "   ./scripts/run-tests.sh"
echo ""
echo "🔒 Security Scan:"
echo "   ./scripts/scan-secrets.sh"
echo ""
