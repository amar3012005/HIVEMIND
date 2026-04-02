#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MB_DIR="$SCRIPT_DIR/memorybench"
EXAMPLE_ENV="$SCRIPT_DIR/.env.memorybench-hivemind.example"
TARGET_ENV="$MB_DIR/.env.local"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required. Install from https://bun.sh/"
  exit 1
fi

if [ ! -d "$MB_DIR" ]; then
  echo "memorybench repo not found at: $MB_DIR"
  exit 1
fi

cd "$MB_DIR"
bun install

if [ ! -f "$TARGET_ENV" ]; then
  cp "$EXAMPLE_ENV" "$TARGET_ENV"
  echo "Created $TARGET_ENV"
else
  echo "$TARGET_ENV already exists (left unchanged)"
fi

echo
echo "Next:"
echo "1) Edit $TARGET_ENV with your keys"
echo "2) Run: $SCRIPT_DIR/run-memorybench-hivemind.sh"

