#!/bin/bash
# HIVE-MIND - Secret Scan and Removal Script
# Usage: ./scripts/scan-secrets.sh

set -e

echo "🔍 HIVE-MIND - Secret Scan"
echo "=========================="
echo ""

cd /Users/amar/HIVE-MIND

FOUND_SECRETS=0

# ==========================================
# Scan 1: Groq API Keys
# ==========================================
echo "1️⃣  Scanning for Groq API keys..."
GROQ_MATCHES=$(grep -r "gsk_[a-zA-Z0-9]\{30,\}" --include="*.js" --include="*.json" --include="*.ts" . 2>/dev/null | \
    grep -v node_modules | grep -v ".git" | grep -v ".env" | grep -v "scan-secrets.sh" || true)

if [ ! -z "$GROQ_MATCHES" ]; then
    echo "   ❌ Found Groq API keys:"
    echo "$GROQ_MATCHES" | head -10
    FOUND_SECRETS=1
else
    echo "   ✅ No Groq API keys found"
fi
echo ""

# ==========================================
# Scan 2: Mistral API Keys
# ==========================================
echo "2️⃣  Scanning for Mistral API keys..."
MISTRAL_MATCHES=$(grep -r "k2jqLJXdnnSbq51sysEB4YvtR4LnM7hp\|mistral-[a-zA-Z0-9]\{32,\}" --include="*.js" --include="*.json" --include="*.ts" . 2>/dev/null | \
    grep -v node_modules | grep -v ".git" | grep -v ".env" | grep -v "scan-secrets.sh" || true)

if [ ! -z "$MISTRAL_MATCHES" ]; then
    echo "   ❌ Found Mistral API keys:"
    echo "$MISTRAL_MATCHES" | head -10
    FOUND_SECRETS=1
else
    echo "   ✅ No Mistral API keys found"
fi
echo ""

# ==========================================
# Scan 3: Generic API Keys
# ==========================================
echo "3️⃣  Scanning for generic API keys..."
GENERIC_MATCHES=$(grep -rE "(api_key|apikey|API_KEY|apiKey)\s*[=:]\s*['\"][a-zA-Z0-9_-]{20,}['\"]" --include="*.js" --include="*.json" --include="*.ts" . 2>/dev/null | \
    grep -v node_modules | grep -v ".git" | grep -v ".env" | grep -v "scan-secrets.sh" | grep -v ".example" || true)

if [ ! -z "$GENERIC_MATCHES" ]; then
    echo "   ⚠️  Found potential API key assignments:"
    echo "$GENERIC_MATCHES" | head -10
    echo "   ℹ️  Review these manually"
else
    echo "   ✅ No generic API keys found"
fi
echo ""

# ==========================================
# Scan 4: Database Passwords
# ==========================================
echo "4️⃣  Scanning for database passwords..."
DB_MATCHES=$(grep -rE "postgres://[^:]+:[^@]+@" --include="*.js" --include="*.json" --include="*.ts" . 2>/dev/null | \
    grep -v node_modules | grep -v ".git" | grep -v ".env" | grep -v "scan-secrets.sh" || true)

if [ ! -z "$DB_MATCHES" ]; then
    echo "   ❌ Found database connection strings with passwords:"
    echo "$DB_MATCHES" | head -10
    FOUND_SECRETS=1
else
    echo "   ✅ No database passwords found"
fi
echo ""

# ==========================================
# Summary
# ==========================================
echo "=========================="
echo "📊 Secret Scan Summary"
echo "=========================="
echo ""

if [ $FOUND_SECRETS -eq 1 ]; then
    echo "❌ CRITICAL: Hardcoded secrets found!"
    echo ""
    echo "Next steps:"
    echo "  1. Remove all hardcoded secrets from the files listed above"
    echo "  2. Replace with process.env.VARIABLE_NAME"
    echo "  3. Add to .env.example (without real values)"
    echo "  4. Rotate any exposed credentials immediately"
    echo ""
    exit 1
else
    echo "✅ No hardcoded secrets found in codebase!"
    echo ""
    echo "Your code is clean. Remember to:"
    echo "  - Never commit .env files"
    echo "  - Rotate keys periodically"
    echo "  - Use environment variables in production"
    echo ""
    exit 0
fi
