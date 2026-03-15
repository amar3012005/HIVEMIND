#!/bin/bash
# LUKS2 Key Rotation Script for HIVE-MIND
# EU Sovereign Cloud: Secure key rotation with HSM integration
#
# Usage: sudo ./rotate-keys.sh /dev/nvme0n1
#
# This script:
# 1. Generates a new master key
# 2. Adds new key to LUKS2 header
# 3. Verifies new key works
# 4. Removes old key from LUKS2 header
# 5. Archives old key with timestamp
# 6. Updates key file reference

set -euo pipefail

DEVICE="${1:-/dev/nvme0n1}"
LABEL="hivemind_data"
MASTER_KEY_DIR="/etc/hivemind"
MASTER_KEY_FILE="${MASTER_KEY_DIR}/master-key.bin"
ARCHIVE_DIR="${MASTER_KEY_DIR}/archived"

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

# Verify device is encrypted
if ! cryptsetup isLuks "${DEVICE}" 2>/dev/null; then
    log_error "Device ${DEVICE} is not encrypted with LUKS"
    exit 1
fi

log_section "LUKS2 Key Rotation"

# Step 1: Verify current key works
log_section "Step 1: Verifying current key..."
if ! cryptsetup luksOpen --test-passphrase "${DEVICE}" --key-file "${MASTER_KEY_FILE}" 2>/dev/null; then
    log_error "Current master key is invalid"
    exit 1
fi
log_info "Current master key verified"

# Step 2: Generate new key
log_section "Step 2: Generating new master key..."
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
NEW_KEY_FILE="${MASTER_KEY_DIR}/master-key-${TIMESTAMP}.bin"

# Generate 512-byte key
dd if=/dev/urandom of="${NEW_KEY_FILE}" bs=512 count=1
chmod 600 "${NEW_KEY_FILE}"
log_info "New key generated: ${NEW_KEY_FILE}"

# Step 3: Add new key to LUKS2 header
log_section "Step 3: Adding new key to LUKS2 header..."
cryptsetup luksAddKey "${DEVICE}" "${NEW_KEY_FILE}" --key-file "${MASTER_KEY_FILE}"
log_info "New key added to LUKS2 header"

# Step 4: Verify new key works
log_section "Step 4: Verifying new key..."
if ! cryptsetup luksOpen --test-passphrase "${DEVICE}" --key-file "${NEW_KEY_FILE}" 2>/dev/null; then
    log_error "New key verification failed"
    rm -f "${NEW_KEY_FILE}"
    exit 1
fi
log_info "New key verified successfully"

# Step 5: Remove old key from LUKS2 header
log_section "Step 5: Removing old key from LUKS2 header..."
cryptsetup luksKillSlot "${DEVICE}" 0 --key-file "${MASTER_KEY_FILE}" || {
    log_warn "Could not remove key slot 0, trying alternative method..."
    # Try removing by key file if slot removal fails
    cryptsetup luksRemoveKey "${DEVICE}" --key-file "${MASTER_KEY_FILE}" || {
        log_error "Failed to remove old key"
        exit 1
    }
}
log_info "Old key removed from LUKS2 header"

# Step 6: Archive old key
log_section "Step 6: Archiving old key..."
mkdir -p "${ARCHIVE_DIR}"
mv "${MASTER_KEY_FILE}" "${ARCHIVE_DIR}/master-key-${TIMESTAMP}-old.bin"
chmod 600 "${ARCHIVE_DIR}/master-key-${TIMESTAMP}-old.bin"
log_info "Old key archived to ${ARCHIVE_DIR}/master-key-${TIMESTAMP}-old.bin"

# Step 7: Update key file reference
log_section "Step 7: Updating key file reference..."
mv "${NEW_KEY_FILE}" "${MASTER_KEY_FILE}"
chmod 600 "${MASTER_KEY_FILE}"
log_info "Key file reference updated: ${MASTER_KEY_FILE}"

# Step 8: Verify encrypted volume still works
log_section "Step 8: Verifying encrypted volume..."
cryptsetup close "${LABEL}" 2>/dev/null || true
cryptsetup open --type luks2 "${DEVICE}" "${LABEL}" --key-file "${MASTER_KEY_FILE}"
if mountpoint -q "/dev/mapper/${LABEL}" 2>/dev/null; then
    log_info "Encrypted volume is accessible"
else
    log_warn "Volume not mounted - this is expected if not mounted"
fi
cryptsetup close "${LABEL}"

# Step 9: Update crypttab if needed
log_section "Step 9: Checking /etc/crypttab..."
if grep -q "${MASTER_KEY_FILE}" /etc/crypttab 2>/dev/null; then
    log_info "/etc/crypttab already references correct key file"
else
    log_warn "/etc/crypttab may need manual update"
fi

# Step 10: Generate key rotation report
log_section "Key Rotation Complete!"
echo ""
echo -e "${GREEN}Device:           ${DEVICE}${NC}"
echo -e "${GREEN}Old key archived: ${ARCHIVE_DIR}/master-key-${TIMESTAMP}-old.bin${NC}"
echo -e "${GREEN}New key file:     ${MASTER_KEY_FILE}${NC}"
echo -e "${GREEN}Timestamp:        ${TIMESTAMP}${NC}"
echo ""
echo -e "${YELLOW}Verification:${NC}"
echo "  cryptsetup luksDump ${DEVICE}"
echo "  cryptsetup luksOpen --test-passphrase ${DEVICE} --key-file ${MASTER_KEY_FILE}"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "  1. Test decryption on all systems using this key"
echo "  2. Update HSM with new key if using HYOK pattern"
echo "  3. Rotate keys on all encrypted volumes"
echo "  4. Update backup systems"
echo ""
echo -e "${YELLOW}Key Rotation Schedule:${NC}"
echo "  Recommended: Every 90 days"
echo "  Minimum: Every 365 days"
echo ""

# Cleanup old archived keys (older than 1 year)
log_section "Cleaning up old archived keys..."
find "${ARCHIVE_DIR}" -name "master-key-*.bin" -mtime +365 -delete 2>/dev/null || true
log_info "Old archived keys cleaned up"
