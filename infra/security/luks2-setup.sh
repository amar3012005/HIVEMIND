#!/bin/bash
# LUKS2 Full Disk Encryption Setup for HIVE-MIND
# EU Sovereign Cloud: LUKS2 encryption with HYOK pattern
# Compliance: GDPR, NIS2, DORA
#
# Usage: sudo ./luks2-setup.sh /dev/nvme0n1 /data
#
# This script:
# 1. Installs required packages (cryptsetup, luks2)
# 2. Wipes existing device signatures
# 3. Generates master encryption key
# 4. Formats device with LUKS2
# 5. Opens encrypted volume
# 6. Creates ext4 filesystem
# 7. Mounts volume
# 8. Configures /etc/crypttab and /etc/fstab
# 9. Updates initramfs

set -euo pipefail

# Configuration
DEVICE="${1:-/dev/nvme0n1}"
MOUNT_POINT="${2:-/data}"
KEY_SIZE=512
CIPHER="aes-xts-plain64"
HASH="sha512"
ITER_TIME=5000
LABEL="hivemind_data"
MASTER_KEY_DIR="/etc/hivemind"
MASTER_KEY_FILE="${MASTER_KEY_DIR}/master-key.bin"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

log_section() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
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

# Check if device is already encrypted
if cryptsetup isLuks "${DEVICE}" 2>/dev/null; then
    log_warn "Device ${DEVICE} is already encrypted"
    read -p "Do you want to re-encrypt? This will destroy all data! (yes/no): " confirm
    if [[ "${confirm}" != "yes" ]]; then
        log_info "Aborted"
        exit 0
    fi
fi

# Confirm destructive operation
log_warn "WARNING: This will DESTROY all data on ${DEVICE}"
read -p "Are you sure you want to continue? (yes/no): " confirm
if [[ "${confirm}" != "yes" ]]; then
    log_info "Aborted"
    exit 0
fi

log_section "LUKS2 Encryption Setup for HIVE-MIND"

# Step 1: Install required packages
log_section "Step 1: Installing required packages..."
apt-get update
apt-get install -y \
    cryptsetup \
    cryptsetup-bin \
    libluks2-0 \
    libdevmapper1.02.1 \
    uuid-runtime \
    wipefs

# Step 2: Wipe device signatures
log_section "Step 2: Wiping existing device signatures..."
log_info "Wiping signatures from ${DEVICE}..."
wipefs -a "${DEVICE}" || true
dd if=/dev/zero of="${DEVICE}" bs=1M count=100 status=progress 2>/dev/null || true

# Step 3: Generate master key
log_section "Step 3: Generating master encryption key..."
mkdir -p "${MASTER_KEY_DIR}"
chmod 700 "${MASTER_KEY_DIR}"

# Generate 4KB master key (512 bytes for 4096-bit key)
log_info "Generating master key with ${KEY_SIZE} bits..."
dd if=/dev/urandom of="${MASTER_KEY_FILE}" bs=512 count=1
chmod 600 "${MASTER_KEY_FILE}"

# Backup master key (optional but recommended)
if [[ -d /backup ]]; then
    cp "${MASTER_KEY_FILE}" "/backup/master-key-backup-$(date +%Y%m%d).bin"
    chmod 600 "/backup/master-key-backup-$(date +%Y%m%d).bin"
    log_info "Master key backed up to /backup/"
fi

# Step 4: Format with LUKS2
log_section "Step 4: Formatting ${DEVICE} with LUKS2..."
log_info "Cipher: ${CIPHER}"
log_info "Key size: ${KEY_SIZE} bits"
log_info "Hash: ${HASH}"
log_info "Iter time: ${ITER_TIME}ms"

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

# Step 5: Verify LUKS2 header
log_section "Step 5: Verifying LUKS2 header..."
cryptsetup luksDump "${DEVICE}" | grep -E "Version|Cipher|Keysize|Label" || {
    log_error "LUKS2 format verification failed"
    exit 1
}

# Step 6: Open encrypted volume
log_section "Step 6: Opening encrypted volume..."
cryptsetup open \
    --type luks2 \
    "${DEVICE}" \
    "${LABEL}" \
    --key-file "${MASTER_KEY_FILE}"

# Step 7: Create filesystem
log_section "Step 7: Creating ext4 filesystem..."
mkfs.ext4 -L "${LABEL}" "/dev/mapper/${LABEL}"

# Step 8: Create mount point
log_section "Step 8: Creating mount point..."
mkdir -p "${MOUNT_POINT}"

# Step 9: Mount volume
log_section "Step 9: Mounting encrypted volume..."
mount "/dev/mapper/${LABEL}" "${MOUNT_POINT}"

# Set permissions
chown -R 1000:1000 "${MOUNT_POINT}"
chmod 750 "${MOUNT_POINT}"

# Step 10: Configure /etc/crypttab
log_section "Step 10: Configuring /etc/crypttab..."
DEVICE_UUID=$(blkid -s UUID -o value "${DEVICE}")

# Check if entry already exists
if ! grep -q "${LABEL}" /etc/crypttab 2>/dev/null; then
    echo "${LABEL} UUID=${DEVICE_UUID} ${MASTER_KEY_FILE} luks2,discard,no-read-workqueue,no-write-workqueue" >> /etc/crypttab
    log_info "Added entry to /etc/crypttab"
else
    log_info "Entry already exists in /etc/crypttab"
fi

# Step 11: Configure /etc/fstab
log_section "Step 11: Configuring /etc/fstab..."
MOUNT_UUID=$(blkid -s UUID -o value "/dev/mapper/${LABEL}")

# Check if entry already exists
if ! grep -q "${MOUNT_POINT}" /etc/fstab 2>/dev/null; then
    echo "UUID=${MOUNT_UUID} ${MOUNT_POINT} ext4 defaults,noatime,nodiratime 0 2" >> /etc/fstab
    log_info "Added entry to /etc/fstab"
else
    log_info "Entry already exists in /etc/fstab"
fi

# Step 12: Configure initramfs
log_section "Step 12: Updating initramfs..."
update-initramfs -u || log_warn "initramfs update failed (may require manual update)"

# Step 13: Verify mount
log_section "Step 13: Verifying mount..."
df -h "${MOUNT_POINT}"

# Step 14: Test encryption
log_section "Step 14: Testing encryption..."
echo "LUKS2 test file" > "${MOUNT_POINT}/test-encryption.txt"
umount "${MOUNT_POINT}"
cryptsetup close "${LABEL}"
cryptsetup open --type luks2 "${DEVICE}" "${LABEL}" --key-file "${MASTER_KEY_FILE}"
mount "/dev/mapper/${LABEL}" "${MOUNT_POINT}"
if grep -q "LUKS2 test file" "${MOUNT_POINT}/test-encryption.txt"; then
    log_info "Encryption test PASSED"
else
    log_error "Encryption test FAILED"
    exit 1
fi
rm -f "${MOUNT_POINT}/test-encryption.txt"

# Summary
log_section "LUKS2 Encryption Setup Complete!"
echo ""
echo -e "${GREEN}Device:        ${DEVICE}${NC}"
echo -e "${GREEN}Mount point:   ${MOUNT_POINT}${NC}"
echo -e "${GREEN}Label:         ${LABEL}${NC}"
echo -e "${GREEN}Key file:      ${MASTER_KEY_FILE}${NC}"
echo ""
echo -e "${YELLOW}Security Recommendations:${NC}"
echo "  1. Store master key securely (HSM recommended)"
echo "  2. Create backup key and store offline"
echo "  3. Enable TPM2 binding for automatic unlock"
echo "  4. Configure key rotation policy"
echo "  5. Test key rotation before production use"
echo ""
echo -e "${YELLOW}Key Rotation:${NC}"
echo "  Run: sudo ./scripts/rotate-keys.sh ${DEVICE}"
echo ""
echo -e "${YELLOW}TPM2 Binding (Optional):${NC}"
echo "  Run: sudo ./scripts/luks2-tpm2-binding.sh ${DEVICE}"
echo ""
