#!/usr/bin/env bash
# Legacy positional interface. All production releases use release-canonical.
set -euo pipefail

SHA="${1:?usage: release-singulance.sh <canonical-sha> [services...]}"
shift || true
if [ $# -eq 0 ]; then
  SERVICES="core,control-plane,employees"
else
  normalized=()
  for service in "$@"; do
    case "$service" in
      fe|frontend)
        echo "FATAL: frontend is hosted on Cloudflare; deploy it from the Da-vinci repository with Wrangler"
        exit 2
        ;;
    esac
    [ "$service" = control ] && service=control-plane
    normalized+=("$service")
  done
  SERVICES=$(IFS=,; echo "${normalized[*]}")
fi

exec "$(dirname "$0")/release-canonical.sh" --sha "$SHA" --services "$SERVICES"
