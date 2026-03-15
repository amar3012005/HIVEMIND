#!/bin/bash
# =============================================================================
# HIVE-MIND Coolify Configuration Validator
# Validates all configuration files before deployment
# =============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Counters
ERRORS=0
WARNINGS=0

# Logging
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; ((WARNINGS++)) || true; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; ((ERRORS++)) || true; }

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

log_info "=========================================="
log_info "HIVE-MIND Coolify Configuration Validator"
log_info "=========================================="
echo ""

# ============================================================================
# Check Required Files
# ============================================================================
log_info "Checking required files..."

REQUIRED_FILES=(
    "coolify.yaml"
    ".env.coolify"
    "docker-compose.coolify.yml"
    "Dockerfile.production"
    "docs/coolify-deployment.md"
    "scripts/deploy-coolify.sh"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [[ -f "${PROJECT_ROOT}/${file}" ]]; then
        log_success "Found ${file}"
    else
        log_error "Missing ${file}"
    fi
done

echo ""

# ============================================================================
# Validate coolify.yaml
# ============================================================================
log_info "Validating coolify.yaml..."

if [[ -f "${PROJECT_ROOT}/coolify.yaml" ]]; then
    # Check YAML syntax
    if command -v yamllint >/dev/null 2>&1; then
        if yamllint -d relaxed "${PROJECT_ROOT}/coolify.yaml" 2>/dev/null; then
            log_success "coolify.yaml syntax is valid"
        else
            log_warning "coolify.yaml has YAML syntax issues"
        fi
    else
        log_info "yamllint not installed, skipping YAML syntax check"
    fi
    
    # Check for required sections
    if grep -q "services:" "${PROJECT_ROOT}/coolify.yaml"; then
        log_success "coolify.yaml has services section"
    else
        log_error "coolify.yaml missing services section"
    fi
    
    if grep -q "healthcheck:" "${PROJECT_ROOT}/coolify.yaml"; then
        log_success "coolify.yaml has healthcheck configuration"
    else
        log_error "coolify.yaml missing healthcheck configuration"
    fi
    
    if grep -q "security_opt:" "${PROJECT_ROOT}/coolify.yaml"; then
        log_success "coolify.yaml has security options"
    else
        log_warning "coolify.yaml missing security options"
    fi
else
    log_error "coolify.yaml not found"
fi

echo ""

# ============================================================================
# Validate docker-compose.coolify.yml
# ============================================================================
log_info "Validating docker-compose.coolify.yml..."

if [[ -f "${PROJECT_ROOT}/docker-compose.coolify.yml" ]]; then
    # Check Docker Compose syntax
    if docker-compose -f "${PROJECT_ROOT}/docker-compose.coolify.yml" config >/dev/null 2>&1; then
        log_success "docker-compose.coolify.yml syntax is valid"
    else
        log_error "docker-compose.coolify.yml has syntax errors"
    fi
    
    # Check for app service
    if docker-compose -f "${PROJECT_ROOT}/docker-compose.coolify.yml" config 2>/dev/null | grep -q "app:"; then
        log_success "docker-compose.coolify.yml has app service"
    else
        log_error "docker-compose.coolify.yml missing app service"
    fi
else
    log_error "docker-compose.coolify.yml not found"
fi

echo ""

# ============================================================================
# Validate Dockerfile.production
# ============================================================================
log_info "Validating Dockerfile.production..."

if [[ -f "${PROJECT_ROOT}/Dockerfile.production" ]]; then
    # Check for multi-stage build
    if grep -q "FROM.*AS" "${PROJECT_ROOT}/Dockerfile.production"; then
        log_success "Dockerfile uses multi-stage build"
    else
        log_warning "Dockerfile should use multi-stage build"
    fi
    
    # Check for non-root user
    if grep -q "USER" "${PROJECT_ROOT}/Dockerfile.production"; then
        log_success "Dockerfile sets non-root user"
    else
        log_warning "Dockerfile should set non-root user"
    fi
    
    # Check for health check
    if grep -q "HEALTHCHECK" "${PROJECT_ROOT}/Dockerfile.production"; then
        log_success "Dockerfile has HEALTHCHECK"
    else
        log_warning "Dockerfile should have HEALTHCHECK"
    fi
    
    # Validate Dockerfile syntax
    if docker build -f "${PROJECT_ROOT}/Dockerfile.production" --target base -t hivemind:validate . 2>/dev/null; then
        log_success "Dockerfile builds successfully"
        docker rmi hivemind:validate 2>/dev/null || true
    else
        log_error "Dockerfile has build errors"
    fi
else
    log_error "Dockerfile.production not found"
fi

echo ""

# ============================================================================
# Validate .env.coolify
# ============================================================================
log_info "Validating .env.coolify..."

if [[ -f "${PROJECT_ROOT}/.env.coolify" ]]; then
    # Check for required variables
    REQUIRED_VARS=(
        "NODE_ENV"
        "DATABASE_URL"
        "QDRANT_URL"
        "GROQ_API_KEY"
        "MISTRAL_API_KEY"
        "API_MASTER_KEY"
        "SESSION_SECRET"
    )
    
    for var in "${REQUIRED_VARS[@]}"; do
        if grep -q "^${var}=" "${PROJECT_ROOT}/.env.coolify"; then
            log_success ".env.coolify has ${var}"
        else
            log_error ".env.coolify missing ${var}"
        fi
    done
    
    # Check for EU sovereign settings
    if grep -q "GDPR_MODE=true" "${PROJECT_ROOT}/.env.coolify"; then
        log_success ".env.coolify has GDPR_MODE enabled"
    else
        log_warning ".env.coolify should have GDPR_MODE=true"
    fi
    
    if grep -q "DATA_RESIDENCY=EU" "${PROJECT_ROOT}/.env.coolify"; then
        log_success ".env.coolify has EU data residency"
    else
        log_warning ".env.coolify should have DATA_RESIDENCY=EU"
    fi
else
    log_error ".env.coolify not found"
fi

echo ""

# ============================================================================
# Validate Health Endpoint
# ============================================================================
log_info "Validating health endpoint..."

if [[ -f "${PROJECT_ROOT}/core/src/server.js" ]]; then
    if grep -q "pathname === '/health'" "${PROJECT_ROOT}/core/src/server.js"; then
        log_success "Health endpoint exists in server.js"
    else
        log_error "Health endpoint not found in server.js"
    fi
else
    log_warning "core/src/server.js not found, cannot verify health endpoint"
fi

echo ""

# ============================================================================
# Validate Scripts
# ============================================================================
log_info "Validating deployment scripts..."

if [[ -f "${PROJECT_ROOT}/scripts/deploy-coolify.sh" ]]; then
    if bash -n "${PROJECT_ROOT}/scripts/deploy-coolify.sh"; then
        log_success "deploy-coolify.sh syntax is valid"
    else
        log_error "deploy-coolify.sh has syntax errors"
    fi
    
    if [[ -x "${PROJECT_ROOT}/scripts/deploy-coolify.sh" ]]; then
        log_success "deploy-coolify.sh is executable"
    else
        log_warning "deploy-coolify.sh should be executable (chmod +x)"
    fi
else
    log_error "deploy-coolify.sh not found"
fi

echo ""

# ============================================================================
# Validate Documentation
# ============================================================================
log_info "Validating documentation..."

if [[ -f "${PROJECT_ROOT}/docs/coolify-deployment.md" ]]; then
    if grep -q "Coolify" "${PROJECT_ROOT}/docs/coolify-deployment.md"; then
        log_success "coolify-deployment.md mentions Coolify"
    else
        log_warning "coolify-deployment.md should mention Coolify"
    fi
    
    if grep -q "GDPR" "${PROJECT_ROOT}/docs/coolify-deployment.md"; then
        log_success "coolify-deployment.md mentions GDPR"
    else
        log_warning "coolify-deployment.md should mention GDPR"
    fi
else
    log_error "coolify-deployment.md not found"
fi

echo ""

# ============================================================================
# Check GitHub Actions Workflow
# ============================================================================
log_info "Checking GitHub Actions workflow..."

if [[ -f "${PROJECT_ROOT}/.github/workflows/coolify-deploy.yml" ]]; then
    if grep -q "Deploy to Coolify" "${PROJECT_ROOT}/.github/workflows/coolify-deploy.yml"; then
        log_success "GitHub Actions workflow for Coolify exists"
    else
        log_warning "GitHub Actions workflow should mention Coolify"
    fi
else
    log_warning ".github/workflows/coolify-deploy.yml not found"
fi

echo ""

# ============================================================================
# Summary
# ============================================================================
log_info "=========================================="
log_info "Validation Summary"
log_info "=========================================="

if [[ $ERRORS -eq 0 && $WARNINGS -eq 0 ]]; then
    log_success "All checks passed! Ready for Coolify deployment."
    exit 0
elif [[ $ERRORS -eq 0 ]]; then
    log_warning "All critical checks passed with ${WARNINGS} warnings."
    log_info "Review warnings before deploying to production."
    exit 0
else
    log_error "Validation failed with ${ERRORS} errors and ${WARNINGS} warnings."
    log_info "Fix errors before deploying."
    exit 1
fi
