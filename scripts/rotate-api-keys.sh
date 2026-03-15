#!/bin/bash
# API Key Rotation Script for HIVE-MIND
# Security Incident Response: Compromised Groq API Key
#
# Usage: ./scripts/rotate-api-keys.sh
#
# This script:
# 1. Scans for compromised key patterns in the codebase
# 2. Replaces compromised keys with placeholders
# 3. Updates .env files with rotation notice
# 4. Generates rotation report
#
# IMPORTANT: This script does NOT generate new API keys
# You must manually generate new keys at the provider's console

set -euo pipefail

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

# Compromised key patterns (DO NOT commit these patterns after rotation)
COMPROMISED_GROQ_KEY="[REDACTED_COMPROMISED_KEY]"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

log_section "HIVE-MIND API Key Rotation"
echo "Date: $(date '+%Y-%m-%d %H:%M:%S')"
echo "Directory: $PROJECT_ROOT"
echo ""

# Step 1: Scan for compromised keys
log_section "Step 1: Scanning for compromised keys..."

FOUND_KEYS=0
declare -a AFFECTED_FILES=()

while IFS= read -r -d '' file; do
    if grep -q "$COMPROMISED_GROQ_KEY" "$file" 2>/dev/null; then
        AFFECTED_FILES+=("$file")
        FOUND_KEYS=$((FOUND_KEYS + 1))
        log_warn "Found compromised key in: $file"
    fi
done < <(find "$PROJECT_ROOT" -type f \( -name "*.md" -o -name "*.txt" -o -name "*.yml" -o -name "*.yaml" -o -name "*.json" -o -name "*.js" -o -name "*.ts" -o -name "*.env" \) -not -path "*/.git/*" -print0)

if [ $FOUND_KEYS -eq 0 ]; then
    log_info "No compromised keys found in codebase"
else
    log_error "Found $FOUND_KEYS file(s) containing compromised key(s)"
fi

# Step 2: Replace compromised keys with placeholders
log_section "Step 2: Replacing compromised keys with placeholders..."

REPLACEMENT_COUNT=0
for file in "${AFFECTED_FILES[@]}"; do
    if [ -f "$file" ]; then
        # Create backup
        cp "$file" "${file}.backup.$(date +%Y%m%d-%H%M%S)"
        
        # Replace the key
        sed -i '' "s/$COMPROMISED_GROQ_KEY/YOUR_NEW_GROQ_KEY_HERE_ROTATE_IMMEDIATELY/g" "$file" 2>/dev/null || \
        sed -i "s/$COMPROMISED_GROQ_KEY/YOUR_NEW_GROQ_KEY_HERE_ROTATE_IMMEDIATELY/g" "$file"
        
        REPLACEMENT_COUNT=$((REPLACEMENT_COUNT + 1))
        log_info "Replaced key in: $file"
    fi
done

log_info "Replaced keys in $REPLACEMENT_COUNT file(s)"

# Step 3: Update .env files with rotation notice
log_section "Step 3: Checking .env files..."

if [ -f "$PROJECT_ROOT/.env" ]; then
    if grep -q "$COMPROMISED_GROQ_KEY" "$PROJECT_ROOT/.env" 2>/dev/null; then
        log_error "CRITICAL: Compromised key found in .env file!"
        log_warn "Please update your .env file with a new key immediately"
    else
        log_info ".env file does not contain compromised key"
    fi
else
    log_info "No .env file found (this is expected - use .env.example as template)"
fi

# Step 4: Generate rotation report
log_section "Step 4: Generating rotation report..."

REPORT_FILE="$PROJECT_ROOT/project_status/key-rotation-report-$(date +%Y%m%d-%H%M%S).json"

cat > "$REPORT_FILE" << EOF
{
  "rotationDate": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "compromisedKey": {
    "type": "Groq API Key",
    "pattern": "[REDACTED_COMPROMISED_KEY]",
    "reason": "Found in git history",
    "severity": "CRITICAL"
  },
  "affectedFiles": $(printf '%s\n' "${AFFECTED_FILES[@]}" | jq -R . | jq -s .),
  "filesUpdated": $REPLACEMENT_COUNT,
  "actionsRequired": [
    "Generate new API key at https://console.groq.com/",
    "Revoke compromised key at Groq console",
    "Update .env file with new key",
    "Test all integrations with new key",
    "Consider scrubbing git history with BFG Repo-Cleaner",
    "Enable secret scanning in CI/CD pipeline"
  ],
  "rotationScript": "scripts/rotate-api-keys.sh",
  "documentation": "project_status/KEY_ROTATION_RECORD.md"
}
EOF

log_info "Rotation report generated: $REPORT_FILE"

# Step 5: Display next steps
log_section "Rotation Script Complete!"

echo ""
echo -e "${YELLOW}Summary:${NC}"
echo "  Files scanned:     $(find "$PROJECT_ROOT" -type f \( -name "*.md" -o -name "*.txt" -o -name "*.yml" \) -not -path "*/.git/*" | wc -l | tr -d ' ')"
echo "  Affected files:    $FOUND_KEYS"
echo "  Keys replaced:     $REPLACEMENT_COUNT"
echo ""
echo -e "${RED}CRITICAL: Next Steps Required${NC}"
echo ""
echo "  1. Generate new Groq API key:"
echo "     https://console.groq.com/"
echo ""
echo "  2. Revoke the compromised key:"
echo "     $COMPROMISED_GROQ_KEY"
echo ""
echo "  3. Update your .env file:"
echo "     cp .env.example .env"
echo "     # Edit .env with your new GROQ_API_KEY"
echo ""
echo "  4. Scrub git history (recommended):"
echo "     bfg --delete-files '.env' --no-blob-protection"
echo "     git push --force --all"
echo ""
echo "  5. Verify no compromised keys remain:"
echo "     grep -r '$COMPROMISED_GROQ_KEY' --exclude-dir=.git ."
echo ""
echo -e "${YELLOW}Documentation:${NC}"
echo "  - Rotation record: project_status/KEY_ROTATION_RECORD.md"
echo "  - Rotation report: $REPORT_FILE"
echo ""
echo -e "${GREEN}Security First! Never commit API keys to git.${NC}"
echo ""
