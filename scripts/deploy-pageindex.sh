#!/bin/bash
# PageIndex Deployment Script
# Run this to deploy the PageIndex hierarchical memory index

set -e

echo "=========================================="
echo "PageIndex Deployment Script"
echo "=========================================="

cd /opt/HIVEMIND/core

# Step 1: Check database connection
echo ""
echo "Step 1: Checking database connection..."
if npx prisma db pull --force-exit 2>&1 | grep -q "error"; then
  echo "WARNING: Database connection failed. Please check DATABASE_URL in .env"
  echo "Current DATABASE_URL: $(grep DATABASE_URL .env | cut -d'=' -f2)"
  echo ""
  echo "To fix:"
  echo "  1. Update DATABASE_URL in /opt/HIVEMIND/core/.env"
  echo "  2. Ensure PostgreSQL is running and accessible"
  exit 1
fi
echo "✓ Database connection successful"

# Step 2: Generate Prisma client
echo ""
echo "Step 2: Generating Prisma client..."
npx prisma generate
echo "✓ Prisma client generated"

# Step 3: Run migration
echo ""
echo "Step 3: Running PageIndex migration..."
npx prisma migrate deploy --name add_pageindex_nodes
echo "✓ Migration completed"

# Step 4: Run backfill (optional)
echo ""
echo "Step 4: Running backfill for existing memories..."
echo "This may take a while depending on the number of memories."
echo "Press Ctrl+C to skip, or wait for completion..."

node core/scripts/pageindex-backfill.js --concurrency=10 || {
  echo ""
  echo "WARNING: Backfill failed or was interrupted."
  echo "You can run it later with:"
  echo "  node core/scripts/pageindex-backfill.js"
}

# Step 5: Restart server
echo ""
echo "Step 5: Restarting HIVEMIND server..."
# Find and restart the server process (adjust based on your setup)
if command -v pm2 &> /dev/null; then
  pm2 restart hivemind-core || true
elif systemctl is-active --quiet hivemind-core 2>/dev/null; then
  systemctl restart hivemind-core
else
  echo "NOTE: Server restart skipped. Restart manually if running."
fi

echo ""
echo "=========================================="
echo "PageIndex Deployment Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Test search: curl -X POST http://localhost:8050/api/search/pageindex -H 'Content-Type: application/json' -d '{\"query\":\"test\",\"limit\":10}'"
echo "  2. View tree: curl http://localhost:8050/api/pageindex/tree"
echo "  3. Check frontend: Open HIVEMIND dashboard and navigate to Memory Graph"
echo ""
echo "PageIndex features:"
echo "  - Hierarchical memory organization (max 4 levels)"
echo "  - Auto-classification during ingestion"
echo "  - Hybrid search (PageIndex + VectorDB)"
echo "  - Auto-evolution via CSI agent (runs every 6 hours)"
echo ""
