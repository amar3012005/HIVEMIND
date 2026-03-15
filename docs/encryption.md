# HIVE-MIND Encryption Documentation

## Overview

HIVE-MIND implements comprehensive encryption for data at rest and in transit, ensuring EU sovereignty and compliance with GDPR, NIS2, and DORA regulations.

## Encryption Architecture

### Data at Rest (LUKS2)

All persistent data is encrypted using LUKS2 (Linux Unified Key Setup v2) with the following configuration:

- **Cipher**: `aes-xts-plain64` (AES-256 in XTS mode)
- **Key Size**: 512 bits (256-bit key + 256-bit tweak)
- **Hash**: SHA-512
- **Iteration Time**: 5000ms (brute-force resistance)
- **Label**: `hivemind_data`

### Data in Transit (TLS 1.3)

All network traffic is encrypted using TLS 1.3 with:
- Perfect Forward Secrecy (PFS)
- AEAD cipher suites (AES-GCM, ChaCha20-Poly1305)
- Certificate pinning for HSM communication

### HYOK Pattern (Hold Your Own Key)

User data is encrypted with a two-layer approach:

1. **User-Specific DEK (Data Encryption Key)**: Generated per user, stored locally
2. **HSM-Wrapped DEK**: DEK wrapped with HSM master key, stored with encrypted data

This ensures:
- HSM master key never leaves the HSM
- User data can be decrypted only with both DEK and HSM
- Key rotation doesn't require re-encrypting all user data

## LUKS2 Encryption Setup

### Prerequisites

- Linux kernel 5.0+ (LUKS2 support)
- cryptsetup 2.0+ with LUKS2 support
- Root access for device formatting

### Installation

```bash
# Install required packages
apt-get update
apt-get install -y cryptsetup cryptsetup-bin libluks2-0
```

### Initial Setup

```bash
# Run the setup script (requires root)
sudo ./infra/security/luks2-setup.sh /dev/nvme0n1 /data

# Or manually:
# 1. Generate master key
mkdir -p /etc/hivemind
dd if=/dev/urandom of=/etc/hivemind/master-key.bin bs=512 count=1
chmod 600 /etc/hivemind/master-key.bin

# 2. Format device with LUKS2
cryptsetup luksFormat \
    --type luks2 \
    --cipher aes-xts-plain64 \
    --key-size 512 \
    --hash sha512 \
    --iter-time 5000 \
    --use-random \
    --label hivemind_data \
    /dev/nvme0n1 \
    /etc/hivemind/master-key.bin

# 3. Open encrypted volume
cryptsetup open --type luks2 /dev/nvme0n1 hivemind_data --key-file /etc/hivemind/master-key.bin

# 4. Create filesystem
mkfs.ext4 -L hivemind_data /dev/mapper/hivemind_data

# 5. Mount volume
mkdir -p /data
mount /dev/mapper/hivemind_data /data
```

### Configuration

#### /etc/crypttab

Add entry for automatic unlocking on boot:

```
hivemind_data UUID=<device-uuid> /etc/hivemind/master-key.bin luks2,discard,no-read-workqueue,no-write-workqueue
```

#### /etc/fstab

Add entry for mounting:

```
UUID=<mapper-uuid> /data ext4 defaults,noatime,nodiratime 0 2
```

### TPM2 Binding (Optional)

For automatic unlocking without key files:

```bash
# Install TPM2 tools
apt-get install -y tpm2-tools tpm2-abrmd

# Create TPM2 policy
tpm2_createpolicy \
    --policy-pcr \
    --pcr-list sha256:0,1,2,3,4,5,6,7 \
    --policy-name pcr.policy \
    --policy-auth

# Bind key to TPM2
clevis luks bind -d /dev/nvme0n1 tang '{}'

# Configure automatic unlock
clevis luks report -d /dev/nvme0n1
```

## Key Management

### Key Rotation

Regular key rotation is required for security compliance:

```bash
# Rotate keys (requires root)
sudo ./scripts/rotate-keys.sh /dev/nvme0n1

# Manual rotation:
# 1. Generate new key
dd if=/dev/urandom of=/etc/hivemind/master-key-new.bin bs=512 count=1
chmod 600 /etc/hivemind/master-key-new.bin

# 2. Add new key
cryptsetup luksAddKey /dev/nvme0n1 /etc/hivemind/master-key-new.bin --key-file /etc/hivemind/master-key.bin

# 3. Verify new key
cryptsetup luksOpen --test-passphrase /dev/nvme0n1 --key-file /etc/hivemind/master-key-new.bin

# 4. Remove old key
cryptsetup luksKillSlot /dev/nvme0n1 0 --key-file /etc/hivemind/master-key.bin

# 5. Update key file
mv /etc/hivemind/master-key.bin /etc/hivemind/master-key-old-$(date +%Y%m%d).bin
mv /etc/hivemind/master-key-new.bin /etc/hivemind/master-key.bin
```

### Key Backup

Always maintain offline backups of encryption keys:

```bash
# Backup to secure location
cp /etc/hivemind/master-key.bin /secure/backup/master-key-$(date +%Y%m%d).bin
chmod 600 /secure/backup/master-key-$(date +%Y%m%d).bin

# Verify backup
cryptsetup luksOpen --test-passphrase /dev/nvme0n1 --key-file /secure/backup/master-key-$(date +%Y%m%d).bin
```

### Key Recovery

In case of key loss:

```bash
# Restore from backup
cp /secure/backup/master-key-<timestamp>.bin /etc/hivemind/master-key.bin
chmod 600 /etc/hivemind/master-key.bin

# Verify restored key
cryptsetup luksOpen --test-passphrase /dev/nvme0n1 --key-file /etc/hivemind/master-key.bin
```

## HSM Integration (OVHcloud Managed HSM)

### Configuration

```bash
# Install HSM client
apt-get install -y libpkcs11.so

# Configure HSM connection
export OVH_HSM_ENDPOINT=https://hsm.ovhcloud.com
export OVH_HSM_CLIENT_ID=<client-id>
export OVH_HSM_CLIENT_CERT=/etc/hivemind/hsm-client.crt
export OVH_HSM_CLIENT_KEY=/etc/hivemind/hsm-client.key
export OVH_HSM_CA_CERT=/etc/hivemind/hsm-ca.crt
export OVH_HSM_PARTITION_ID=<partition-id>
```

### HYOK Implementation

```typescript
// Generate user-specific DEK
const dek = crypto.randomBytes(32); // 256-bit AES key

// Wrap DEK with HSM master key
const wrappedDek = await hsm.wrapKey({
  wrappingKeyId: process.env.HSM_MASTER_KEY_ID,
  keyToWrap: Buffer.from(`${userId}:${dek.toString('hex')}`),
});

// Store wrapped DEK with encrypted data
// DEK is never stored in plaintext
```

### Key Rotation with HSM

```typescript
// Re-wrap DEK with new HSM key
const newWrappedDek = await hsm.rewrapDek({
  wrappedDek: oldWrappedDek,
  oldHsmKeyId: oldKeyId,
  newHsmKeyId: newKeyId,
  userId,
});
```

## Compliance

### GDPR Article 32 - Security of Processing

Encryption implementation satisfies GDPR requirements:

- **Pseudonymisation**: User data encrypted with user-specific keys
- **Encryption**: LUKS2 with AES-256-XTS
- **Integrity**: SHA-512 hashing for key derivation
- **Confidentiality**: TLS 1.3 for data in transit

### NIS2 Article 21 - Security of Network and Information Systems

- **Encryption at rest**: LUKS2 implemented
- **Encryption in transit**: TLS 1.3 implemented
- **Key management**: Regular rotation (90-day cycle)
- **Incident response**: Audit logging with 7-year retention

### DORA Article 14 - ICT Risk Management

- **Data protection**: End-to-end encryption
- **Access control**: RBAC with RLS policies
- **Monitoring**: Comprehensive audit logging
- **Resilience**: Backup and recovery procedures

## Monitoring

### Encryption Status

```bash
# Check LUKS2 status
cryptsetup luksDump /dev/nvme0n1

# Check encryption status
lsblk -f | grep luks

# Verify mount
df -h /data
```

### Key Rotation Monitoring

```bash
# Check key age
ls -la /etc/hivemind/master-key*.bin

# Check rotation log
grep "Key rotation" /var/log/syslog
```

## Troubleshooting

### Device Not Unlocking on Boot

```bash
# Check crypttab
cat /etc/crypttab

# Check fstab
cat /etc/fstab

# Manually unlock
cryptsetup open --type luks2 /dev/nvme0n1 hivemind_data --key-file /etc/hivemind/master-key.bin
```

### Key Lost

```bash
# Restore from backup
cp /secure/backup/master-key-<timestamp>.bin /etc/hivemind/master-key.bin

# Verify key
cryptsetup luksDump /dev/nvme0n1

# Test unlock
cryptsetup luksOpen --test-passphrase /dev/nvme0n1 --key-file /etc/hivemind/master-key.bin
```

### HSM Connection Failed

```bash
# Check HSM endpoint
curl -v https://hsm.ovhcloud.com/health

# Verify certificates
openssl x509 -in /etc/hivemind/hsm-client.crt -text

# Check network connectivity
nc -vz hsm.ovhcloud.com 443
```

## Security Checklist

- [ ] LUKS2 encryption enabled on all data volumes
- [ ] Master key stored securely (HSM recommended)
- [ ] Key rotation performed every 90 days
- [ ] Offline backup of master key maintained
- [ ] TPM2 binding configured for automatic unlock
- [ ] TLS 1.3 enabled for all network traffic
- [ ] HYOK pattern implemented for user data
- [ ] Audit logging enabled for encryption operations
- [ ] Access to encryption keys restricted to authorized personnel
- [ ] Key rotation procedures tested regularly

## References

- [LUKS2 Specification](https://gitlab.com/cryptsetup/cryptsetup/wikis/LUKS2-spec)
- [NIST SP 800-38E](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-38E.pdf) (XTS mode)
- [GDPR Article 32](https://gdpr-info.eu/art-32-gdpr/)
- [NIS2 Directive](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32022L2555)
- [DORA Regulation](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R0018)
