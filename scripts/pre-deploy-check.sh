#!/bin/bash
# Pre-deployment verification for Frontend (Da-vinci) and Backend (core)
# Run this before pushing to git to catch build errors early

set -e

echo "🔍 Pre-Deployment Verification Check"
echo "======================================"

FRONTEND_DIR="/opt/HIVEMIND/frontend/Da-vinci"
CORE_DIR="/opt/HIVEMIND/core"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check frontend build
echo ""
echo -e "${YELLOW}1. Testing Frontend Build...${NC}"
cd "$FRONTEND_DIR"

if npm run build > /tmp/frontend-build.log 2>&1; then
  echo -e "${GREEN}✓ Frontend build successful${NC}"
  BUILD_SIZE=$(du -sh build | cut -f1)
  echo "  Build size: $BUILD_SIZE"
else
  echo -e "${RED}✗ Frontend build failed${NC}"
  echo "  Error log:"
  tail -30 /tmp/frontend-build.log
  exit 1
fi

# Check for TypeScript errors
echo ""
echo -e "${YELLOW}2. Running TypeScript type check...${NC}"
if npm run type-check 2>&1 | grep -i error; then
  echo -e "${RED}✗ TypeScript errors found${NC}"
  exit 1
else
  echo -e "${GREEN}✓ No TypeScript errors${NC}"
fi

# Verify git status
echo ""
echo -e "${YELLOW}3. Checking Git Status...${NC}"
cd /opt/HIVEMIND

UNCOMMITTED=$(git status --porcelain | grep -v "^??" | wc -l)
if [ $UNCOMMITTED -gt 0 ]; then
  echo -e "${YELLOW}⚠ Uncommitted changes:${NC}"
  git status --short | grep -v "^??"
else
  echo -e "${GREEN}✓ All changes committed${NC}"
fi

# Summary
echo ""
echo "======================================"
echo -e "${GREEN}✓ Pre-deployment check passed!${NC}"
echo ""
echo "Next steps:"
echo "  1. Push to git: git push"
echo "  2. Monitor Vercel deployment:"
echo "     https://vercel.com/dashboard"
echo ""
