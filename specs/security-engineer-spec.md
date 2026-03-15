# Phase 1 Implementation Specification: Security Engineer

**Document Version:** 1.0.0  
**Role:** Security Engineer  
**Estimated Duration:** 10-14 days  
**Priority:** Critical (Compliance & Data Protection)  
**Compliance Reference:** CROSS_PLATFORM_SYNC_SPEC.md §1  

---

## Executive Summary

This specification defines the security implementation for HIVE-MIND's EU sovereign deployment. You will implement **LUKS2 encryption** for data at rest, integrate **OVHcloud Managed HSM** for HYOK (Hold Your Own Key), build **GDPR compliance tooling** (export/erasure), establish **audit logging** for NIS2/DORA, configure **security headers and CSP**, and implement **secret management** with HashiCorp Vault.

### Key Deliverables

1. ✅ LUKS2 encryption implementation guide
2. ✅ HSM integration (OVHcloud Managed HSM)
3. ✅ GDPR compliance tooling (export/erasure endpoints)
4. ✅ Audit log system (NIS2/DORA 7-year retention)
5. ✅ Security headers, CSP, CSRF protection
6. ✅ Penetration testing checklist
7. ✅ Secret management (Vault or Doppler)

---

## 1. LUKS2 Encryption Implementation

### 1.1 Full Disk Encryption Setup

```bash
#!/bin/bash
# File: infra/security/luks2-setup.sh
# LUKS2 Full Disk Encryption for HIVE-MIND

set -euo pipefail

# Configuration
DEVICE="${1:-/dev/nvme0n1}"
MOUNT_POINT="${2:-/data}"
KEY_SIZE=512
CIPHER="aes-xts-plain64"
HASH="sha512"
ITER_TIME=5000
LABEL="hivemind_data"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Verify running as root
if [[ $EUID -ne 0 ]]; then
    log_error "This script must be run as root"
    exit 1
fi

# Verify device exists
if [[ ! -b "${DEVICE}" ]]; then
    log_error "Device ${DEVICE} not found"
    exit 1
fi

# Confirm destructive operation
log_warn "WARNING: This will DESTROY all data on ${DEVICE}"
read -p "Are you sure you want to continue? (yes/no): " confirm
if [[ "${confirm}" != "yes" ]]; then
    log_info "Aborted"
    exit 0
fi

# Install required packages
log_info "Installing required packages..."
apt-get update
apt-get install -y cryptsetup luks2 clevis clevis-luks clevis-tang clevis-systemd

# Wipe device signatures
log_info "Wiping existing device signatures..."
wipefs -a "${DEVICE}"

# Generate master key
log_info "Generating master encryption key..."
MASTER_KEY_FILE="/etc/hivemind/master-key.bin"
mkdir -p /etc/hivemind
dd if=/dev/urandom of="${MASTER_KEY_FILE}" bs=512 count=4
chmod 600 "${MASTER_KEY_FILE}"

# Format with LUKS2
log_info "Formatting ${DEVICE} with LUKS2..."
cryptsetup luksFormat \
    --type luks2 \
    --cipher "${CIPHER}" \
    --key-size "${KEY_SIZE}" \
    --hash "${HASH}" \
    --iter-time "${ITER_TIME}" \
    --use-random \
    --label "${LABEL}" \
    --batch-mode \
    "${DEVICE}" \
    "${MASTER_KEY_FILE}"

# Verify LUKS2 header
log_info "Verifying LUKS2 header..."
cryptsetup luksDump "${DEVICE}" | grep "Version:" | grep "2" || {
    log_error "LUKS2 format verification failed"
    exit 1
}

# Open encrypted volume
log_info "Opening encrypted volume..."
cryptsetup open \
    --type luks2 \
    "${DEVICE}" \
    "${LABEL}" \
    --key-file "${MASTER_KEY_FILE}"

# Create filesystem
log_info "Creating ext4 filesystem..."
mkfs.ext4 -L "${LABEL}" "/dev/mapper/${LABEL}"

# Create mount point
mkdir -p "${MOUNT_POINT}"

# Mount volume
log_info "Mounting encrypted volume..."
mount "/dev/mapper/${LABEL}" "${MOUNT_POINT}"

# Set permissions
chown -R 1000:1000 "${MOUNT_POINT}"
chmod 750 "${MOUNT_POINT}"

# Configure /etc/crypttab
log_info "Configuring crypttab..."
DEVICE_UUID=$(blkid -s UUID -o value "${DEVICE}")
echo "${LABEL} UUID=${DEVICE_UUID} ${MASTER_KEY_FILE} luks2,discard,no-read-workqueue,no-write-workqueue" >> /etc/crypttab

# Configure /etc/fstab
log_info "Configuring fstab..."
MOUNT_UUID=$(blkid -s UUID -o value "/dev/mapper/${LABEL}")
echo "UUID=${MOUNT_UUID} ${MOUNT_POINT} ext4 defaults,noatime,nodiratime 0 2" >> /etc/fstab

# Configure initramfs
log_info "Updating initramfs..."
update-initramfs -u

# Verify mount
log_info "Verifying mount..."
df -h "${MOUNT_POINT}"

log_info "LUKS2 encryption setup complete!"
log_info "Device: ${DEVICE}"
log_info "Mount point: ${MOUNT_POINT}"
log_info "Label: ${LABEL}"

# Security recommendations
log_warn "Security Recommendations:"
log_warn "1. Store master key securely (HSM recommended)"
log_warn "2. Create backup key and store offline"
log_warn "3. Enable TPM2 binding for automatic unlock"
log_warn "4. Configure key rotation policy"
```

### 1.2 Key Rotation Script

```bash
#!/bin/bash
# File: infra/security/luks2-key-rotation.sh
# LUKS2 Key Rotation Script

set -euo pipefail

DEVICE="${1:-/dev/nvme0n1}"
LABEL="hivemind_data"

log_info() {
    echo "[INFO] $1"
}

log_error() {
    echo "[ERROR] $1"
    exit 1
}

# Generate new key
NEW_KEY_FILE="/etc/hivemind/master-key-$(date +%Y%m%d).bin"
dd if=/dev/urandom of="${NEW_KEY_FILE}" bs=512 count=4
chmod 600 "${NEW_KEY_FILE}"

# Add new key to LUKS2 header
log_info "Adding new key to LUKS2 header..."
cryptsetup luksAddKey "${DEVICE}" "${NEW_KEY_FILE}" --key-file "/etc/hivemind/master-key.bin"

# Verify new key works
log_info "Verifying new key..."
cryptsetup luksOpen --test-passphrase "${DEVICE}" --key-file "${NEW_KEY_FILE}" || {
    log_error "New key verification failed"
    rm -f "${NEW_KEY_FILE}"
    exit 1
}

# Remove old key (optional - keep for rollback)
log_info "Removing old key from LUKS2 header..."
cryptsetup luksRemoveKey "${DEVICE}" --key-file "/etc/hivemind/master-key.bin"

# Update key file reference
mv /etc/hivemind/master-key.bin /etc/hivemind/master-key-old-$(date +%Y%m%d).bin
mv "${NEW_KEY_FILE}" /etc/hivemind/master-key.bin

# Update crypttab if needed
log_info "Updating crypttab..."
# (crypttab uses key file path, not content, so no update needed)

log_info "Key rotation complete"
log_info "Old key archived: /etc/hivemind/master-key-old-$(date +%Y%m%d).bin"
```

### 1.3 TPM2 Binding (Optional)

```bash
#!/bin/bash
# File: infra/security/luks2-tpm2-binding.sh
# TPM2 Binding for Automatic Unlock

set -euo pipefail

DEVICE="${1:-/dev/nvme0n1}"
LABEL="hivemind_data"

# Install TPM2 tools
apt-get install -y tpm2-tools tpm2-abrmd

# Verify TPM2 is available
tpm2_pcrread || {
    echo "TPM2 not available, skipping binding"
    exit 0
}

# Create TPM2 policy
log_info "Creating TPM2 policy..."
tpm2_createpolicy \
    --policy-pcr \
    --pcr-list sha256:0,1,2,3,4,5,6,7 \
    --policy-name pcr.policy \
    --policy-auth

# Add TPM2-bound key
log_info "Adding TPM2-bound key..."
clevis luks bind -d "${DEVICE}" tang '{}'

# Configure automatic unlock
log_info "Configuring automatic unlock..."
clevis luks report -d "${DEVICE}"

# Update initramfs
update-initramfs -u

log_info "TPM2 binding configured"
```

---

## 2. HSM Integration (OVHcloud Managed HSM)

### 2.1 HSM Client Configuration

```typescript
// File: infra/security/hsm-client.ts

import * as crypto from 'crypto';
import { logger } from '../../core/src/utils/logger';

// OVHcloud HSM Configuration
interface HSMConfig {
  endpoint: string;
  clientId: string;
  clientCert: string;
  clientKey: string;
  caCert: string;
  partitionId: string;
}

interface KeyMetadata {
  keyId: string;
  algorithm: string;
  keySize: number;
  createdAt: Date;
  expiresAt?: Date;
  labels: Record<string, string>;
}

interface EncryptRequest {
  keyId: string;
  plaintext: Buffer;
  context?: Record<string, string>;
}

interface DecryptRequest {
  keyId: string;
  ciphertext: Buffer;
  context?: Record<string, string>;
}

export class HSMClient {
  private config: HSMConfig;
  private connected: boolean = false;

  constructor(config: HSMConfig) {
    this.config = config;
  }

  /**
   * Connect to HSM
   */
  async connect(): Promise<void> {
    try {
      // In production: Use PKCS#11 or KMIP protocol
      // For OVHcloud HSM, use their REST API or SDK
      
      const response = await fetch(`${this.config.endpoint}/health`, {
        headers: {
          'Client-Id': this.config.clientId,
        },
      });

      if (!response.ok) {
        throw new Error(`HSM health check failed: ${response.status}`);
      }

      this.connected = true;
      logger.info('HSM connection established', {
        endpoint: this.config.endpoint,
        partitionId: this.config.partitionId,
      });
    } catch (error) {
      logger.error('HSM connection failed', { error });
      throw error;
    }
  }

  /**
   * Generate a new key in HSM
   */
  async generateKey(params: {
    keyId: string;
    algorithm: 'AES' | 'RSA' | 'ECDSA';
    keySize: 256 | 384 | 512 | 2048 | 4096;
    labels?: Record<string, string>;
  }): Promise<KeyMetadata> {
    if (!this.connected) {
      throw new Error('HSM not connected');
    }

    try {
      const response = await fetch(`${this.config.endpoint}/v1/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': this.config.clientId,
        },
        body: JSON.stringify({
          partition_id: this.config.partitionId,
          key_id: params.keyId,
          algorithm: params.algorithm,
          key_size: params.keySize,
          labels: params.labels || {},
        }),
      });

      if (!response.ok) {
        throw new Error(`Key generation failed: ${response.status}`);
      }

      const result = await response.json();

      logger.info('Key generated in HSM', {
        keyId: params.keyId,
        algorithm: params.algorithm,
        keySize: params.keySize,
      });

      return {
        keyId: result.key_id,
        algorithm: result.algorithm,
        keySize: result.key_size,
        createdAt: new Date(result.created_at),
        expiresAt: result.expires_at ? new Date(result.expires_at) : undefined,
        labels: result.labels,
      };
    } catch (error) {
      logger.error('Key generation failed', { keyId: params.keyId, error });
      throw error;
    }
  }

  /**
   * Encrypt data using HSM key
   */
  async encrypt(request: EncryptRequest): Promise<Buffer> {
    if (!this.connected) {
      throw new Error('HSM not connected');
    }

    try {
      const response = await fetch(`${this.config.endpoint}/v1/keys/${request.keyId}/encrypt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': this.config.clientId,
        },
        body: JSON.stringify({
          plaintext: request.plaintext.toString('base64'),
          context: request.context,
        }),
      });

      if (!response.ok) {
        throw new Error(`Encryption failed: ${response.status}`);
      }

      const result = await response.json();
      return Buffer.from(result.ciphertext, 'base64');
    } catch (error) {
      logger.error('Encryption failed', { keyId: request.keyId, error });
      throw error;
    }
  }

  /**
   * Decrypt data using HSM key
   */
  async decrypt(request: DecryptRequest): Promise<Buffer> {
    if (!this.connected) {
      throw new Error('HSM not connected');
    }

    try {
      const response = await fetch(`${this.config.endpoint}/v1/keys/${request.keyId}/decrypt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': this.config.clientId,
        },
        body: JSON.stringify({
          ciphertext: request.ciphertext.toString('base64'),
          context: request.context,
        }),
      });

      if (!response.ok) {
        throw new Error(`Decryption failed: ${response.status}`);
      }

      const result = await response.json();
      return Buffer.from(result.plaintext, 'base64');
    } catch (error) {
      logger.error('Decryption failed', { keyId: request.keyId, error });
      throw error;
    }
  }

  /**
   * Wrap a key with HSM key (for LUKS key protection)
   */
  async wrapKey(params: {
    wrappingKeyId: string;
    keyToWrap: Buffer;
  }): Promise<Buffer> {
    if (!this.connected) {
      throw new Error('HSM not connected');
    }

    try {
      const response = await fetch(`${this.config.endpoint}/v1/keys/${params.wrappingKeyId}/wrap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': this.config.clientId,
        },
        body: JSON.stringify({
          key: params.keyToWrap.toString('base64'),
        }),
      });

      if (!response.ok) {
        throw new Error(`Key wrapping failed: ${response.status}`);
      }

      const result = await response.json();
      return Buffer.from(result.wrapped_key, 'base64');
    } catch (error) {
      logger.error('Key wrapping failed', { wrappingKeyId: params.wrappingKeyId, error });
      throw error;
    }
  }

  /**
   * Unwrap a key with HSM key
   */
  async unwrapKey(params: {
    wrappingKeyId: string;
    wrappedKey: Buffer;
  }): Promise<Buffer> {
    if (!this.connected) {
      throw new Error('HSM not connected');
    }

    try {
      const response = await fetch(`${this.config.endpoint}/v1/keys/${params.wrappingKeyId}/unwrap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': this.config.clientId,
        },
        body: JSON.stringify({
          wrapped_key: params.wrappedKey.toString('base64'),
        }),
      });

      if (!response.ok) {
        throw new Error(`Key unwrapping failed: ${response.status}`);
      }

      const result = await response.json();
      return Buffer.from(result.key, 'base64');
    } catch (error) {
      logger.error('Key unwrapping failed', { wrappingKeyId: params.wrappingKeyId, error });
      throw error;
    }
  }

  /**
   * Get key metadata
   */
  async getKeyMetadata(keyId: string): Promise<KeyMetadata> {
    const response = await fetch(`${this.config.endpoint}/v1/keys/${keyId}`, {
      headers: {
        'Client-Id': this.config.clientId,
      },
    });

    if (!response.ok) {
      throw new Error(`Key metadata fetch failed: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Delete a key (with confirmation)
   */
  async deleteKey(keyId: string, confirmation: string): Promise<void> {
    if (confirmation !== keyId) {
      throw new Error('Key ID confirmation required');
    }

    const response = await fetch(`${this.config.endpoint}/v1/keys/${keyId}`, {
      method: 'DELETE',
      headers: {
        'Client-Id': this.config.clientId,
      },
    });

    if (!response.ok) {
      throw new Error(`Key deletion failed: ${response.status}`);
    }

    logger.info('Key deleted from HSM', { keyId });
  }

  /**
   * Close HSM connection
   */
  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('HSM connection closed');
  }
}

// Singleton instance
let hsmClient: HSMClient | null = null;

export function getHSMClient(): HSMClient {
  if (!hsmClient) {
    hsmClient = new HSMClient({
      endpoint: process.env.OVH_HSM_ENDPOINT!,
      clientId: process.env.OVH_HSM_CLIENT_ID!,
      clientCert: process.env.OVH_HSM_CLIENT_CERT!,
      clientKey: process.env.OVH_HSM_CLIENT_KEY!,
      caCert: process.env.OVH_HSM_CA_CERT!,
      partitionId: process.env.OVH_HSM_PARTITION_ID!,
    });
  }
  return hsmClient;
}
```

### 2.2 HYOK Implementation

```typescript
// File: infra/security/hyok-encryption.ts

import { getHSMClient } from './hsm-client';
import { logger } from '../../core/src/utils/logger';
import crypto from 'crypto';

interface HYOKConfig {
  hsmKeyId: string;
  localKeyDerivation: 'pbkdf2' | 'scrypt' | 'argon2';
  encryptionAlgorithm: 'aes-256-gcm' | 'aes-256-cbc';
}

/**
 * HYOK (Hold Your Own Key) Encryption
 * 
 * Pattern:
 * 1. Master key stored in HSM (never leaves HSM)
 * 2. Data encryption keys (DEK) generated locally
 * 3. DEK wrapped with HSM master key
 * 4. Wrapped DEK stored with encrypted data
 */
export class HYOKEncryption {
  private config: HYOKConfig;

  constructor(config: HYOKConfig) {
    this.config = config;
  }

  /**
   * Encrypt data with HYOK pattern
   */
  async encrypt(plaintext: string, userId: string): Promise<{
    ciphertext: string;
    wrappedDek: string;
    iv: string;
    authTag?: string;
  }> {
    const hsm = getHSMClient();

    // Generate random DEK (Data Encryption Key)
    const dek = crypto.randomBytes(32); // 256-bit AES key

    // Generate random IV
    const iv = crypto.randomBytes(16);

    // Wrap DEK with HSM master key
    const wrappedDek = await hsm.wrapKey({
      wrappingKeyId: this.config.hsmKeyId,
      keyToWrap: Buffer.from(`${userId}:${dek.toString('hex')}`),
    });

    // Encrypt data locally with DEK
    const cipher = crypto.createCipheriv(
      this.config.encryptionAlgorithm,
      dek,
      iv
    );

    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');

    let authTag: string | undefined;
    if (this.config.encryptionAlgorithm === 'aes-256-gcm') {
      authTag = cipher.getAuthTag().toString('hex');
    }

    logger.debug('Data encrypted with HYOK', {
      userId,
      hsmKeyId: this.config.hsmKeyId,
      algorithm: this.config.encryptionAlgorithm,
    });

    return {
      ciphertext,
      wrappedDek: wrappedDek.toString('base64'),
      iv: iv.toString('hex'),
      authTag,
    };
  }

  /**
   * Decrypt data with HYOK pattern
   */
  async decrypt(params: {
    ciphertext: string;
    wrappedDek: string;
    iv: string;
    authTag?: string;
    userId: string;
  }): Promise<string> {
    const hsm = getHSMClient();

    // Unwrap DEK with HSM master key
    const unwrappedData = await hsm.unwrapKey({
      wrappingKeyId: this.config.hsmKeyId,
      wrappedKey: Buffer.from(params.wrappedDek, 'base64'),
    });

    // Verify user ownership
    const [storedUserId, dekHex] = unwrappedData.toString('utf8').split(':');
    if (storedUserId !== params.userId) {
      throw new Error('User ID mismatch - possible tampering');
    }

    const dek = Buffer.from(dekHex, 'hex');
    const iv = Buffer.from(params.iv, 'hex');

    // Decrypt data locally with DEK
    const decipher = crypto.createDecipheriv(
      this.config.encryptionAlgorithm,
      dek,
      iv
    );

    if (params.authTag && this.config.encryptionAlgorithm === 'aes-256-gcm') {
      decipher.setAuthTag(Buffer.from(params.authTag, 'hex'));
    }

    let plaintext = decipher.update(params.ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');

    logger.debug('Data decrypted with HYOK', {
      userId: params.userId,
      hsmKeyId: this.config.hsmKeyId,
    });

    return plaintext;
  }

  /**
   * Re-wrap DEK with new HSM key (for key rotation)
   */
  async rewrapDek(params: {
    wrappedDek: string;
    oldHsmKeyId: string;
    newHsmKeyId: string;
    userId: string;
  }): Promise<string> {
    const hsm = getHSMClient();

    // Unwrap with old key
    const unwrappedData = await hsm.unwrapKey({
      wrappingKeyId: params.oldHsmKeyId,
      wrappedKey: Buffer.from(params.wrappedDek, 'base64'),
    });

    // Wrap with new key
    const newWrappedDek = await hsm.wrapKey({
      wrappingKeyId: params.newHsmKeyId,
      keyToWrap: unwrappedData,
    });

    logger.info('DEK re-wrapped for key rotation', {
      userId: params.userId,
      oldKeyId: params.oldHsmKeyId,
      newKeyId: params.newHsmKeyId,
    });

    return newWrappedDek.toString('base64');
  }
}

// Singleton instance
let hyokEncryption: HYOKEncryption | null = null;

export function getHYOKEncryption(): HYOKEncryption {
  if (!hyokEncryption) {
    hyokEncryption = new HYOKEncryption({
      hsmKeyId: process.env.HSM_MASTER_KEY_ID!,
      localKeyDerivation: 'argon2',
      encryptionAlgorithm: 'aes-256-gcm',
    });
  }
  return hyokEncryption;
}
```

---

## 3. GDPR Compliance Tooling

### 3.1 Data Export Endpoint

```typescript
// File: core/src/api/routes/gdpr-export.ts

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateJWT } from '../../auth/middleware';
import { logger } from '../../utils/logger';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';
import { join } from 'path';

const router = Router();
const prisma = new PrismaClient();

/**
 * POST /api/gdpr/export
 * Request data export (GDPR Article 20)
 */
router.post('/export', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();
  const userId = req.user!.id;

  try {
    logger.info('GDPR export requested', { requestId, userId });

    // Create export request record
    const exportRequest = await prisma.dataExportRequest.create({
      data: {
        userId,
        requestType: 'export',
        status: 'pending',
        exportFormat: 'json',
      },
    });

    // Queue export job (async)
    queueExportJob(exportRequest.id, userId).catch(error => {
      logger.error('Export job failed', { exportRequestId: exportRequest.id, error });
    });

    res.status(202).json({
      status: 'processing',
      exportRequestId: exportRequest.id,
      estimatedCompletionTime: '5 minutes',
      message: 'Your data export is being prepared. You will receive an email when ready.',
    });
  } catch (error) {
    logger.error('GDPR export request failed', { requestId, userId, error });
    res.status(500).json({
      error: 'Export request failed',
      requestId,
    });
  }
});

/**
 * GET /api/gdpr/export/:id
 * Check export status and download
 */
router.get('/export/:id', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const exportRequest = await prisma.dataExportRequest.findFirst({
      where: { id, userId },
    });

    if (!exportRequest) {
      res.status(404).json({ error: 'Export request not found' });
      return;
    }

    if (exportRequest.status === 'pending' || exportRequest.status === 'processing') {
      res.json({
        status: exportRequest.status,
        message: 'Export is being prepared',
      });
      return;
    }

    if (exportRequest.status === 'failed') {
      res.status(500).json({
        status: 'failed',
        error: exportRequest.errorMessage,
      });
      return;
    }

    if (exportRequest.status === 'completed') {
      if (!exportRequest.exportUrl) {
        res.status(500).json({ error: 'Export URL not available' });
        return;
      }

      // Check if URL is still valid (24 hour expiry)
      const urlExpiry = new Date(Date.now() - 24 * 60 * 60 * 1000);
      if (exportRequest.completedAt! < urlExpiry) {
        res.status(410).json({
          status: 'expired',
          message: 'Download link has expired. Please request a new export.',
        });
        return;
      }

      res.json({
        status: 'completed',
        downloadUrl: exportRequest.exportUrl,
        expiresAt: new Date(exportRequest.completedAt!.getTime() + 24 * 60 * 60 * 1000),
      });
    }
  } catch (error) {
    logger.error('Export status check failed', { id, error });
    res.status(500).json({ error: 'Status check failed' });
  }
});

/**
 * Queue and process export job
 */
async function queueExportJob(exportRequestId: string, userId: string): Promise<void> {
  const prisma = new PrismaClient();

  try {
    await prisma.dataExportRequest.update({
      where: { id: exportRequestId },
      data: { status: 'processing' },
    });

    // Collect all user data
    const userData = await collectUserData(userId);

    // Generate export file
    const exportPath = join('/tmp', `export-${exportRequestId}.json.gz`);
    const writeStream = createWriteStream(exportPath);
    const gzipStream = createGzip();

    await pipeline(
      userData,
      gzipStream,
      writeStream
    );

    // Upload to secure storage and get signed URL
    const exportUrl = await uploadToSecureStorage(exportPath, exportRequestId);

    // Update export request
    await prisma.dataExportRequest.update({
      where: { id: exportRequestId },
      data: {
        status: 'completed',
        exportUrl,
        completedAt: new Date(),
      },
    });

    // Log for audit
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'data_export_completed',
        eventCategory: 'data_access',
        resourceType: 'user',
        resourceId: userId,
        action: 'export',
      },
    });

    logger.info('GDPR export completed', { exportRequestId, userId });
  } catch (error) {
    await prisma.dataExportRequest.update({
      where: { id: exportRequestId },
      data: {
        status: 'failed',
        errorMessage: String(error),
      },
    });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Collect all user data for export
 */
async function* collectUserData(userId: string): AsyncGenerator<string> {
  const prisma = new PrismaClient();

  try {
    yield '{\n  "exportDate": "' + new Date().toISOString() + '",\n';
    yield '  "userId": "' + userId + '",\n';

    // Export memories
    yield '  "memories": [\n';
    let first = true;
    for await (const memory of prisma.memory.findMany({
      where: { userId, deletedAt: null },
      cursor: { id: '' },
      take: 100,
    })) {
      if (!first) yield ',\n';
      first = false;
      yield JSON.stringify(memory, null, 2);
    }
    yield '\n  ],\n';

    // Export sessions
    yield '  "sessions": [\n';
    first = true;
    for await (const session of prisma.session.findMany({
      where: { userId },
      cursor: { id: '' },
      take: 100,
    })) {
      if (!first) yield ',\n';
      first = false;
      yield JSON.stringify(session, null, 2);
    }
    yield '\n  ],\n';

    // Export platform integrations (without secrets)
    yield '  "integrations": [\n';
    first = true;
    const integrations = await prisma.platformIntegration.findMany({
      where: { userId },
      select: {
        id: true,
        platformType: true,
        platformDisplayName: true,
        isActive: true,
        createdAt: true,
        lastSyncedAt: true,
      },
    });
    for (const integration of integrations) {
      if (!first) yield ',\n';
      first = false;
      yield JSON.stringify(integration, null, 2);
    }
    yield '\n  ]\n';

    yield '\n}';
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Upload export to secure storage
 */
async function uploadToSecureStorage(filePath: string, exportRequestId: string): Promise<string> {
  // In production: Upload to S3/GCS with signed URL
  // For now, return a placeholder
  return `https://exports.hivemind.io/${exportRequestId}.json.gz`;
}

export default router;
```

### 3.2 Data Erasure Endpoint (Right to be Forgotten)

```typescript
// File: core/src/api/routes/gdpr-erasure.ts

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateJWT, requireRoles } from '../../auth/middleware';
import { logger } from '../../utils/logger';

const router = Router();
const prisma = new PrismaClient();

/**
 * POST /api/gdpr/erasure
 * Request data erasure (GDPR Article 17)
 */
router.post('/erasure', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();
  const userId = req.user!.id;

  try {
    // Validate confirmation
    const { confirmation } = req.body;
    if (confirmation !== 'DELETE_MY_DATA') {
      res.status(400).json({
        error: 'Confirmation required',
        message: 'You must confirm by setting confirmation to "DELETE_MY_DATA"',
      });
      return;
    }

    logger.info('GDPR erasure requested', { requestId, userId });

    // Create erasure request record
    const erasureRequest = await prisma.dataExportRequest.create({
      data: {
        userId,
        requestType: 'erasure',
        status: 'pending',
      },
    });

    // Queue erasure job (async)
    queueErasureJob(erasureRequest.id, userId).catch(error => {
      logger.error('Erasure job failed', { erasureRequestId: erasureRequest.id, error });
    });

    res.status(202).json({
      status: 'processing',
      erasureRequestId: erasureRequest.id,
      estimatedCompletionTime: '24 hours',
      message: 'Your data erasure request is being processed. This action is irreversible.',
    });
  } catch (error) {
    logger.error('GDPR erasure request failed', { requestId, userId, error });
    res.status(500).json({
      error: 'Erasure request failed',
      requestId,
    });
  }
});

/**
 * Process data erasure
 */
async function queueErasureJob(erasureRequestId: string, userId: string): Promise<void> {
  const prisma = new PrismaClient();

  try {
    await prisma.dataExportRequest.update({
      where: { id: erasureRequestId },
      data: { status: 'processing' },
    });

    // Soft delete user data first (reversible within 30 days)
    await prisma.$transaction(async (tx) => {
      // Mark memories for deletion
      await tx.memory.updateMany({
        where: { userId },
        data: { deletedAt: new Date() },
      });

      // Mark sessions for deletion
      await tx.session.updateMany({
        where: { userId },
        data: { endedAt: new Date() },
      });

      // Revoke platform integrations
      await tx.platformIntegration.updateMany({
        where: { userId },
        data: {
          isActive: false,
          syncStatus: 'revoked',
        },
      });

      // Mark user for deletion
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: new Date() },
      });
    });

    // Log for audit (this record itself must be retained for compliance)
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'data_erasure_requested',
        eventCategory: 'data_modification',
        resourceType: 'user',
        resourceId: userId,
        action: 'erase',
        legalBasisNote: 'GDPR Article 17 - Right to erasure',
      },
    });

    // Schedule permanent deletion (after 30-day grace period)
    const permanentDeletionDate = new Date();
    permanentDeletionDate.setDate(permanentDeletionDate.getDate() + 30);

    await schedulePermanentDeletion(userId, permanentDeletionDate);

    await prisma.dataExportRequest.update({
      where: { id: erasureRequestId },
      data: {
        status: 'completed',
        completedAt: new Date(),
      },
    });

    logger.info('GDPR erasure completed', { erasureRequestId, userId });
  } catch (error) {
    await prisma.dataExportRequest.update({
      where: { id: erasureRequestId },
      data: {
        status: 'failed',
        errorMessage: String(error),
      },
    });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Schedule permanent deletion
 */
async function schedulePermanentDeletion(userId: string, date: Date): Promise<void> {
  // In production: Use a job queue (Bull, Agenda) or cron
  logger.info('Permanent deletion scheduled', { userId, date });
}

/**
 * GET /api/gdpr/erasure/status
 * Check erasure status
 */
router.get('/erasure/status', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  try {
    const erasureRequest = await prisma.dataExportRequest.findFirst({
      where: {
        userId,
        requestType: 'erasure',
      },
      orderBy: { requestedAt: 'desc' },
    });

    if (!erasureRequest) {
      res.json({ status: 'none', message: 'No erasure request found' });
      return;
    }

    res.json({
      status: erasureRequest.status,
      requestedAt: erasureRequest.requestedAt,
      completedAt: erasureRequest.completedAt,
      errorMessage: erasureRequest.errorMessage,
    });
  } catch (error) {
    logger.error('Erasure status check failed', { userId, error });
    res.status(500).json({ error: 'Status check failed' });
  }
});

/**
 * POST /api/gdpr/erasure/cancel
 * Cancel pending erasure (within grace period)
 */
router.post('/erasure/cancel', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  try {
    // Check if erasure is in grace period
    const recentErasure = await prisma.dataExportRequest.findFirst({
      where: {
        userId,
        requestType: 'erasure',
        status: 'completed',
        completedAt: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days
        },
      },
    });

    if (!recentErasure) {
      res.status(400).json({
        error: 'No cancellable erasure found',
        message: 'Erasure must be within 30-day grace period',
      });
      return;
    }

    // Restore user data
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: null },
      });

      await tx.memory.updateMany({
        where: { userId },
        data: { deletedAt: null },
      });

      await tx.platformIntegration.updateMany({
        where: { userId },
        data: { isActive: true },
      });
    });

    // Log for audit
    await prisma.auditLog.create({
      data: {
        userId,
        eventType: 'data_erasure_cancelled',
        eventCategory: 'data_modification',
        resourceType: 'user',
        resourceId: userId,
        action: 'restore',
      },
    });

    logger.info('GDPR erasure cancelled', { userId });

    res.json({
      status: 'cancelled',
      message: 'Your data has been restored',
    });
  } catch (error) {
    logger.error('Erasure cancellation failed', { userId, error });
    res.status(500).json({ error: 'Cancellation failed' });
  }
});

export default router;
```

---

## 4. Audit Log System (NIS2/DORA)

### 4.1 Audit Logging Service

```typescript
// File: core/src/services/audit.service.ts

import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

interface AuditLogParams {
  userId?: string;
  organizationId?: string;
  eventType: string;
  eventCategory: 'auth' | 'data_access' | 'data_modification' | 'system' | 'security';
  resourceType?: string;
  resourceId?: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'export' | 'erase' | 'login' | 'logout';
  oldValue?: any;
  newValue?: any;
  ipAddress?: string;
  userAgent?: string;
  platformType?: string;
  sessionId?: string;
  processingBasis?: string;
  legalBasisNote?: string;
}

/**
 * Create an audit log entry
 * NIS2/DORA compliant with 7-year retention
 */
export async function auditLog(params: AuditLogParams): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        organizationId: params.organizationId,
        eventType: params.eventType,
        eventCategory: params.eventCategory,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        action: params.action,
        oldValue: params.oldValue ? JSON.stringify(params.oldValue) : null,
        newValue: params.newValue ? JSON.stringify(params.newValue) : null,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        platformType: params.platformType,
        sessionId: params.sessionId,
        processingBasis: params.processingBasis,
        legalBasisNote: params.legalBasisNote,
      },
    });

    logger.debug('Audit log created', {
      eventType: params.eventType,
      userId: params.userId,
      action: params.action,
    });
  } catch (error) {
    // Never fail the main operation due to audit logging
    logger.error('Audit logging failed', { error, params });
  }
}

/**
 * Query audit logs (for compliance officers)
 */
export async function queryAuditLogs(params: {
  userId?: string;
  organizationId?: string;
  eventType?: string;
  eventCategory?: string;
  startDate: Date;
  endDate: Date;
  limit?: number;
  offset?: number;
}): Promise<{ logs: any[]; total: number }> {
  const where: any = {
    createdAt: {
      gte: params.startDate,
      lte: params.endDate,
    },
  };

  if (params.userId) where.userId = params.userId;
  if (params.organizationId) where.organizationId = params.organizationId;
  if (params.eventType) where.eventType = params.eventType;
  if (params.eventCategory) where.eventCategory = params.eventCategory;

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: params.offset || 0,
      take: params.limit || 100,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total };
}

/**
 * Export audit logs for regulatory submission
 */
export async function exportAuditLogs(params: {
  organizationId: string;
  startDate: Date;
  endDate: Date;
  format: 'json' | 'csv' | 'parquet';
}): Promise<string> {
  const { logs } = await queryAuditLogs({
    organizationId: params.organizationId,
    startDate: params.startDate,
    endDate: params.endDate,
    limit: 100000,
  });

  // Generate export file
  const exportPath = `/tmp/audit-export-${Date.now()}.${params.format}`;

  switch (params.format) {
    case 'json':
      await writeJsonExport(logs, exportPath);
      break;
    case 'csv':
      await writeCsvExport(logs, exportPath);
      break;
    case 'parquet':
      await writeParquetExport(logs, exportPath);
      break;
  }

  logger.info('Audit log export created', {
    organizationId: params.organizationId,
    path: exportPath,
    recordCount: logs.length,
  });

  return exportPath;
}

async function writeJsonExport(logs: any[], path: string): Promise<void> {
  const { writeFileSync } = await import('fs');
  writeFileSync(path, JSON.stringify(logs, null, 2));
}

async function writeCsvExport(logs: any[], path: string): Promise<void> {
  const { createWriteStream } = await import('fs');
  const { stringify } = await import('csv-stringify/sync');
  
  const csv = stringify(logs, {
    header: true,
    columns: [
      'id', 'userId', 'eventType', 'eventCategory', 'action',
      'resourceType', 'resourceId', 'createdAt',
    ],
  });
  
  const { writeFileSync } = await import('fs');
  writeFileSync(path, csv);
}

async function writeParquetExport(logs: any[], path: string): Promise<void> {
  // Use parquet-writer or similar library
  logger.warn('Parquet export not yet implemented');
}

/**
 * Automatic retention policy enforcement
 * Run daily via cron
 */
export async function enforceRetentionPolicy(): Promise<void> {
  const retentionYears = 7;
  const cutoffDate = new Date();
  cutoffDate.setFullYear(cutoffDate.getFullYear() - retentionYears);

  // Archive old logs (don't delete for compliance)
  const result = await prisma.auditLog.updateMany({
    where: {
      createdAt: { lt: cutoffDate },
    },
    data: {
      // Mark for archival
      // In production: Move to cold storage
    },
  });

  logger.info('Retention policy enforced', {
    cutoffDate,
    recordsAffected: result.count,
  });
}

export default { auditLog, queryAuditLogs, exportAuditLogs, enforceRetentionPolicy };
```

### 4.2 Audit Log Middleware

```typescript
// File: core/src/middleware/audit-middleware.ts

import { Request, Response, NextFunction } from 'express';
import { auditLog } from '../services/audit.service';

interface AuditOptions {
  eventType: string;
  eventCategory: 'auth' | 'data_access' | 'data_modification' | 'system' | 'security';
  action: 'create' | 'read' | 'update' | 'delete' | 'export' | 'erase';
  resourceType: string;
  getResourceId?: (req: Request) => string | undefined;
  includeBody?: boolean;
}

/**
 * Middleware to automatically audit requests
 */
export function auditMiddleware(options: AuditOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startTime = Date.now();

    // Capture response for audit
    const originalJson = res.json;
    let responseBody: any;

    res.json = function(body: any) {
      responseBody = body;
      return originalJson.call(this, body);
    };

    try {
      await next();

      // Log after successful request
      const latency = Date.now() - startTime;

      await auditLog({
        userId: req.user?.id,
        organizationId: req.user?.organizationId,
        eventType: options.eventType,
        eventCategory: options.eventCategory,
        resourceType: options.resourceType,
        resourceId: options.getResourceId?.(req),
        action: options.action,
        newValue: options.includeBody ? responseBody : undefined,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        platformType: req.headers['x-platform-type'] as string,
        sessionId: req.headers['x-session-id'] as string,
        processingBasis: 'consent',
      });
    } catch (error) {
      // Log failed request
      await auditLog({
        userId: req.user?.id,
        organizationId: req.user?.organizationId,
        eventType: `${options.eventType}_error`,
        eventCategory: options.eventCategory,
        resourceType: options.resourceType,
        action: options.action,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] as string,
        legalBasisNote: `Error: ${error}`,
      });

      throw error;
    }
  };
}

// Usage examples:
// router.post('/memories', authenticateJWT, auditMiddleware({
//   eventType: 'memory_created',
//   eventCategory: 'data_modification',
//   action: 'create',
//   resourceType: 'memory',
//   getResourceId: (req) => req.body.id,
//   includeBody: true,
// }), createMemoryHandler);
```

---

## 5. Security Headers & CSP

### 5.1 Security Headers Middleware

```typescript
// File: core/src/middleware/security-headers.ts

import { Request, Response, NextFunction } from 'express';

/**
 * Security headers middleware
 * Implements OWASP secure headers recommendations
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  // Strict Transport Security
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload'
  );

  // Content Security Policy
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "connect-src 'self' https://api.hivemind.io",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ].join('; ')
  );

  // X-Content-Type-Options
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // X-Frame-Options
  res.setHeader('X-Frame-Options', 'DENY');

  // X-XSS-Protection (legacy but still useful)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer-Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions-Policy
  res.setHeader(
    'Permissions-Policy',
    [
      'camera=()',
      'microphone=()',
      'geolocation=()',
      'payment=()',
      'usb=()',
      'accelerometer=()',
      'gyroscope=()',
    ].join(', ')
  );

  // Cross-Origin-Opener-Policy
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  // Cross-Origin-Embedder-Policy
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

  // Cross-Origin-Resource-Policy
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // Cache-Control for sensitive data
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  next();
}

/**
 * CSRF Protection Middleware
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  // Skip for API routes using JWT
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }

  // For browser routes, validate CSRF token
  const csrfToken = req.headers['x-csrf-token'];
  const sessionToken = req.cookies?.csrfToken;

  if (!csrfToken || csrfToken !== sessionToken) {
    res.status(403).json({
      error: 'CSRF token missing or invalid',
    });
    return;
  }

  next();
}

/**
 * Generate CSRF token
 */
export function generateCsrfToken(): string {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}
```

---

## 6. Penetration Testing Checklist

### 6.1 Security Testing Checklist

```markdown
# HIVE-MIND Penetration Testing Checklist

## Authentication & Authorization

- [ ] **A1.1**: Test JWT token validation (expired, malformed, wrong issuer)
- [ ] **A1.2**: Test token replay attacks
- [ ] **A1.3**: Test privilege escalation (user → admin)
- [ ] **A1.4**: Test multi-tenant isolation (cross-user access)
- [ ] **A1.5**: Test OAuth flow vulnerabilities (CSRF, state manipulation)
- [ ] **A1.6**: Test session fixation
- [ ] **A1.7**: Test brute force protection
- [ ] **A1.8**: Test account enumeration

## API Security

- [ ] **A2.1**: Test SQL injection (all query parameters)
- [ ] **A2.2**: Test NoSQL injection (if applicable)
- [ ] **A2.3**: Test command injection
- [ ] **A2.4**: Test path traversal
- [ ] **A2.5**: Test XXE (XML External Entity)
- [ ] **A2.6**: Test SSRF (Server-Side Request Forgery)
- [ ] **A2.7**: Test rate limiting bypass
- [ ] **A2.8**: Test IDOR (Insecure Direct Object Reference)

## Data Protection

- [ ] **A3.1**: Verify LUKS2 encryption at rest
- [ ] **A3.2**: Verify TLS 1.3 in transit
- [ ] **A3.3**: Test data leakage in error messages
- [ ] **A3.4**: Test sensitive data in logs
- [ ] **A3.5**: Verify HSM key protection
- [ ] **A3.6**: Test memory scraping attacks
- [ ] **A3.7**: Verify secure key rotation

## GDPR Compliance

- [ ] **A4.1**: Test data export completeness
- [ ] **A4.2**: Test data erasure irreversibility
- [ ] **A4.3**: Verify audit log integrity
- [ ] **A4.4**: Test consent withdrawal
- [ ] **A4.5**: Verify data portability format

## Infrastructure

- [ ] **A5.1**: Test container escape
- [ ] **A5.2**: Test Kubernetes RBAC
- [ ] **A5.3**: Test network policy enforcement
- [ ] **A5.4**: Test secrets exposure
- [ ] **A5.5**: Test backup encryption
- [ ] **A5.6**: Test disaster recovery

## Platform Integrations

- [ ] **A6.1**: Test webhook signature validation
- [ ] **A6.2**: Test OAuth token storage
- [ ] **A6.3**: Test cross-platform data leakage
- [ ] **A6.4**: Test MCP server isolation

## Tools Recommended

- Burp Suite Professional
- OWASP ZAP
- sqlmap
- nmap
- nuclei
- trivy (container scanning)
- kube-bench (Kubernetes security)
```

---

## 7. Secret Management (HashiCorp Vault)

### 7.1 Vault Configuration

```hcl
# File: infra/vault/config.hcl

storage "consul" {
  address = "127.0.0.1:8500"
  path    = "vault/"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = false
  tls_cert_file = "/etc/vault/tls/vault.crt"
  tls_key_file  = "/etc/vault/tls/vault.key"
}

api_addr = "https://vault.hivemind.io:8200"
cluster_addr = "https://vault.hivemind.io:8201"

ui = true

# Audit logging
audit {
  type = "file"
  options = {
    file_path = "/var/log/vault/audit.log"
  }
}

# Seal configuration (HSM-backed)
seal "transit" {
  address = "https://hsm.hivemind.io"
  token = "s.xxxxx"
  disable_renewal = false
  key_name = "vault-unseal"
  mount_path = "transit/"
}
```

### 7.2 Vault Integration

```typescript
// File: infra/security/vault-client.ts

import { Vault } from 'node-vault';
import { logger } from '../../core/src/utils/logger';

interface VaultConfig {
  endpoint: string;
  token: string;
  namespace?: string;
}

export class VaultClient {
  private client: Vault;
  private config: VaultConfig;

  constructor(config: VaultConfig) {
    this.config = config;
    this.client = Vault({
      endpoint: config.endpoint,
      token: config.token,
      namespace: config.namespace,
    });
  }

  /**
   * Get secret from Vault
   */
  async getSecret(path: string): Promise<any> {
    try {
      const result = await this.client.read(path);
      return result.data.data;
    } catch (error) {
      logger.error('Vault secret read failed', { path, error });
      throw error;
    }
  }

  /**
   * Write secret to Vault
   */
  async writeSecret(path: string, data: Record<string, any>): Promise<void> {
    try {
      await this.client.write(path, { data });
      logger.debug('Vault secret written', { path });
    } catch (error) {
      logger.error('Vault secret write failed', { path, error });
      throw error;
    }
  }

  /**
   * Delete secret from Vault
   */
  async deleteSecret(path: string): Promise<void> {
    try {
      await this.client.delete(path);
      logger.debug('Vault secret deleted', { path });
    } catch (error) {
      logger.error('Vault secret delete failed', { path, error });
      throw error;
    }
  }

  /**
   * List secrets at path
   */
  async listSecrets(path: string): Promise<string[]> {
    try {
      const result = await this.client.list(path);
      return result.data.keys;
    } catch (error) {
      logger.error('Vault secret list failed', { path, error });
      throw error;
    }
  }

  /**
   * Get dynamic database credentials
   */
  async getDbCredentials(role: string): Promise<{
    username: string;
    password: string;
  }> {
    try {
      const result = await this.client.read(`database/creds/${role}`);
      return {
        username: result.data.username,
        password: result.data.password,
      };
    } catch (error) {
      logger.error('Vault DB credentials failed', { role, error });
      throw error;
    }
  }

  /**
   * Renew token
   */
  async renewToken(): Promise<void> {
    try {
      await this.client.tokenRenewSelf();
      logger.debug('Vault token renewed');
    } catch (error) {
      logger.error('Vault token renewal failed', { error });
      throw error;
    }
  }
}

// Singleton
let vaultClient: VaultClient | null = null;

export function getVaultClient(): VaultClient {
  if (!vaultClient) {
    vaultClient = new VaultClient({
      endpoint: process.env.VAULT_ENDPOINT!,
      token: process.env.VAULT_TOKEN!,
      namespace: process.env.VAULT_NAMESPACE,
    });
  }
  return vaultClient;
}
```

---

## 8. Acceptance Criteria

### 8.1 Security Requirements

| ID | Requirement | Test Method | Pass Criteria |
|----|-------------|-------------|---------------|
| SEC-01 | LUKS2 encryption active | `cryptsetup luksDump` | LUKS2 confirmed |
| SEC-02 | HSM integration working | Generate/wrap key test | Key in HSM |
| SEC-03 | GDPR export complete | Request export | All data included |
| SEC-04 | GDPR erasure complete | Request erasure | Data deleted |
| SEC-05 | Audit logs captured | Query audit logs | All actions logged |
| SEC-06 | Security headers present | curl -I | All headers present |
| SEC-07 | CSP blocks inline scripts | XSS test | Script blocked |
| SEC-08 | Vault secrets accessible | Read secret test | Secret returned |
| SEC-09 | Penetration test passed | External audit | No critical findings |

### 8.2 Compliance Requirements

| Regulation | Requirement | Verification |
|------------|-------------|--------------|
| GDPR | Data export (Art. 20) | Export endpoint |
| GDPR | Right to erasure (Art. 17) | Erasure endpoint |
| GDPR | Audit trail (Art. 30) | Audit logs |
| NIS2 | 7-year log retention | Retention policy |
| DORA | Incident logging | Security event logs |

---

## 9. Testing Instructions

### 9.1 LUKS2 Verification

```bash
# Verify encryption
cryptsetup luksDump /dev/nvme0n1

# Test mount
cryptsetup open /dev/nvme0n1 hivemind_data --key-file /etc/hivemind/master-key.bin
mount /dev/mapper/hivemind_data /data
```

### 9.2 GDPR Testing

```bash
# Request export
curl -X POST https://api.hivemind.io/api/gdpr/export \
  -H "Authorization: Bearer $TOKEN"

# Request erasure
curl -X POST https://api.hivemind.io/api/gdpr/erasure \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirmation": "DELETE_MY_DATA"}'
```

### 9.3 Security Headers Test

```bash
# Check headers
curl -I https://api.hivemind.io/api/health

# Verify CSP
curl -I https://api.hivemind.io | grep -i content-security-policy
```

---

## 10. References

- [CROSS_PLATFORM_SYNC_SPEC.md](../CROSS_PLATFORM_SYNC_SPEC.md)
- [GDPR Text](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679)
- [NIS2 Directive](https://digital-strategy.ec.europa.eu/en/policies/nis2-directive)
- [DORA Regulation](https://www.esma.europa.eu/dora)
- [LUKS2 Specification](https://gitlab.com/cryptsetup/cryptsetup/-/wikis/LUKS2)
- [OVHcloud HSM Documentation](https://docs.ovhcloud.com/)
- [HashiCorp Vault Documentation](https://www.vaultproject.io/docs)

---

**Document Approval:**

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Security Lead | | | |
| Compliance Officer | | | |
| DevOps Lead | | | |
