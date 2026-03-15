#!/bin/bash
# HIVE-MIND - Docker Stack Validation Script
# Usage: ./scripts/validate-docker.sh

set -e

echo "🐳 HIVE-MIND - Docker Stack Validation"
echo "======================================"
echo ""

cd /Users/amar/HIVE-MIND

# ==========================================
# Step 1: Validate Docker Compose Syntax
# ==========================================
echo "1️⃣  Validating Docker Compose syntax..."
docker compose -f docker-compose.local-stack.yml config > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "   ✅ Docker Compose configuration is valid"
else
    echo "   ❌ Docker Compose validation failed"
    exit 1
fi
echo ""

# ==========================================
# Step 2: Check Required Images
# ==========================================
echo "2️⃣  Checking required Docker images..."
REQUIRED_IMAGES=("postgres:15-alpine" "qdrant/qdrant:v1.12.0")
for image in "${REQUIRED_IMAGES[@]}"; do
    if docker image inspect "$image" > /dev/null 2>&1; then
        echo "   ✅ $image available"
    else
        echo "   ⚠️  $image not found (will be pulled)"
    fi
done
echo ""

# ==========================================
# Step 3: Start Stack
# ==========================================
echo "3️⃣  Starting Docker stack..."
docker compose -f docker-compose.local-stack.yml up -d
sleep 15
echo ""

# ==========================================
# Step 4: Check Container Health
# ==========================================
echo "4️⃣  Checking container health..."
echo ""
docker compose -f docker-compose.local-stack.yml ps
echo ""

# ==========================================
# Step 5: Health Check - PostgreSQL
# ==========================================
echo "5️⃣  Testing PostgreSQL health..."
if docker exec hivemind-postgres pg_isready -U hivemind > /dev/null 2>&1; then
    echo "   ✅ PostgreSQL is healthy"
else
    echo "   ❌ PostgreSQL health check failed"
    docker logs hivemind-postgres | tail -20
fi
echo ""

# ==========================================
# Step 6: Health Check - Qdrant
# ==========================================
echo "6️⃣  Testing Qdrant health..."
if curl -s http://localhost:9200/ > /dev/null 2>&1; then
    echo "   ✅ Qdrant is healthy"
    curl -s http://localhost:9200/ | head -1
else
    echo "   ❌ Qdrant health check failed"
    docker logs hivemind-qdrant | tail -20
fi
echo ""

# ==========================================
# Step 7: Port Validation
# ==========================================
echo "7️⃣  Validating port mappings..."
echo "   PostgreSQL: $(docker port hivemind-postgres 2>/dev/null || echo 'Not mapped')"
echo "   Qdrant:     $(docker port hivemind-qdrant 2>/dev/null || echo 'Not mapped')"
echo ""

# ==========================================
# Summary
# ==========================================
echo "======================================"
echo "📊 Docker Stack Validation Summary"
echo "======================================"
echo ""
docker compose -f docker-compose.local-stack.yml ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "✅ Docker stack validation complete!"
echo ""
echo "Next steps:"
echo "  1. Review container status above"
echo "  2. Check logs if any container is unhealthy"
echo "  3. Proceed with application startup"
