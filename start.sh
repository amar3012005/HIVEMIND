#!/bin/bash
# HIVE-MIND Quick Start Script

set -e

echo "🧠 HIVE-MIND - Sovereign AI Memory Platform"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed."
    echo "Install from: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ required. Current: $(node -v)"
    exit 1
fi

echo "✓ Node.js $(node -v)"

# Install dependencies
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Start server
echo "🚀 Starting HIVE-MIND server..."
echo ""
node src/server.js
