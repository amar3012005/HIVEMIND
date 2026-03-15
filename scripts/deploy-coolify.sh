#!/bin/bash
# =============================================================================
# HIVE-MIND Coolify Deployment Script
# EU Sovereign Cloud Deployment Automation
# =============================================================================
# Usage: ./scripts/deploy-coolify.sh [environment]
#   environment: staging|production (default: production)
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENVIRONMENT="${1:-production}"
VERSION="${VERSION:-$(date +%Y%m%d-%H%M%S)}"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# =============================================================================
# Pre-flight Checks
# =============================================================================
log_info "Starting HIVE-MIND deployment to Coolify (${ENVIRONMENT})..."
log_info "Version: ${VERSION}, Build Date: ${BUILD_DATE}"

# Check if required commands exist
command -v docker >/dev/null 2>&1 || { log_error "Docker is required but not installed."; exit 1; }
command -v git >/dev/null 2>&1 || { log_error "Git is required but not installed."; exit 1; }

# Check if .env.coolify exists
if [[ ! -f "${PROJECT_ROOT}/.env.coolify" ]]; then
    log_error ".env.coolify not found. Please create it from .env.coolify.example"
    exit 1
fi

# Load environment variables
set -a
source "${PROJECT_ROOT}/.env.coolify"
set +a

# Validate required environment variables
REQUIRED_VARS=(
    "GROQ_API_KEY"
    "MISTRAL_API_KEY"
    "DATABASE_URL"
    "QDRANT_URL"
    "API_MASTER_KEY"
    "SESSION_SECRET"
)

for var in "${REQUIRED_VARS[@]}"; do
    if [[ -z "${!var:-}" ]]; then
        log_error "Required environment variable ${var} is not set"
        exit 1
    fi
done

log_success "Pre-flight checks passed"

# =============================================================================
# Build Phase
# =============================================================================
log_info "Building Docker image..."

cd "${PROJECT_ROOT}"

# Build with proper tags
DOCKER_IMAGE="hivemind/core:${VERSION}"
DOCKER_LATEST="hivemind/core:latest"

docker build \
    -f Dockerfile.production \
    -t "${DOCKER_IMAGE}" \
    -t "${DOCKER_LATEST}" \
    --build-arg NODE_ENV=production \
    --build-arg VERSION="${VERSION}" \
    --build-arg BUILD_DATE="${BUILD_DATE}" \
    .

log_success "Docker image built: ${DOCKER_IMAGE}"

# =============================================================================
# Security Scan Phase
# =============================================================================
log_info "Running security scan with Trivy..."

if command -v trivy >/dev/null 2>&1; then
    trivy image \
        --severity HIGH,CRITICAL \
        --exit-code 0 \
        --format table \
        "${DOCKER_IMAGE}" || log_warning "Trivy scan completed with warnings"
    
    log_success "Security scan completed"
else
    log_warning "Trivy not installed, skipping security scan"
fi

# =============================================================================
# Test Phase
# =============================================================================
log_info "Running health check tests..."

# Start container for testing
docker run -d \
    --name hivemind-test-${VERSION} \
    -p 3001:3000 \
    -e NODE_ENV=production \
    -e PORT=3000 \
    -e DATABASE_URL="${DATABASE_URL}" \
    -e QDRANT_URL="${QDRANT_URL}" \
    -e QDRANT_API_KEY="${QDRANT_API_KEY}" \
    -e GROQ_API_KEY="${GROQ_API_KEY}" \
    -e API_MASTER_KEY="${API_MASTER_KEY}" \
    -e SESSION_SECRET="${SESSION_SECRET}" \
    "${DOCKER_IMAGE}"

# Wait for container to start
log_info "Waiting for container to start..."
sleep 10

# Health check
HEALTH_CHECK_URL="http://localhost:3001/health"
MAX_RETRIES=30
RETRY_COUNT=0

while [[ $RETRY_COUNT -lt $MAX_RETRIES ]]; do
    if curl -sf "${HEALTH_CHECK_URL}" >/dev/null 2>&1; then
        log_success "Health check passed"
        break
    fi
    
    RETRY_COUNT=$((RETRY_COUNT + 1))
    log_info "Health check attempt ${RETRY_COUNT}/${MAX_RETRIES}..."
    sleep 2
done

if [[ $RETRY_COUNT -eq $MAX_RETRIES ]]; then
    log_error "Health check failed after ${MAX_RETRIES} attempts"
    docker logs hivemind-test-${VERSION} || true
    docker rm -f hivemind-test-${VERSION} || true
    exit 1
fi

# Cleanup test container
docker rm -f hivemind-test-${VERSION} || true
log_success "Tests passed"

# =============================================================================
# Push Phase (if registry is configured)
# =============================================================================
if [[ -n "${COOLIFY_REGISTRY:-}" ]]; then
    log_info "Pushing to registry..."
    
    docker tag "${DOCKER_IMAGE}" "${COOLIFY_REGISTRY}/hivemind/core:${VERSION}"
    docker tag "${DOCKER_LATEST}" "${COOLIFY_REGISTRY}/hivemind/core:latest"
    
    docker push "${COOLIFY_REGISTRY}/hivemind/core:${VERSION}"
    docker push "${COOLIFY_REGISTRY}/hivemind/core:latest"
    
    log_success "Images pushed to registry"
else
    log_warning "COOLIFY_REGISTRY not set, skipping push"
fi

# =============================================================================
# Deploy Phase
# =============================================================================
log_info "Preparing deployment..."

# Create deployment archive
DEPLOY_DIR="${PROJECT_ROOT}/deploy"
mkdir -p "${DEPLOY_DIR}"

cat > "${DEPLOY_DIR}/docker-compose.coolify.yml" << EOF
# Auto-generated Coolify deployment file
# Version: ${VERSION}
# Build Date: ${BUILD_DATE}

version: '3.8'

services:
  app:
    image: ${DOCKER_IMAGE}
    environment:
      - NODE_ENV=production
      - VERSION=${VERSION}
      - DATABASE_URL=${DATABASE_URL}
      - QDRANT_URL=${QDRANT_URL}
      - QDRANT_API_KEY=${QDRANT_API_KEY}
      - REDIS_URL=${REDIS_URL}
      - GROQ_API_KEY=${GROQ_API_KEY}
      - MISTRAL_API_KEY=${MISTRAL_API_KEY}
      - API_MASTER_KEY=${API_MASTER_KEY}
      - SESSION_SECRET=${SESSION_SECRET}
      - HIVEMIND_MASTER_API_KEY=${HIVEMIND_MASTER_API_KEY}
      - HIVEMIND_ADMIN_SECRET=${HIVEMIND_ADMIN_SECRET}
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
EOF

log_success "Deployment file created: ${DEPLOY_DIR}/docker-compose.coolify.yml"

# =============================================================================
# Coolify API Deployment (if configured)
# =============================================================================
if [[ -n "${COOLIFY_API_TOKEN:-}" && -n "${COOLIFY_API_URL:-}" && -n "${COOLIFY_PROJECT_UUID:-}" ]]; then
    log_info "Triggering Coolify deployment via API..."
    
    curl -X POST "${COOLIFY_API_URL}/api/v1/applications/${COOLIFY_PROJECT_UUID}/deploy" \
        -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{
            \"version\": \"${VERSION}\",
            \"environment\": \"${ENVIRONMENT}\"
        }" || log_warning "Coolify API call failed, manual deployment may be required"
    
    log_success "Coolify deployment triggered"
else
    log_info "Coolify API not configured. Manual deployment steps:"
    log_info "1. Log in to your Coolify dashboard"
    log_info "2. Create a new application or select existing"
    log_info "3. Use the following configuration:"
    log_info "   - Build Command: docker build -f Dockerfile.production -t hivemind ."
    log_info "   - Port: 3000"
    log_info "   - Health Check: /health"
    log_info "4. Upload .env.coolify as environment variables"
fi

# =============================================================================
# Post-Deployment Verification
# =============================================================================
log_info "Deployment preparation complete!"
log_info ""
log_info "Next steps:"
log_info "1. Verify deployment in Coolify dashboard"
log_info "2. Check health endpoint: https://${COOLIFY_DOMAIN:-your-domain}/health"
log_info "3. Run database migrations if needed"
log_info "4. Verify SSL certificate is provisioned"
log_info ""
log_success "HIVE-MIND ${VERSION} ready for deployment!"

# Create deployment marker
echo "${VERSION}" > "${PROJECT_ROOT}/.deployment-version"
echo "${BUILD_DATE}" > "${PROJECT_ROOT}/.deployment-date"
