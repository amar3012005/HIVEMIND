#!/bin/bash
# ==========================================
# Qdrant Initialization Script for HIVE-MIND
# EU Sovereign Vector Database Setup
# Region: FR-Paris (eu-central)
# ==========================================

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Environment variables (can be overridden)
QDRANT_URL="${QDRANT_URL:-https://hivemind-fr-par-1.cloud.qdrant.io}"
QDRANT_API_KEY="${QDRANT_API_KEY:-}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ==========================================
# Logging Functions
# ==========================================

log_info() {
    echo -e "${GREEN}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1" >&2
}

# ==========================================
# Prerequisites Check
# ==========================================

check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check if curl is available
    if ! command -v curl &> /dev/null; then
        log_error "curl is required but not installed"
        exit 1
    fi

    # Check if jq is available
    if ! command -v jq &> /dev/null; then
        log_error "jq is required but not installed"
        exit 1
    fi

    # Check Qdrant API key
    if [ -z "$QDRANT_API_KEY" ]; then
        log_error "QDRANT_API_KEY environment variable is not set"
        log_info "Please set QDRANT_API_KEY before running this script"
        exit 1
    fi

    log_info "Prerequisites check passed"
}

# ==========================================
# Qdrant API Functions
# ==========================================

# Check Qdrant health
check_health() {
    log_info "Checking Qdrant health at $QDRANT_URL..."

    local response
    response=$(curl -s -w "\n%{http_code}" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $QDRANT_API_KEY" \
        "$QDRANT_URL/healthz")

    local http_code
    http_code=$(echo "$response" | tail -n1)
    local body
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" -ne 200 ]; then
        log_error "Qdrant health check failed with HTTP $http_code"
        log_error "Response: $body"
        return 1
    fi

    local status
    status=$(echo "$body" | jq -r '.status // "unknown"')
    local version
    version=$(echo "$body" | jq -r '.version // "unknown"')

    log_info "Qdrant is healthy (v$version, status: $status)"
    return 0
}

# Create a collection
create_collection() {
    local collection_name="$1"
    local config_file="$2"

    log_info "Creating collection: $collection_name..."

    local response
    response=$(curl -s -w "\n%{http_code}" \
        -X PUT \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $QDRANT_API_KEY" \
        -d "@$config_file" \
        "$QDRANT_URL/collections/$collection_name")

    local http_code
    http_code=$(echo "$response" | tail -n1)
    local body
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" -eq 200 ] || [ "$http_code" -eq 201 ]; then
        log_info "Collection $collection_name created successfully"
        return 0
    elif [ "$http_code" -eq 409 ]; then
        log_warn "Collection $collection_name already exists"
        return 0
    else
        log_error "Failed to create collection $collection_name (HTTP $http_code)"
        log_error "Response: $body"
        return 1
    fi
}

# Create payload index
create_payload_index() {
    local collection_name="$1"
    local field_name="$2"
    local field_schema="$3"

    log_info "Creating payload index: $collection_name.$field_name ($field_schema)..."

    local payload
    payload=$(jq -n \
        --arg field_name "$field_name" \
        --arg field_schema "$field_schema" \
        '{field_name: $field_name, field_schema: $field_schema}')

    local response
    response=$(curl -s -w "\n%{http_code}" \
        -X PUT \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $QDRANT_API_KEY" \
        -d "$payload" \
        "$QDRANT_URL/collections/$collection_name/indexes?wait=true")

    local http_code
    http_code=$(echo "$response" | tail -n1)
    local body
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" -eq 200 ] || [ "$http_code" -eq 201 ]; then
        log_info "Payload index $field_name created successfully"
        return 0
    elif [ "$http_code" -eq 409 ]; then
        log_warn "Payload index $field_name already exists"
        return 0
    else
        log_error "Failed to create payload index $field_name (HTTP $http_code)"
        log_error "Response: $body"
        return 1
    fi
}

# Get collection info
get_collection_info() {
    local collection_name="$1"

    log_info "Getting collection info: $collection_name..."

    local response
    response=$(curl -s \
        -H "Authorization: Bearer $QDRANT_API_KEY" \
        "$QDRANT_URL/collections/$collection_name")

    echo "$response" | jq '.'
}

# ==========================================
# Collection Configuration Files
# ==========================================

create_memories_collection_config() {
    local config_dir="${SCRIPT_DIR}/config"
    mkdir -p "$config_dir"

    cat > "$config_dir/memories.json" << 'EOF'
{
  "vectors": {
    "size": 1024,
    "distance": "Cosine"
  },
  "hnsw_config": {
    "m": 16,
    "ef_construct": 100,
    "full_scan_threshold": 10000,
    "max_indexing_threads": 2,
    "on_disk": false
  },
  "optimizers_config": {
    "deleted_threshold": 0.2,
    "vacuum_min_vector_number": 1000,
    "default_segment_number": 10,
    "max_segment_size": 100000,
    "memmap_threshold": 10000,
    "indexing_threshold": 10000,
    "flush_interval_sec": 60,
    "max_optimization_threads": 2
  },
  "wal_config": {
    "wal_capacity_mb": 32,
    "wal_segments_ahead": 0
  },
  "quantization_config": {
    "scalar": {
      "type": "int8",
      "quantile": 0.99,
      "always_ram": true
    }
  },
  "shard_number": 2,
  "replication_factor": 2,
  "write_consistency_factor": 1
}
EOF

    echo "$config_dir/memories.json"
}

create_sessions_collection_config() {
    local config_dir="${SCRIPT_DIR}/config"
    mkdir -p "$config_dir"

    cat > "$config_dir/sessions.json" << 'EOF'
{
  "vectors": {
    "size": 1024,
    "distance": "Cosine"
  },
  "hnsw_config": {
    "m": 16,
    "ef_construct": 100,
    "full_scan_threshold": 10000
  },
  "shard_number": 1,
  "replication_factor": 2
}
EOF

    echo "$config_dir/sessions.json"
}

# ==========================================
# Main Setup Functions
# ==========================================

setup_memories_collection() {
    log_info "Setting up hivemind_memories collection..."

    # Create collection
    local config_file
    config_file=$(create_memories_collection_config)
    create_collection "hivemind_memories" "$config_file"

    # Create payload indexes
    local indexes=(
        "user_id:keyword"
        "org_id:keyword"
        "memory_type:keyword"
        "tags:keyword"
        "source_platform:keyword"
        "is_latest:bool"
        "document_date:datetime"
        "importance_score:float"
        "visibility:keyword"
        "strength:float"
        "recall_count:integer"
        "embedding_version:integer"
    )

    for index in "${indexes[@]}"; do
        local field_name="${index%%:*}"
        local field_schema="${index##*:}"
        create_payload_index "hivemind_memories" "$field_name" "$field_schema"
    done

    log_info "hivemind_memories collection setup complete"
}

setup_sessions_collection() {
    log_info "Setting up hivemind_sessions collection..."

    # Create collection
    local config_file
    config_file=$(create_sessions_collection_config)
    create_collection "hivemind_sessions" "$config_file"

    # Create payload indexes
    local indexes=(
        "user_id:keyword"
        "platform_type:keyword"
        "started_at:datetime"
        "ended_at:datetime"
        "message_count:integer"
    )

    for index in "${indexes[@]}"; do
        local field_name="${index%%:*}"
        local field_schema="${index##*:}"
        create_payload_index "hivemind_sessions" "$field_name" "$field_schema"
    done

    log_info "hivemind_sessions collection setup complete"
}

verify_setup() {
    log_info "Verifying collection setup..."

    local collections=("hivemind_memories" "hivemind_sessions")

    for collection in "${collections[@]}"; do
        log_info "Collection: $collection"
        get_collection_info "$collection"
        echo ""
    done

    log_info "Verification complete"
}

# ==========================================
# Main Execution
# ==========================================

main() {
    log_info "=========================================="
    log_info "HIVE-MIND Qdrant Cloud Setup"
    log_info "Region: FR-Paris (eu-central)"
    log_info "=========================================="

    # Check prerequisites
    check_prerequisites

    # Check health
    check_health || {
        log_error "Qdrant health check failed. Please verify your connection."
        exit 1
    }

    echo ""

    # Setup collections
    setup_memories_collection
    echo ""
    setup_sessions_collection
    echo ""

    # Verify setup
    verify_setup

    log_info "=========================================="
    log_info "Qdrant setup completed successfully!"
    log_info "=========================================="
    log_info ""
    log_info "Next steps:"
    log_info "1. Run embedding pipeline: npm run embeddings:process"
    log_info "2. Verify vector search: npm run recall:test"
    log_info "3. Monitor collections: npm run qdrant:stats"
}

# Parse command line arguments
case "${1:-}" in
    --health)
        check_prerequisites
        check_health
        ;;
    --setup)
        check_prerequisites
        setup_memories_collection
        setup_sessions_collection
        verify_setup
        ;;
    --verify)
        check_prerequisites
        verify_setup
        ;;
    --help|-h)
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo "  --health   Check Qdrant health"
        echo "  --setup    Create collections and indexes"
        echo "  --verify   Verify collection setup"
        echo "  --help     Show this help message"
        echo ""
        echo "Environment Variables:"
        echo "  QDRANT_URL      Qdrant Cloud URL (default: https://hivemind-fr-par-1.cloud.qdrant.io)"
        echo "  QDRANT_API_KEY  Qdrant API key (required)"
        echo "  LOG_LEVEL       Log level: INFO, WARN, ERROR (default: INFO)"
        ;;
    *)
        main
        ;;
esac
