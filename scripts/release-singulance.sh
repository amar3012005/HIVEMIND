#!/usr/bin/env bash
# Backward-compatible entry point. All releases are implemented by
# release-canonical.sh so every caller shares one lock, source gate, image
# identity policy, deployment path and verifier.
set -euo pipefail

sha="${1:?usage: release-singulance.sh <canonical-sha> [services...]}"
shift || true
services=("${@:-fe}")
canonical=()
for service in "${services[@]}"; do
  case "$service" in
    fe) canonical+=(frontend) ;;
    control) canonical+=(control-plane) ;;
    *) canonical+=("$service") ;;
  esac
done
canonical_csv=$(IFS=,; echo "${canonical[*]}")
exec "$(dirname "$0")/release-canonical.sh" --sha "$sha" --services "$canonical_csv"
