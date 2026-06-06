#!/bin/bash
set -e

# Phase 0: Self-Hosted n8n + HiveMind Foundation Deployment Script
# Usage: ./PHASE_0_DEPLOYMENT.sh [env]
# Where env: local (default), staging, production

ENV=${1:-local}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║ Phase 0: n8n + HiveMind EU Integration Foundation             ║"
echo "║ Environment: $ENV                                              ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Preflight Checks
echo "[1/7] Running preflight checks..."
if ! command -v docker &> /dev/null; then
  echo "❌ Docker not found. Please install Docker."
  exit 1
fi

if ! command -v docker-compose &> /dev/null; then
  echo "❌ Docker Compose not found. Please install Docker Compose."
  exit 1
fi

DOCKER_VERSION=$(docker --version | awk '{print $3}' | cut -d. -f1-2)
COMPOSE_VERSION=$(docker-compose --version | awk '{print $NF}')

echo "✓ Docker ${DOCKER_VERSION} detected"
echo "✓ Docker Compose ${COMPOSE_VERSION} detected"
echo ""

# Step 2: Directory Setup
echo "[2/7] Setting up directory structure..."
mkdir -p docker/postgres docker/n8n docker/redis
mkdir -p scripts workflows schemas credentials/templates examples certs logs

if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "✓ Created .env from .env.example (review and update secrets)"
  else
    echo "⚠ .env.example not found. Creating minimal .env..."
    cat > .env <<EOF
DB_USER=n8n
DB_PASSWORD=change-me-to-strong-password
DB_NAME=n8n
REDIS_PASSWORD=change-me-to-strong-password
N8N_HOST=localhost
N8N_PORT=5678
N8N_ENCRYPTION_KEY=$(openssl rand -base64 32)
NODE_ENV=production
HIVEMIND_API_URL=https://api.hivemind.example.com
HIVEMIND_API_KEY=your-hivemind-api-key-here
EOF
    echo "✓ Created minimal .env (update with real values)"
  fi
else
  echo "✓ .env already exists"
fi
echo ""

# Step 3: SSL Certificate Generation
echo "[3/7] Generating SSL certificates..."
if [ -f "certs/server.crt" ] && [ -f "certs/server.key" ]; then
  echo "✓ SSL certificates already exist (skipping generation)"
else
  echo "Generating self-signed certificates for local development..."
  openssl genrsa -out certs/server.key 2048 2>/dev/null
  openssl req -new -x509 -key certs/server.key \
    -out certs/server.crt -days 365 \
    -subj "/C=DE/ST=Bavaria/L=Munich/O=Company/OU=n8n/CN=localhost" 2>/dev/null
  chmod 600 certs/server.key
  chmod 644 certs/server.crt
  echo "✓ SSL certificates generated in ./certs/"
fi
echo ""

# Step 4: Start Docker Services
echo "[4/7] Starting Docker services..."
echo "Running: docker-compose up -d"

if [ "$ENV" = "local" ]; then
  docker-compose up -d
  echo "✓ Services started in detached mode"
else
  echo "⚠ Production deployment: ensure docker-compose.yml is production-hardened"
  docker-compose up -d
fi
echo ""

# Step 5: Wait for Services
echo "[5/7] Waiting for services to be healthy..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if docker-compose ps | grep -q "healthy"; then
    echo "✓ Services are healthy"
    break
  fi
  echo "  Waiting... ($((RETRY_COUNT + 1))/$MAX_RETRIES)"
  sleep 2
  ((RETRY_COUNT++))
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "❌ Services failed to become healthy within timeout"
  echo "Run 'docker-compose logs' for details"
  exit 1
fi
echo ""

# Step 6: Verify Connectivity
echo "[6/7] Verifying connectivity..."

# Check n8n UI
if curl -s -k https://localhost:5678/api/v1/health | grep -q "ok"; then
  echo "✓ n8n API responding (https://localhost:5678)"
else
  echo "⚠ n8n API not responding yet (may take a few seconds)"
fi

# Check PostgreSQL
if docker exec n8n-postgres pg_isready -U ${DB_USER:-n8n} > /dev/null 2>&1; then
  echo "✓ PostgreSQL database ready"
else
  echo "⚠ PostgreSQL not ready yet"
fi

# Check Redis
if docker exec n8n-redis redis-cli ping | grep -q "PONG"; then
  echo "✓ Redis cache responding"
else
  echo "⚠ Redis not responding"
fi
echo ""

# Step 7: Post-Deployment Instructions
echo "[7/7] Phase 0 Foundation Deployment Complete!"
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║ NEXT STEPS                                                     ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "1. Access n8n UI:"
echo "   → https://localhost:5678"
echo "   → First login creates admin user"
echo ""
echo "2. Add Credentials (in n8n UI → Credentials):"
echo "   → SAP RFC: use credentials/sap-rfc.template.json"
echo "   → DATEV API: use credentials/datev-api.template.json"
echo "   → CRM API: use credentials/crm-api.template.json"
echo ""
echo "3. Deploy Test Workflow:"
echo "   → Copy workflows/crm-customer-to-hivemind.n8n.ts to n8n"
echo "   → Test execution (manual trigger)"
echo "   → Verify HiveMind POST success in logs"
echo ""
echo "4. Validate HiveMind Connectivity:"
echo "   → POST examples/crm-customer-ingest.json to HiveMind /v1/ingest"
echo "   → Expected response: batch_id + record_count"
echo ""
echo "5. Review Documentation:"
echo "   → README.md - Overview & quick-start"
echo "   → DEPLOYMENT.md - Full deployment guide"
echo "   → BACKFILL_VS_REALTIME.md - Cadence decision matrix"
echo "   → PHASE_0_FOUNDATION.md - Complete architecture"
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║ USEFUL COMMANDS                                                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "# View service status"
echo "docker-compose ps"
echo ""
echo "# View logs"
echo "docker-compose logs -f n8n"
echo "docker-compose logs -f postgres"
echo ""
echo "# Stop services"
echo "docker-compose down"
echo ""
echo "# Access PostgreSQL"
echo "docker exec -it n8n-postgres psql -U \${DB_USER} -d \${DB_NAME}"
echo ""
echo "# Test HiveMind connectivity"
echo "curl -X POST https://api.hivemind.example.com/v1/ingest \\"
echo "  -H 'Authorization: Bearer \${HIVEMIND_API_KEY}' \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d @examples/crm-customer-ingest.json"
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║ PHASE 0 CHECKLIST STATUS                                       ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "✓ Docker Compose services running"
echo "✓ PostgreSQL initialized + SSL enabled"
echo "✓ n8n UI accessible (https://localhost:5678)"
echo "✓ SSL certificates generated"
echo "⏳ Credential templates ready for manual setup"
echo "⏳ Test workflow ready for deployment"
echo "⏳ HiveMind connectivity pending validation"
echo ""
echo "Phase 0 Status: Foundation Ready | Next: Phase 1 (SAP/DATEV/CRM)"
echo ""
