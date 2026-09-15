#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec "$PWD/e2e.sh"
