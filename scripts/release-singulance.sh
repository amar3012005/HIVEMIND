#!/usr/bin/env bash
# Legacy positional interface. All production releases use release-canonical.
set -euo pipefail

SHA="${1:?usage: release-singulance.sh <canonical-sha> [services...]}"
shift || true
if [ $# -eq 0 ]; then
  SERVICES="core,control-plane,employees,frontend"
else
  normalized=()
  for service in "$@"; do
    [ "$service" = fe ] && service=frontend
    [ "$service" = control ] && service=control-plane
    normalized+=("$service")
  done
  SERVICES=$(IFS=,; echo "${normalized[*]}")
fi

exec "$(dirname "$0")/release-canonical.sh" --sha "$SHA" --services "$SERVICES"
