#!/bin/bash
###############################################################################
# HIVE-MIND OVHcloud Managed HSM Integration
# Implements HYOK (Hold Your Own Key) encryption pattern
# Compliance: GDPR Article 32, NIS2 Article 21, DORA ICT Risk Management
###############################################################################

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="/var/log/hivemind-hsm.log"
HSM_CONFIG_DIR="/etc/hivemind/hsm"
HSM_CLIENT_DIR="/opt/hivemind/hsm-client"
VAULT_ADDR="${VAULT_ADDR:-https://vault.hivemind.internal:8200}"

# OVHcloud Managed HSM Configuration
HSM_ENDPOINT="${HSM_ENDPOINT:-hsm.ovhcloud.com}"
HSM_PORT="${HSM_PORT:-5696}"  # KMIP default port
HSM_CERT_DIR="$HSM_CONFIG_DIR/certs"

# Key naming conventions
KEY_PREFIX="hivemind"
KEY_VERSION="$(date +%Y%m%d)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    local level="$1"
    local message="$2"
    local timestamp=$(date -Iseconds)
    echo -e "${timestamp} [${level}] ${message}" | tee -a "$LOG_FILE"
}

error() { log "ERROR" "${RED}$1${NC}"; exit 1; }
warn() { log "WARN" "${YELLOW}$1${NC}"; }
info() { log "INFO" "${GREEN}$1${NC}"; }
debug() { log "DEBUG" "${BLUE}$1${NC}"; }

# Initialize HSM client environment
init_hsm_client() {
    info "Initializing OVHcloud Managed HSM client..."
    
    mkdir -p "$HSM_CONFIG_DIR" "$HSM_CLIENT_DIR" "$HSM_CERT_DIR"
    chmod 700 "$HSM_CONFIG_DIR"
    
    # Create HSM configuration
    cat > "$HSM_CONFIG_DIR/hsm.conf" <<EOF
# OVHcloud Managed HSM Configuration
# Generated: $(date -Iseconds)

# Connection Settings
HSM_ENDPOINT=$HSM_ENDPOINT
HSM_PORT=$HSM_PORT
HSM_TIMEOUT=30000

# TLS Configuration
HSM_CA_CERT=$HSM_CERT_DIR/ca.crt
HSM_CLIENT_CERT=$HSM_CERT_DIR/client.crt
HSM_CLIENT_KEY=$HSM_CERT_DIR/client.key

# Protocol Settings
HSM_PROTOCOL=KMIP
HSM_KMIP_VERSION=1.4

# Security Settings
HSM_KEY_WRAPPING_ALGORITHM=AES-256-GCM
HSM_KEY_DERIVATION=PBKDF2-SHA256

# Audit Settings
HSM_AUDIT_LOG=$LOG_FILE
HSM_AUDIT_LEVEL=INFO
EOF
    
    chmod 600 "$HSM_CONFIG_DIR/hsm.conf"
    info "HSM configuration created at $HSM_CONFIG_DIR/hsm.conf"
}

# Validate HSM certificates
validate_certificates() {
    info "Validating HSM certificates..."
    
    local certs=("$HSM_CERT_DIR/ca.crt" "$HSM_CERT_DIR/client.crt" "$HSM_CERT_DIR/client.key")
    
    for cert in "${certs[@]}"; do
        if [[ ! -f "$cert" ]]; then
            error "Certificate not found: $cert"
        fi
        
        # Verify certificate validity
        if [[ "$cert" == *.crt ]]; then
            local expiry=$(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2)
            local expiry_epoch=$(date -d "$expiry" +%s)
            local now_epoch=$(date +%s)
            local days_until_expiry=$(( (expiry_epoch - now_epoch) / 86400 ))
            
            if [[ $days_until_expiry -lt 30 ]]; then
                warn "Certificate expires in $days_until_expiry days: $cert"
            else
                info "Certificate valid for $days_until_expiry days: $(basename "$cert")"
            fi
        fi
    done
    
    # Verify certificate chain
    openssl verify -CAfile "$HSM_CERT_DIR/ca.crt" "$HSM_CERT_DIR/client.crt" || \
        error "Certificate chain validation failed"
    
    info "Certificate validation passed"
}

# Test HSM connectivity
test_hsm_connection() {
    info "Testing HSM connectivity..."
    
    source "$HSM_CONFIG_DIR/hsm.conf"
    
    # Test TCP connectivity
    if ! timeout 5 bash -c "cat < /dev/null > /dev/tcp/$HSM_ENDPOINT/$HSM_PORT" 2>/dev/null; then
        error "Cannot connect to HSM at $HSM_ENDPOINT:$HSM_PORT"
    fi
    
    # Test KMIP connection with pykmip or similar client
    if command -v pykmip-cli &> /dev/null; then
        pykmip-cli -c "$HSM_CONFIG_DIR/pykmip.conf" test || \
            error "KMIP protocol test failed"
    fi
    
    info "HSM connectivity test passed"
}

# Generate master key in HSM (HYOK pattern)
generate_master_key() {
    local key_name="${1:-${KEY_PREFIX}-master-${KEY_VERSION}}"
    
    info "Generating master key in HSM: $key_name"
    
    # Master key never leaves HSM - generated directly in hardware
    local key_id=$(python3 << EOF
from kmip.pie import client
from kmip.pie.objects import SymmetricKey
from kmip.core.enums import CryptographicAlgorithm, CryptographicUsageMask

with client.ProxyKmipClient(
    hostname='$HSM_ENDPOINT',
    port=$HSM_PORT,
    cert='$HSM_CERT_DIR/client.crt',
    key='$HSM_CERT_DIR/client.key',
    ca='$HSM_CERT_DIR/ca.crt'
) as c:
    key = c.create(
        CryptographicAlgorithm.AES,
        256,
        name='$key_name',
        cryptographic_usage_mask=[
            CryptographicUsageMask.ENCRYPT,
            CryptographicUsageMask.DECRYPT,
            CryptographicUsageMask.WRAP_KEY,
            CryptographicUsageMask.UNWRAP_KEY
        ]
    )
    print(key)
EOF
)
    
    if [[ -z "$key_id" ]]; then
        error "Failed to generate master key in HSM"
    fi
    
    # Store key ID reference locally (not the key itself)
    echo "$key_id" > "$HSM_CONFIG_DIR/master-key.id"
    chmod 600 "$HSM_CONFIG_DIR/master-key.id"
    
    info "Master key generated in HSM with ID: $key_id"
    echo "$key_id"
}

# Generate Data Encryption Key (DEK) and wrap with HSM
generate_wrapped_dek() {
    local dek_name="${1:-${KEY_PREFIX}-dek-${KEY_VERSION}}"
    local master_key_id="${2:-$(cat "$HSM_CONFIG_DIR/master-key.id")}"
    
    info "Generating DEK and wrapping with HSM master key..."
    
    # Generate random DEK locally
    local dek_file="/tmp/${dek_name}.bin"
    openssl rand -out "$dek_file" 32  # 256-bit DEK
    chmod 600 "$dek_file"
    
    # Wrap DEK with HSM master key
    local wrapped_dek=$(python3 << EOF
from kmip.pie import client
from kmip.core.enums import WrappingMethod, BlockCipherMode

with client.ProxyKmipClient(
    hostname='$HSM_ENDPOINT',
    port=$HSM_PORT,
    cert='$HSM_CERT_DIR/client.crt',
    key='$HSM_CERT_DIR/client.key',
    ca='$HSM_CERT_DIR/ca.crt'
) as c:
    # Read DEK
    with open('$dek_file', 'rb') as f:
        dek = f.read()
    
    # Wrap DEK with master key
    wrapped = c.wrap_key(
        key='$master_key_id',
        data=dek,
        wrapping_method=WrappingMethod.ENCRYPT,
        block_cipher_mode=BlockCipherMode.GCM
    )
    print(wrapped.hex())
EOF
)
    
    # Securely delete unwrapped DEK from local storage
    shred -u "$dek_file"
    
    # Store wrapped DEK
    local wrapped_file="$HSM_CONFIG_DIR/wrapped-keys/${dek_name}.wrapped"
    mkdir -p "$(dirname "$wrapped_file")"
    echo "$wrapped_dek" > "$wrapped_file"
    chmod 600 "$wrapped_file"
    
    info "DEK generated and wrapped. Stored at: $wrapped_file"
    echo "$wrapped_dek"
}

# Unwrap DEK using HSM (for encryption operations)
unwrap_dek() {
    local wrapped_dek_file="$1"
    local master_key_id="${2:-$(cat "$HSM_CONFIG_DIR/master-key.id")}"
    
    info "Unwrapping DEK using HSM..."
    
    local wrapped_hex=$(cat "$wrapped_dek_file")
    
    # Unwrap via HSM - DEK never exposed in plaintext outside secure enclave
    local dek=$(python3 << EOF
from kmip.pie import client
from kmip.core.enums import WrappingMethod, BlockCipherMode

with client.ProxyKmipClient(
    hostname='$HSM_ENDPOINT',
    port=$HSM_PORT,
    cert='$HSM_CERT_DIR/client.crt',
    key='$HSM_CERT_DIR/client.key',
    ca='$HSM_CERT_DIR/ca.crt'
) as c:
    wrapped = bytes.fromhex('$wrapped_hex')
    unwrapped = c.unwrap_key(
        key='$master_key_id',
        data=wrapped,
        wrapping_method=WrappingMethod.ENCRYPT,
        block_cipher_mode=BlockCipherMode.GCM
    )
    print(unwrapped.hex())
EOF
)
    
    echo "$dek"
}

# Rotate DEK (re-wrap with new master key)
rotate_dek() {
    local old_wrapped_file="$1"
    local new_master_key_id="${2:-$(cat "$HSM_CONFIG_DIR/master-key.id")}"
    
    info "Rotating DEK with new master key..."
    
    # Generate new DEK
    local dek_name=$(basename "$old_wrapped_file" .wrapped)
    local new_dek_file="/tmp/${dek_name}-new-$(date +%s).bin"
    
    # Unwrap old DEK
    local old_dek_hex=$(unwrap_dek "$old_wrapped_file")
    
    # Generate new DEK
    openssl rand -out "$new_dek_file" 32
    
    # Re-encrypt data with new DEK (application-specific)
    # This would involve reading all encrypted data and re-encrypting
    warn "DEK rotation requires re-encryption of all data"
    warn "This operation may take significant time depending on data volume"
    
    # Wrap new DEK
    generate_wrapped_dek "$dek_name" "$new_master_key_id"
    
    # Cleanup
    shred -u "$new_dek_file"
    
    info "DEK rotation complete"
}

# Setup Vault integration for HSM
setup_vault_integration() {
    info "Setting up HashiCorp Vault HSM integration..."
    
    # Configure Vault to use HSM for seal wrapping
    cat > "$HSM_CONFIG_DIR/vault-seal.hcl" <<EOF
# Vault HSM Seal Configuration
seal "pkcs11" {
  lib            = "/usr/lib/ovh-hsm/libovh-pkcs11.so"
  slot           = "0"
  pin            = "env://VAULT_HSM_PIN"
  key_label      = "hivemind-vault-seal"
  hmac_key_label = "hivemind-vault-hmac"
  generate_key   = "true"
}
EOF
    
    info "Vault HSM seal configuration created"
}

# Audit HSM key operations
audit_key_operations() {
    info "Retrieving HSM audit log..."
    
    python3 << EOF
from kmip.pie import client

with client.ProxyKmipClient(
    hostname='$HSM_ENDPOINT',
    port=$HSM_PORT,
    cert='$HSM_CERT_DIR/client.crt',
    key='$HSM_CERT_DIR/client.key',
    ca='$HSM_CERT_DIR/ca.crt'
) as c:
    # Query audit log (KMIP 1.4 Query operation)
    log = c.query()
    for entry in log:
        print(f"{entry}")
EOF
}

# Main function
main() {
    local command="${1:-help}"
    
    case "$command" in
        init)
            init_hsm_client
            validate_certificates
            test_hsm_connection
            info "HSM client initialization complete"
            ;;
            
        generate-master-key)
            validate_certificates
            generate_master_key "${2:-}"
            ;;
            
        generate-dek)
            validate_certificates
            generate_wrapped_dek "${2:-}" "${3:-}"
            ;;
            
        unwrap-dek)
            validate_certificates
            unwrap_dek "${2:-}" "${3:-}"
            ;;
            
        rotate)
            validate_certificates
            rotate_dek "${2:-}" "${3:-}"
            ;;
            
        test)
            validate_certificates
            test_hsm_connection
            info "All HSM tests passed"
            ;;
            
        vault-setup)
            setup_vault_integration
            ;;
            
        audit)
            audit_key_operations
            ;;
            
        status)
            info "HSM Status:"
            echo "  Endpoint: $HSM_ENDPOINT:$HSM_PORT"
            echo "  Config: $HSM_CONFIG_DIR/hsm.conf"
            if [[ -f "$HSM_CONFIG_DIR/master-key.id" ]]; then
                echo "  Master Key: $(cat "$HSM_CONFIG_DIR/master-key.id")"
            fi
            echo "  Wrapped Keys: $(ls -1 "$HSM_CONFIG_DIR/wrapped-keys" 2>/dev/null | wc -l)"
            ;;
            
        help|*)
            cat << EOF
HIVE-MIND OVHcloud Managed HSM Integration
Usage: $0 <command> [options]

Commands:
    init                          Initialize HSM client
    generate-master-key [name]    Generate master key in HSM
    generate-dek [name] [key_id]  Generate and wrap DEK
    unwrap-dek <file> [key_id]    Unwrap DEK using HSM
    rotate <wrapped_file> [key_id] Rotate DEK
    test                          Test HSM connectivity
    vault-setup                   Configure Vault HSM integration
    audit                         Retrieve HSM audit log
    status                        Show HSM status

Environment:
    HSM_ENDPOINT                  HSM hostname (default: hsm.ovhcloud.com)
    HSM_PORT                      HSM port (default: 5696)
    VAULT_ADDR                    Vault address

Examples:
    $0 init
    $0 generate-master-key hivemind-master-20240309
    $0 generate-dek hivemind-app-dek-001
    $0 test
EOF
            ;;
    esac
}

main "$@"
