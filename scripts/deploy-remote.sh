#!/usr/bin/env bash
# Laptop entry point for a canonical server-side release. The laptop never
# builds, copies a working tree, edits Compose, or deploys an unmerged branch.
set -euo pipefail

service="${1:?usage: deploy-remote.sh <service> [canonical-ref]}"
ref="${2:-singulance-main}"
host="${SINGULANCE_SSH:-singulance}"

case "$service" in
  core) canonical_service=core ;;
  control|control-plane) canonical_service=control-plane ;;
  employees|frontend|tara-grok|tara-deepgram) canonical_service="$service" ;;
  *) echo "deploy-remote: unknown service '$service'" >&2; exit 2 ;;
esac

ssh -o ConnectTimeout=25 "$host" bash -s "$ref" "$canonical_service" <<'CANONICAL_REMOTE'
set -euo pipefail
ref="$1"
service="$2"
repo=/root/hivemind-main
remote_url="${SINGULANCE_CANON_REMOTE:-https://github.com/amar3012005/HIVEMIND.git}"

if [[ "$ref" =~ ^[0-9a-fA-F]{40}$ ]]; then
  sha="$ref"
  git -C "$repo" fetch "$remote_url" "$sha" --quiet
else
  branch="${ref#origin/}"
  branch="${branch#github/}"
  sha=$(git ls-remote "$remote_url" "refs/heads/$branch" | awk '{print $1}')
  [ -n "$sha" ] || { echo "deploy-remote: canonical ref '$ref' not found" >&2; exit 1; }
  git -C "$repo" fetch "$remote_url" "$branch" --quiet
fi

canonical_sha=$(git ls-remote "$remote_url" refs/heads/singulance-main | awk '{print $1}')
git -C "$repo" merge-base --is-ancestor "$sha" "$canonical_sha" \
  || { echo "deploy-remote: $sha is not merged into singulance-main" >&2; exit 1; }

runner=$(mktemp /tmp/release-canonical.XXXXXX)
trap 'rm -f "$runner"' EXIT
git -C "$repo" show "$sha:scripts/release-canonical.sh" > "$runner"
chmod +x "$runner"
exec "$runner" --sha "$sha" --services "$service"
CANONICAL_REMOTE
