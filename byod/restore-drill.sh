#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRILL="$HERE/storage-restore-drill.sh"
[[ -f "$DRILL" ]] || DRILL="$HERE/../scripts/storage-restore-drill.sh"
[[ -f "$DRILL" ]] || { echo "storage-restore-drill.sh is missing; reinstall the Memory Box bundle" >&2; exit 1; }
exec bash "$DRILL" --mode byod "$@"

