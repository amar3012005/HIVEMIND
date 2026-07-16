#!/usr/bin/env bash
# Build the .amr native binding for linux/arm64 (for arm servers). Native build in an arm64 container.
set -euo pipefail
CRATE="${1:-/Users/amar/HMFs/HIVEMIND/mneme/crate/mneme-node}"
OUT="${2:-$(pwd)/core/src/vector/mneme}"
docker run --rm --platform linux/arm64 -v "$CRATE":/build -w /build node:20-bookworm bash -c '
  set -e
  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y -q >/dev/null 2>&1
  . "$HOME/.cargo/env"
  npm install --no-audit --no-fund >/dev/null 2>&1
  npx napi build --release 2>&1 | tail -3
  ls -la *.node
'
