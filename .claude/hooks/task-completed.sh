#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || exit 0)
cd "$ROOT"

if ! git diff --check; then
  echo "git diff --check failed; task is not complete"
  exit 2
fi

if git status --porcelain | grep -qE '(^|/)\.env($|\.)|\.pem$|\.key$'; then
  echo "possible secret file in working tree; inspect before completion"
  exit 2
fi

echo "Completion preflight passed. Tests and acceptance remain task-specific."
