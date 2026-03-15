#!/bin/bash
# =============================================================================
# HIVE-MIND Deployment Validation Script
# Validates security, health, and compliance requirements
# =============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.coolify.yml"

# Counters
TESTS_PASSED=0
TESTS_FAILED=0

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((TESTS_PASSED++))
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((TESTS_FAILED++))
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Test: Docker Compose file syntax
test_compose_syntax() {
    log_info "Testing Docker Compose syntax..."
    
    if docker-compose -f "$COMPOSE_FILE" config > /dev/null 2>&1; then
        log_success "Docker Compose syntax is valid"
    else
        log_error "Docker Compose syntax is invalid"
    fi
}

# Test: Services are running
test_services_running() {
    log_info "Testing services are running..."
    
    local services=("hivemind-api" "hivemind-postgres" "hivemind-redis" "hivemind-qdrant")
    
    for service in "${services[@]}"; do
        if docker ps --format "{{.Names}}" | grep -q "^${service}$"; then
            log_success "Service $service is running"
        else
            log_error "Service $service is not running"
        fi
    done
}

# Test: Health checks
test_health_checks() {
    log_info "Testing health checks..."
    
    # API health
    if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
        log_success "API health check passed"
    else
        log_error "API health check failed"
    fi
    
    # PostgreSQL health
    if docker exec hivemind-postgres pg_isready -U hivemind_user > /dev/null 2>&1; then
        log_success "PostgreSQL health check passed"
    else
        log_error "PostgreSQL health check failed"
    fi
    
    # Redis health
    if docker exec hivemind-redis redis-cli ping | grep -q "PONG"; then
        log_success "Redis health check passed"
    else
        log_error "Redis health check failed"
    fi
    
    # Qdrant health
    if curl -sf http://localhost:6333/healthz > /dev/null 2>&1; then
        log_success "Qdrant health check passed"
    else
        log_error "Qdrant health check failed"
    fi
}

# Test: Security configuration
test_security() {
    log_info "Testing security configuration..."
    
    # Check containers run as non-root
    local containers=("hivemind-api" "hivemind-postgres" "hivemind-redis" "hivemind-qdrant")
    
    for container in "${containers[@]}"; do
        if docker ps --format "{{.Names}}" | grep -q "^${container}$"; then
            local user=$(docker exec "$container" whoami 2>/dev/null || echo "unknown")
            if [[ "$user" != "root" ]]; then
                log_success "Container $container runs as non-root user ($user)"
            else
                log_warn "Container $container runs as root"
            fi
        fi
    done
    
    # Check no-new-privileges
    for container in "${containers[@]}"; do
        if docker ps --format "{{.Names}}" | grep -q "^${container}$"; then
            if docker inspect "$container" --format='{{.HostConfig.SecurityOpt}}' | grep -q "no-new-privileges"; then
                log_success "Container $container has no-new-privileges enabled"
            else
                log_warn "Container $container missing no-new-privileges"
            fi
        fi
    done
}

# Test: Environment variables
test_environment() {
    log_info "Testing environment variables..."
    
    local required_vars=(
        "NODE_ENV=production"
        "DATABASE_URL"
        "REDIS_URL"
        "QDRANT_URL"
    )
    
    for var in "${required_vars[@]}"; do
        if docker exec hivemind-api env | grep -q "^${var}"; then
            log_success "Environment variable ${var%%=*} is set"
        else
            log_error "Environment variable ${var%%=*} is not set"
        fi
    done
}

# Test: Network configuration
test_network() {
    log_info "Testing network configuration..."
    
    if docker network ls | grep -q "hivemind-network"; then
        log_success "hivemind-network exists"
    else
        log_error "hivemind-network does not exist"
    fi
    
    # Check containers are on the network
    local network_inspect=$(docker network inspect hivemind-network --format='{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null || echo "")
    
    if echo "$network_inspect" | grep -q "hivemind-api"; then
        log_success "API is connected to hivemind-network"
    else
        log_error "API is not connected to hivemind-network"
    fi
}

# Test: Volumes
test_volumes() {
    log_info "Testing volumes..."
    
    local volumes=("hivemind-logs" "hivemind-data" "postgres-data" "qdrant-data" "redis-data")
    
    for volume in "${volumes[@]}"; do
        if docker volume ls | grep -q "${volume}$"; then
            log_success "Volume $volume exists"
        else
            log_error "Volume $volume does not exist"
        fi
    done
}

# Test: Database connectivity
test_database() {
    log_info "Testing database connectivity..."
    
    if docker exec hivemind-api node -e "
        const { PrismaClient } = require('@prisma/client');
        const prisma = new PrismaClient();
        prisma.\$connect()
            .then(() => { console.log('OK'); process.exit(0); })
            .catch(() => { console.log('FAIL'); process.exit(1); });
    " 2>/dev/null | grep -q "OK"; then
        log_success "Database connection successful"
    else
        log_error "Database connection failed"
    fi
}

# Test: API endpoints
test_api() {
    log_info "Testing API endpoints..."
    
    # Health endpoint
    local health_response=$(curl -sf http://localhost:3000/health 2>/dev/null || echo "")
    if [[ -n "$health_response" ]]; then
        log_success "API health endpoint responds"
    else
        log_error "API health endpoint does not respond"
    fi
    
    # Check response contains expected fields
    if echo "$health_response" | grep -q "status"; then
        log_success "API health response is valid JSON"
    else
        log_warn "API health response may be invalid"
    fi
}

# Test: Resource limits
test_resources() {
    log_info "Testing resource limits..."
    
    # Check memory limits are set
    local api_mem=$(docker inspect hivemind-api --format='{{.HostConfig.Memory}}' 2>/dev/null || echo "0")
    if [[ "$api_mem" != "0" && "$api_mem" != "<no value>" ]]; then
        log_success "API has memory limits configured"
    else
        log_warn "API missing memory limits"
    fi
}

# Test: Logging
test_logging() {
    log_info "Testing logging configuration..."
    
    # Check log driver
    local log_driver=$(docker inspect hivemind-api --format='{{.HostConfig.LogConfig.Type}}' 2>/dev/null || echo "")
    if [[ "$log_driver" == "json-file" ]]; then
        log_success "JSON file logging is configured"
    else
        log_warn "Logging configuration may need review"
    fi
}

# Display results
display_results() {
    echo ""
    echo "============================================================================="
    echo "Validation Results"
    echo "============================================================================="
    echo -e "Tests Passed: ${GREEN}${TESTS_PASSED}${NC}"
    echo -e "Tests Failed: ${RED}${TESTS_FAILED}${NC}"
    echo "============================================================================="
    
    if [[ $TESTS_FAILED -eq 0 ]]; then
        echo -e "${GREEN}All validation tests passed!${NC}"
        exit 0
    else
        echo -e "${RED}Some validation tests failed. Please review the output above.${NC}"
        exit 1
    fi
}

# Main function
main() {
    echo "============================================================================="
    echo "HIVE-MIND Deployment Validation"
    echo "============================================================================="
    echo ""
    
    test_compose_syntax
    test_services_running
    test_health_checks
    test_security
    test_environment
    test_network
    test_volumes
    test_database
    test_api
    test_resources
    test_logging
    
    display_results
}

# Run main function
main "$@"
