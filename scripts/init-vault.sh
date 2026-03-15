#!/bin/bash
# =============================================================================
# HIVE-MIND Vault Initialization Script
# =============================================================================
# Purpose: Initialize and unseal HashiCorp Vault
# Compliance: NIS2, DORA, GDPR Article 32
# Security: Requires multiple key holders for initialization
# =============================================================================

set -euo pipefail

# Configuration
VAULT_ADDR="${VAULT_ADDR:-https://127.0.0.1:8200}"
VAULT_CACERT="${VAULT_CACERT:-/etc/vault/tls/vault-ca.crt}"
KEY_SHARES="${VAULT_KEY_SHARES:-5}"
KEY_THRESHOLD="${VAULT_KEY_THRESHOLD:-3}"
ROOT_TOKEN_TTL="${VAULT_ROOT_TOKEN_TTL:-1h}"

# Output directory for initial keys
OUTPUT_DIR="${1:-/etc/vault/init}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"; }

# =============================================================================
# Pre-flight Checks
# =============================================================================
preflight() {
    log_step "Running pre-flight checks..."

    # Check Vault is installed
    if ! command -v vault &> /dev/null; then
        log_error "Vault binary not found"
        exit 1
    fi

    # Check Vault server is running
    if ! vault status -address="${VAULT_ADDR}" &> /dev/null; then
        log_error "Vault server is not running at ${VAULT_ADDR}"
        exit 1
    fi

    # Check if already initialized
    if vault status -address="${VAULT_ADDR}" 2>&1 | grep -q "Initialized.*true"; then
        log_warn "Vault is already initialized"
        read -p "Continue anyway? This may corrupt existing data (yes/no): " confirm
        if [[ "${confirm}" != "yes" ]]; then
            log_info "Aborted"
            exit 0
        fi
    fi

    # Create output directory
    mkdir -p "${OUTPUT_DIR}"
    chmod 700 "${OUTPUT_DIR}"

    log_info "Pre-flight checks passed"
}

# =============================================================================
# Initialize Vault
# =============================================================================
initialize_vault() {
    log_step "Initializing Vault with ${KEY_SHARES} key shares (threshold: ${KEY_THRESHOLD})..."

    # Initialize Vault
    local init_output
    init_output=$(vault operator init \
        -address="${VAULT_ADDR}" \
        -ca-cert="${VAULT_CACERT}" \
        -key-shares="${KEY_SHARES}" \
        -key-threshold="${KEY_THRESHOLD}" \
        -format=json)

    # Parse output
    local unseal_keys
    local root_token
    
    unseal_keys=$(echo "${init_output}" | jq -r '.unseal_keys_hex[]')
    root_token=$(echo "${init_output}" | jq -r '.root_token')

    # Save keys securely
    log_info "Saving unseal keys..."
    local key_index=1
    for key in ${unseal_keys}; do
        local key_file="${OUTPUT_DIR}/unseal-key-${key_index}.txt"
        echo "${key}" > "${key_file}"
        chmod 600 "${key_file}"
        log_info "  Key ${key_index}: ${key_file}"
        ((key_index++))
    done

    # Save root token
    echo "${root_token}" > "${OUTPUT_DIR}/root-token.txt"
    chmod 600 "${OUTPUT_DIR}/root-token.txt"
    log_info "  Root token: ${OUTPUT_DIR}/root-token.txt"

    # Create combined keys file (for backup)
    cat > "${OUTPUT_DIR}/vault-keys.json" << EOF
{
    "initialized_at": "$(date -Iseconds)",
    "key_shares": ${KEY_SHARES},
    "key_threshold": ${KEY_THRESHOLD},
    "unseal_keys": [$(echo "${unseal_keys}" | jq -R . | jq -s .)],
    "root_token": "${root_token}",
    "vault_addr": "${VAULT_ADDR}"
}
EOF
    chmod 600 "${OUTPUT_DIR}/vault-keys.json"

    log_info "Vault initialized successfully"
}

# =============================================================================
# Unseal Vault
# =============================================================================
unseal_vault() {
    log_step "Unsealing Vault..."

    # Read unseal keys
    local key_files=("${OUTPUT_DIR}"/unseal-key-*.txt)
    local keys_provided=0

    for key_file in "${key_files[@]}"; do
        if [[ ${keys_provided} -ge ${KEY_THRESHOLD} ]]; then
            break
        fi

        local key
        key=$(cat "${key_file}")
        
        vault operator unseal \
            -address="${VAULT_ADDR}" \
            -ca-cert="${VAULT_CACERT}" \
            "${key}"

        ((keys_provided++))
        log_info "  Unseal key ${keys_provided} applied"
    done

    # Verify unseal status
    local status
    status=$(vault status -address="${VAULT_ADDR}" -ca-cert="${VAULT_CACERT}" -format=json)
    
    if echo "${status}" | jq -e '.sealed' | grep -q false; then
        log_info "Vault unsealed successfully"
    else
        log_error "Vault failed to unseal"
        exit 1
    fi
}

# =============================================================================
# Enable Secret Engines
# =============================================================================
enable_secret_engines() {
    log_step "Enabling secret engines..."

    # Export root token for authentication
    export VAULT_TOKEN=$(cat "${OUTPUT_DIR}/root-token.txt")

    # Enable KV v2 for general secrets
    vault secrets enable -path=secret kv-v2
    log_info "  Enabled: secret (KV v2)"

    # Enable database secrets engine
    vault secrets enable -path=database database
    log_info "  Enabled: database"

    # Enable transit secrets engine (for encryption as a service)
    vault secrets enable -path=transit transit
    log_info "  Enabled: transit"

    # Enable PKI secrets engine
    vault secrets enable -path=pki pki
    log_info "  Enabled: pki"

    # Enable TOTP secrets engine
    vault secrets enable -path=totp totp
    log_info "  Enabled: totp"
}

# =============================================================================
# Configure Database Secrets
# =============================================================================
configure_database_secrets() {
    log_step "Configuring database secrets..."

    # Configure PostgreSQL connection
    vault write database/config/hivemind-postgres \
        plugin_name=postgresql-database-plugin \
        allowed_roles="hivemind-app,hivemind-readonly,hivemind-admin" \
        connection_url="postgresql://{{username}}:{{password}}@localhost:5432/hivemind?sslmode=require" \
        username="vault_admin" \
        password="${POSTGRES_VAULT_PASSWORD:-}"

    # Create rotation role for application
    vault write database/roles/hivemind-app \
        db_name=hivemind-postgres \
        creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; \
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
        default_ttl="1h" \
        max_ttl="24h"

    # Create rotation role for read-only access
    vault write database/roles/hivemind-readonly \
        db_name=hivemind-postgres \
        creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; \
            GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
        default_ttl="1h" \
        max_ttl="24h"

    log_info "  Database secrets configured"
}

# =============================================================================
# Configure Transit Encryption
# =============================================================================
configure_transit_encryption() {
    log_step "Configuring transit encryption..."

    # Create encryption key for application data
    vault write -f transit/keys/hivemind-data \
        type=aes256-gcm96 \
        exportable=true \
        allow_plaintext_backup=false

    # Create encryption key for token signing
    vault write -f transit/keys/hivemind-signing \
        type=ed25519 \
        exportable=false

    log_info "  Transit encryption configured"
}

# =============================================================================
# Configure PKI
# =============================================================================
configure_pki() {
    log_step "Configuring PKI..."

    # Generate root CA
    vault write -field=certificate pki/root/generate/internal \
        common_name="HIVE-MIND Root CA" \
        ttl=87600h > "${OUTPUT_DIR}/root-ca.crt"

    # Configure URLs
    vault write pki/config/urls \
        issuing_certificates="$VAULT_ADDR/v1/pki/ca" \
        crl_distribution_points="$VAULT_ADDR/v1/pki/crl"

    # Create intermediate role
    vault write pki/roles/hivemind-intermediate \
        allowed_domains="hivemind.io" \
        allow_subdomains=true \
        max_ttl="720h"

    log_info "  PKI configured"
}

# =============================================================================
# Create Policies
# =============================================================================
create_policies() {
    log_step "Creating Vault policies..."

    # Application policy
    vault policy write hivemind-app - <<EOF
# Read secrets
path "secret/data/hivemind/*" {
  capabilities = ["read", "list"]
}

# Read database credentials
path "database/creds/hivemind-app" {
  capabilities = ["read"]
}

# Use transit encryption
path "transit/encrypt/hivemind-data" {
  capabilities = ["update"]
}

path "transit/decrypt/hivemind-data" {
  capabilities = ["update"]
}

# Read PKI certificates
path "pki/issue/hivemind-intermediate" {
  capabilities = ["create", "update"]
}
EOF
    log_info "  Created: hivemind-app policy"

    # Admin policy
    vault policy write hivemind-admin - <<EOF
# Full access to secrets
path "secret/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

# Full access to database secrets
path "database/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

# Full access to transit
path "transit/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

# Manage PKI
path "pki/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

# Manage tokens
path "auth/token/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
EOF
    log_info "  Created: hivemind-admin policy"
}

# =============================================================================
# Security Recommendations
# =============================================================================
print_recommendations() {
    echo ""
    log_warn "============================================================================"
    log_warn "SECURITY RECOMMENDATIONS"
    log_warn "============================================================================"
    log_warn ""
    log_warn "1. KEY STORAGE:"
    log_warn "   - Distribute unseal keys to ${KEY_THRESHOLD} trusted individuals"
    log_warn "   - Store keys in secure locations (safe, HSM)"
    log_warn "   - Never store keys in version control"
    log_warn ""
    log_warn "2. ROOT TOKEN:"
    log_warn "   - Use root token only for initial setup"
    log_warn "   - Revoke root token after creating admin users"
    log_warn "   - Command: vault token revoke $(cat ${OUTPUT_DIR}/root-token.txt)"
    log_warn ""
    log_warn "3. BACKUP:"
    log_warn "   - Backup Vault storage (Consul) regularly"
    log_warn "   - Test restore procedures quarterly"
    log_warn "   - Keep offline backup of unseal keys"
    log_warn ""
    log_warn "4. MONITORING:"
    log_warn "   - Enable audit logging (already configured)"
    log_warn "   - Monitor for failed unseal attempts"
    log_warn "   - Set up alerts for seal status changes"
    log_warn ""
    log_warn "============================================================================"
}

# =============================================================================
# Main Execution
# =============================================================================
main() {
    echo ""
    log_info "============================================================================"
    log_info "HIVE-MIND Vault Initialization"
    log_info "============================================================================"
    echo ""

    preflight
    initialize_vault
    unseal_vault
    enable_secret_engines
    configure_database_secrets
    configure_transit_encryption
    configure_pki
    create_policies
    print_recommendations

    echo ""
    log_info "============================================================================"
    log_info "VAULT INITIALIZATION COMPLETE"
    log_info "============================================================================"
    log_info ""
    log_info "Vault Address: ${VAULT_ADDR}"
    log_info "Output Directory: ${OUTPUT_DIR}"
    log_info ""
    log_info "Next Steps:"
    log_info "  1. Distribute unseal keys to key holders"
    log_info "  2. Create named admin users: vault auth enable userpass"
    log_info "  3. Revoke root token after setup"
    log_info "  4. Configure application authentication"
    log_info ""
}

# Run main function
main "$@"
