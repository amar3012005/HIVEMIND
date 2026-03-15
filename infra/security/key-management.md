# HIVE-MIND Key Management Policy

## Overview

This document defines the key management infrastructure for HIVE-MIND's EU sovereign cloud deployment, implementing **Hold Your Own Key (HYOK)** encryption patterns with OVHcloud Managed HSM.

**Compliance Frameworks:**
- GDPR Article 32 (Security of Processing)
- NIS2 Article 21 (Cybersecurity Risk Management)
- DORA ICT Risk Management
- FIPS 140-2 Level 3 (HSM)

---

## Key Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                    HSM (Hardware Root)                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Master Key (KEK)                        │   │
│  │  - Never leaves HSM                                  │   │
│  │  - 256-bit AES key                                   │   │
│  │  - Generated in hardware                             │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ Wraps
┌─────────────────────────────────────────────────────────────┐
│                 Wrapped Data Encryption Keys                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Application DEK-001 (Database encryption)          │   │
│  │  Application DEK-002 (File storage encryption)      │   │
│  │  Application DEK-003 (Backup encryption)            │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ Encrypts
┌─────────────────────────────────────────────────────────────┐
│                      User Data                              │
│         (Encrypted at rest with DEKs)                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Types

### 1. Master Key (Key Encryption Key - KEK)

| Attribute | Value |
|-----------|-------|
| **Location** | OVHcloud Managed HSM (EU region) |
| **Algorithm** | AES-256-GCM |
| **Generation** | Hardware-generated, never exported |
| **Usage** | Wrap/unwrap DEKs only |
| **Rotation** | Annual (with 30-day overlap) |
| **Backup** | HSM-backed, multi-region replication |

**Security Controls:**
- Dual authorization required for deletion
- Automatic rotation scheduling
- Audit logging of all operations
- Geographic restriction to EU regions

### 2. Data Encryption Keys (DEKs)

| Attribute | Value |
|-----------|-------|
| **Location** | Wrapped and stored in application layer |
| **Algorithm** | AES-256-GCM |
| **Generation** | Software-generated, immediately wrapped |
| **Usage** | Encrypt/decrypt user data |
| **Rotation** | Per-data-class policy (90 days default) |
| **Storage** | Wrapped form only, encrypted at rest |

**DEK Categories:**

| DEK ID | Purpose | Rotation Period | Data Classification |
|--------|---------|-----------------|---------------------|
| DEK-DB | Database encryption | 90 days | Sensitive Personal |
| DEK-FS | File storage | 90 days | Sensitive Personal |
| DEK-BK | Backup encryption | 180 days | Sensitive Personal |
| DEK-LOG | Audit log encryption | 7 years | Restricted |
| DEK-CFG | Configuration secrets | 365 days | Confidential |

### 3. LUKS2 Volume Keys

| Attribute | Value |
|-----------|-------|
| **Cipher** | aes-xts-plain64 |
| **Key Size** | 512 bits (256 per XTS key) |
| **PBKDF** | Argon2id |
| **Storage** | TPM2-bound (optional) + HSM-wrapped |

---

## Key Lifecycle

### Generation

```bash
# Master Key (in HSM)
./hsm-integration.sh generate-master-key hivemind-master-$(date +%Y%m%d)

# DEK (wrapped by master key)
./hsm-integration.sh generate-dek hivemind-dek-$(date +%Y%m%d)
```

### Distribution

1. **Master Key**: Never distributed, remains in HSM
2. **Wrapped DEKs**: Distributed to application servers via secure channel
3. **Unwrapped DEKs**: Exist only in application memory, never persisted

### Storage

```
/etc/hivemind/
├── hsm/
│   ├── hsm.conf              # HSM connection config
│   ├── master-key.id         # Master key reference (not the key)
│   └── wrapped-keys/
│       ├── hivemind-dek-db.wrapped
│       ├── hivemind-dek-fs.wrapped
│       └── hivemind-dek-log.wrapped
└── luks/
    └── keys/
        └── *.key             # LUKS keyfiles (TPM2-bound)
```

### Rotation

#### Master Key Rotation (Annual)

```bash
# 1. Generate new master key
NEW_KEY_ID=$(./hsm-integration.sh generate-master-key hivemind-master-$(date +%Y%m%d))

# 2. Re-wrap all DEKs with new master key
for dek in /etc/hivemind/hsm/wrapped-keys/*.wrapped; do
    ./hsm-integration.sh rotate "$dek" "$NEW_KEY_ID"
done

# 3. Update active key reference
echo "$NEW_KEY_ID" > /etc/hivemind/hsm/master-key.id

# 4. Schedule old key deletion (30 days)
# Automated via cron
```

#### DEK Rotation (90 days)

```bash
# Rotate database DEK
./scripts/rotate-keys.sh rotate-dek DEK-DB

# This triggers:
# 1. Generate new DEK
# 2. Re-encrypt all data with new DEK
# 3. Update wrapped key storage
# 4. Invalidate old DEK after grace period
```

### Destruction

**Master Key Destruction:**
- Requires dual authorization from Security Officers
- 30-day grace period with audit logging
- Cryptographic erasure in HSM
- Certificate of destruction generated

**DEK Destruction:**
- Triggered by GDPR erasure requests
- Immediate cryptographic erasure
- Re-encryption of associated data with new DEK
- Audit trail retained per GDPR Article 30

---

## Access Control

### Roles and Permissions

| Role | HSM Operations | Key Management | Rotation | Destruction |
|------|---------------|----------------|----------|-------------|
| Security Admin | Full | Full | Authorized | Dual auth required |
| Application | None | Read wrapped keys only | None | None |
| Auditor | Read audit logs | None | None | None |
| Automated | Wrap/unwrap only | None | Scheduled | None |

### Authentication

```yaml
HSM_Access:
  Authentication: Certificate-based (mTLS)
  Authorization: RBAC with OVHcloud IAM
  MFA: Required for administrative operations
  Session: 1-hour timeout, re-auth required
  Audit: All operations logged
```

---

## Audit and Compliance

### Audit Log Retention

| Event Type | Retention | Format |
|------------|-----------|--------|
| Key generation | 7 years | Structured JSON |
| Key access (wrap/unwrap) | 7 years | Structured JSON |
| Key rotation | 7 years | Structured JSON |
| Key destruction | 7 years | Structured JSON |
| Failed access attempts | 7 years | Structured JSON |

### Compliance Mapping

| Requirement | Implementation | Evidence |
|-------------|----------------|----------|
| GDPR Art. 32(1)(a) | AES-256 encryption | HSM configuration |
| GDPR Art. 32(1)(b) | HSM-backed keys | Audit logs |
| NIS2 Art. 21(2)(c) | Key rotation procedures | Rotation logs |
| NIS2 Art. 21(2)(d) | Access control | IAM policies |
| DORA Art. 9 | Encryption key management | Key inventory |

---

## Incident Response

### Key Compromise Response

```
SEVERITY: Critical
RESPONSE TIME: 15 minutes

1. IMMEDIATE (0-15 min)
   - Revoke compromised key access
   - Generate emergency rotation keys
   - Notify Security Team

2. SHORT-TERM (15 min - 4 hours)
   - Rotate all affected keys
   - Re-encrypt all data
   - Preserve audit logs

3. MEDIUM-TERM (4-24 hours)
   - Root cause analysis
   - Update access controls
   - Document incident

4. LONG-TERM (1-7 days)
   - Compliance notification (if required)
   - Process improvement
   - Security review
```

### Contact Information

| Role | Contact | Escalation |
|------|---------|------------|
| Security On-Call | security@hivemind.io | +15 min |
| CISO | ciso@hivemind.io | +30 min |
| OVHcloud Support | support@ovhcloud.com | Immediate |
| DPO | dpo@hivemind.io | +1 hour |

---

## Appendix

### A. Key Naming Convention

```
Format: hivemind-{type}-{environment}-{date}-{sequence}

Types:
  - master: Master/KEK key
  - dek: Data encryption key
  - luks: LUKS volume key
  - tls: TLS certificate key

Examples:
  - hivemind-master-prod-20240309-001
  - hivemind-dek-db-prod-20240309-001
  - hivemind-luks-data-prod-20240309-001
```

### B. HSM Configuration Reference

```yaml
HSM:
  Provider: OVHcloud Managed HSM
  Region: EU-West (Gravelines, France)
  Standard: FIPS 140-2 Level 3
  Protocol: KMIP 1.4
  Endpoint: hsm.ovhcloud.com:5696
  
  Capabilities:
    - AES-256-GCM encryption
    - Key wrapping/unwrapping
    - Secure key generation
    - Hardware-backed random
    - Audit logging
```

### C. Verification Commands

```bash
# Verify LUKS2 encryption
cryptsetup luksDump /dev/sdb

# Verify HSM connectivity
./hsm-integration.sh test

# Check key rotation schedule
cat /etc/cron.d/hivemind-key-rotation

# Verify wrapped key integrity
openssl dgst -sha256 /etc/hivemind/hsm/wrapped-keys/*.wrapped
```

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2024-03-09 | Security Team | Initial release |

**Review Cycle:** Annual
**Next Review:** 2025-03-09
**Classification:** Confidential
