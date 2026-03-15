#!/bin/bash
# =============================================================================
# HIVE-MIND Coolify Deployment Script
# Production-ready deployment automation
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
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.coolify.yml"
ENV_FILE="$PROJECT_DIR/.env"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed"
        exit 1
    fi
    
    # Check Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        log_error "Docker Compose is not installed"
        exit 1
    fi
    
    # Check .env file
    if [[ ! -f "$ENV_FILE" ]]; then
        log_error ".env file not found. Copy .env.coolify.example to .env and configure it."
        exit 1
    fi
    
    log_success "Prerequisites check passed"
}

# Generate security keys if not present
generate_keys() {
    log_info "Checking security keys..."
    
    local keys_required=(
        "API_MASTER_KEY"
        "SESSION_SECRET"
        "HIVEMIND_MASTER_API_KEY"
        "HIVEMIND_ADMIN_SECRET"
        "REDIS_PASSWORD"
        "QDRANT_API_KEY"
        "BACKUP_ENCRYPTION_KEY"
    )
    
    local missing_keys=()
    
    for key in "${keys_required[@]}"; do
        if ! grep -q "^${key}=" "$ENV_FILE" || grep -q "^${key}=CHANGE_ME" "$ENV_FILE"; then
            missing_keys+=("$key")
        fi
    done
    
    if [[ ${#missing_keys[@]} -gt 0 ]]; then
        log_warn "Missing or placeholder keys detected: ${missing_keys[*]}"
        log_info "Generating new keys..."
        
        for key in "${missing_keys[@]}"; do
            if [[ "$key" == "BACKUP_ENCRYPTION_KEY" ]]; then
                new_key=$(openssl rand -base64 32)
            else
                new_key=$(openssl rand -hex 32)
            fi
            
            if grep -q "^${key}=" "$ENV_FILE"; then
                sed -i "s|^${key}=.*|${key}=${new_key}|" "$ENV_FILE"
            else
                echo "${key}=${new_key}" >> "$ENV_FILE"
            fi
            
            log_success "Generated ${key}"
        done
    else
        log_success "All security keys are configured"
    fi
}

# Build PostgreSQL image with AGE
build_postgres_image() {
    log_info "Building PostgreSQL image with Apache AGE..."
    
    cd "$PROJECT_DIR/infra/postgres"
    
    if docker build -t hivemind/postgres-age:15-alpine -f Dockerfile.age .; then
        log_success "PostgreSQL image built successfully"
    else
        log_error "Failed to build PostgreSQL image"
        exit 1
    fi
    
    cd "$PROJECT_DIR"
}

# Validate docker-compose file
validate_compose() {
    log_info "Validating docker-compose file..."
    
    if docker-compose -f "$COMPOSE_FILE" config > /dev/null 2>&1; then
        log_success "Docker Compose file is valid"
    else
        log_error "Docker Compose file validation failed"
        docker-compose -f "$COMPOSE_FILE" config
        exit 1
    fi
}

# Deploy services
deploy_services() {
    log_info "Deploying HIVE-MIND services..."
    
    cd "$PROJECT_DIR"
    
    # Pull latest images
    log_info "Pulling latest images..."
    docker-compose -f "$COMPOSE_FILE" pull
    
    # Build app image
    log_info "Building app image..."
    docker-compose -f "$COMPOSE_FILE" build app
    
    # Start services
    log_info "Starting services..."
    docker-compose -f "$COMPOSE_FILE" up -d
    
    log_success "Services deployed"
}

# Wait for services to be healthy
wait_for_healthy() {
    log_info "Waiting for services to be healthy..."
    
    local services=("postgres" "redis" "qdrant" "app")
    local max_attempts=30
    local attempt=1
    
    for service in "${services[@]}"; do
        log_info "Waiting for $service..."
        attempt=1
        
        while [[ $attempt -le $max_attempts ]]; do
            if docker-compose -f "$COMPOSE_FILE" ps "$service" | grep -q "healthy"; then
                log_success "$service is healthy"
                break
            fi
            
            if [[ $attempt -eq $max_attempts ]]; then
                log_error "$service failed to become healthy"
                docker-compose -f "$COMPOSE_FILE" logs "$service"
                exit 1
            fi
            
            sleep 5
            ((attempt++))
        done
    done
    
    log_success "All services are healthy"
}

# Run database migrations
run_migrations() {
    log_info "Running database migrations..."
    
    cd "$PROJECT_DIR"
    
    # Wait for postgres to be ready
    sleep 5
    
    # Run migrations
    if docker-compose -f "$COMPOSE_FILE" exec -T app npx prisma migrate deploy; then
        log_success "Database migrations completed"
    else
        log_error "Database migrations failed"
        exit 1
    fi
}

# Setup Qdrant collection
setup_qdrant() {
    log_info "Setting up Qdrant collection..."
    
    if [[ -f "$PROJECT_DIR/scripts/setup-qdrant.js" ]]; then
        if docker-compose -f "$COMPOSE_FILE" exec -T app node scripts/setup-qdrant.js; then
            log_success "Qdrant collection setup completed"
        else
            log_warn "Qdrant collection setup failed (may already exist)"
        fi
    else
        log_warn "setup-qdrant.js not found, skipping"
    fi
}

# Verify deployment
verify_deployment() {
    log_info "Verifying deployment..."
    
    # Check health endpoint
    local health_url="http://localhost:3000/health"
    local max_attempts=10
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        if curl -sf "$health_url" > /dev/null 2>&1; then
            log_success "Health check passed"
            break
        fi
        
        if [[ $attempt -eq $max_attempts ]]; then
            log_error "Health check failed"
            exit 1
        fi
        
        sleep 3
        ((attempt++))
    done
    
    # Display service status
    log_info "Service status:"
    docker-compose -f "$COMPOSE_FILE" ps
    
    log_success "Deployment verification complete"
}

# Display summary
display_summary() {
    echo ""
    echo "============================================================================="
    log_success "HIVE-MIND Deployment Complete!"
    echo "============================================================================="
    echo ""
    echo "Services:"
    echo "  - API:       http://localhost:3000"
    echo "  - PostgreSQL: localhost:5432"
    echo "  - Redis:     localhost:6379"
    echo "  - Qdrant:    http://localhost:6333"
    echo ""
    echo "Health Check:"
    echo "  curl http://localhost:3000/health"
    echo ""
    echo "Logs:"
    echo "  docker-compose -f docker-compose.coolify.yml logs -f"
    echo ""
    echo "Management:"
    echo "  docker-compose -f docker-compose.coolify.yml ps"
    echo "  docker-compose -f docker-compose.coolify.yml stop"
    echo "  docker-compose -f docker-compose.coolify.yml down"
    echo ""
    echo "============================================================================="
}

# Main function
main() {
    echo "============================================================================="
    echo "HIVE-MIND Coolify Deployment"
    echo "============================================================================="
    echo ""
    
    check_prerequisites
    generate_keys
    build_postgres_image
    validate_compose
    deploy_services
    wait_for_healthy
    run_migrations
    setup_qdrant
    verify_deployment
    display_summary
}

# Run main function
main "$@"
