# =============================================================================
# HIVE-MIND HashiCorp Vault Configuration
# =============================================================================
# Purpose: Secure secret management for EU sovereign deployment
# Compliance: NIS2, DORA, GDPR Article 32
# Seal: Transit seal with HSM-backed master key
# =============================================================================

# -----------------------------------------------------------------------------
# Storage Backend Configuration
# -----------------------------------------------------------------------------
# Using Consul for high-availability storage
storage "consul" {
  address       = "127.0.0.1:8500"
  path          = "vault/"
  scheme        = "https"
  tls_skip_verify = false
  tls_ca_file   = "/etc/vault/tls/consul-ca.pem"
  tls_cert_file = "/etc/vault/tls/consul-client.pem"
  tls_key_file  = "/etc/vault/tls/consul-client-key.pem"
}

# -----------------------------------------------------------------------------
# Listener Configuration
# -----------------------------------------------------------------------------
# TCP listener with TLS
listener "tcp" {
  address                  = "0.0.0.0:8200"
  cluster_address          = "0.0.0.0:8201"
  
  # TLS Configuration
  tls_disable              = false
  tls_cert_file            = "/etc/vault/tls/vault.crt"
  tls_key_file             = "/etc/vault/tls/vault.key"
  tls_min_version          = "tls13"
  tls_cipher_suites        = "TLS_AES_256_GCM_SHA384,TLS_CHACHA20_POLY1305_SHA256"
  
  # Security settings
  tls_require_and_verify_client_cert = true
  tls_client_ca_file       = "/etc/vault/tls/client-ca.crt"
}

# -----------------------------------------------------------------------------
# Seal Configuration (HSM-backed Transit Seal)
# -----------------------------------------------------------------------------
# Using OVHcloud Managed HSM via Transit seal
seal "transit" {
  address          = "https://hsm.services.ovhcloud.com"
  token            = "env:OVH_HSM_TOKEN"
  disable_renewal  = false
  key_name         = "vault-unseal-key"
  mount_path       = "transit/"
  tls_ca_cert      = "/etc/vault/tls/hsm-ca.crt"
  tls_server_name  = "hsm.services.ovhcloud.com"
}

# -----------------------------------------------------------------------------
# API and Cluster Addresses
# -----------------------------------------------------------------------------
api_addr     = "https://vault.hivemind.io:8200"
cluster_addr = "https://vault.hivemind.io:8201"

# -----------------------------------------------------------------------------
# UI Configuration
# -----------------------------------------------------------------------------
ui = true

# -----------------------------------------------------------------------------
# Telemetry Configuration
# -----------------------------------------------------------------------------
telemetry {
  disable_hostname = true
  enable_hostname_label = false
  
  # Prometheus metrics
  prometheus_retention_time = "60s"
  
  # StatsD (optional)
  # statsd_address = "127.0.0.1:8125"
}

# -----------------------------------------------------------------------------
# Audit Device Configuration
# -----------------------------------------------------------------------------
# File audit device (additional to database audit logging)
audit "file" {
  type          = "file"
  file_path     = "/var/log/vault/audit.log"
  log_raw       = false  # Never log raw secrets
  hmac_accessor = true
  prefix        = "vault-audit"
}

# -----------------------------------------------------------------------------
# HA Configuration
# -----------------------------------------------------------------------------
# High availability settings
ha_storage "consul" {
  address       = "127.0.0.1:8500"
  path          = "vault-ha/"
  scheme        = "https"
}

# -----------------------------------------------------------------------------
# Performance Tuning
# -----------------------------------------------------------------------------
# Adjust based on workload
performance {
  raft_multiplier = 1
}

# -----------------------------------------------------------------------------
# Log Level
# -----------------------------------------------------------------------------
log_level = "info"
log_format = "json"

# -----------------------------------------------------------------------------
# Default Lease TTL
# -----------------------------------------------------------------------------
default_lease_ttl = "1h"
max_lease_ttl     = "24h"

# -----------------------------------------------------------------------------
# Disable Mlock (if running in container)
# -----------------------------------------------------------------------------
# disable_mlock = true

# -----------------------------------------------------------------------------
# Cluster Configuration
# -----------------------------------------------------------------------------
cluster_name = "hivemind-vault-cluster"
